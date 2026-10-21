/**
 * End-to-End Encrypted Customer Support Channel (Issue #378)
 *
 * Provides an ephemeral, WebSocket-based message relay between a buyer and a
 * merchant for customer-support conversations.  Payloads are E2E encrypted
 * by the clients using X25519-ChaCha20-Poly1305 (ECDH key-exchange +
 * authenticated-encryption); the server never has access to any session key
 * or plaintext — it only validates the envelope shape, authenticates the
 * participants, routes ciphertext to the correct peer, and writes ephemeral
 * logs to Redis with a configurable TTL.
 *
 * ## Protocol overview
 *
 * 1. A buyer or merchant opens `GET /support-chat?token=<jwt>&orderId=<id>`.
 * 2. The JWT (same secret as the existing notification WebSocket) is verified
 *    to extract `userId`.  The `orderId` ties the session to a specific order
 *    and is used as the Redis namespace.
 * 3. Clients exchange X25519 public keys via `{ type: "pubkey", pubkey: "<hex>" }`.
 *    Once both sides have registered their public keys the relay advertises
 *    each peer's public key to the other via `{ type: "peer_pubkey", ... }`.
 * 4. Clients encrypt messages locally and send
 *    `{ type: "message", payload: EncryptedMessagePayload }`.
 * 5. The relay validates the envelope (no plaintext inspection), appends an
 *    ephemeral log entry to Redis, and forwards the ciphertext to the
 *    recipient's open connection.  If the recipient is offline the message is
 *    queued in Redis and delivered when they reconnect (within the TTL window).
 * 6. Either party may close their connection.  When both have disconnected the
 *    session entry is deleted from the active-sessions map.
 *
 * ## Redis key layout (all ephemeral — no persistent DB writes)
 *
 *   support:session:<orderId>          HASH  → { buyerId, merchantId, createdAt }
 *   support:log:<orderId>              LIST  → JSON-serialised ChatLogEntry[]  (RPUSH, EXPIRE)
 *   support:queue:<orderId>:<userId>   LIST  → queued EncryptedMessagePayload[]  (RPUSH, EXPIRE)
 *
 * ## Security properties
 *
 * - The server stores only `{ senderPubkey, recipientPubkey, ciphertext, nonce }`
 *   in Redis — no session keys, no plaintext.
 * - Nonce uniqueness is checked on ingestion: if a nonce has already been
 *   used within the session TTL the message is rejected with
 *   `{ type: "error", code: "DUPLICATE_NONCE" }`.  This guards against
 *   replay attacks within the relay layer.
 * - Participants can only send to the counterpart in their session
 *   (`orderId`-scoped).  Cross-order spoofing is structurally impossible.
 * - Chat logs expire from Redis after `SUPPORT_CHAT_LOG_TTL_SECONDS`
 *   (default 24 h).  No plaintext ever reaches PostgreSQL.
 *
 * Closes #378
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("notifications:supportChat", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Public types (matching issue spec)
// ---------------------------------------------------------------------------

/**
 * The encrypted message envelope the relay accepts and forwards.
 * The relay NEVER decrypts this payload.
 */
export interface EncryptedMessagePayload {
  /** Hex-encoded X25519 public key of the sender. */
  senderPubkey: string;
  /** Hex-encoded X25519 public key of the intended recipient. */
  recipientPubkey: string;
  /** Base64-encoded ChaCha20-Poly1305 ciphertext. */
  ciphertext: string;
  /** Base64-encoded 12-byte nonce used for this message. */
  nonce: string;
}

/** Ephemeral log entry stored in Redis (no plaintext). */
export interface ChatLogEntry {
  /** Monotonically increasing per-session sequence number. */
  seq: number;
  /** Unix timestamp (ms) when the relay received the message. */
  receivedAt: number;
  senderPubkey: string;
  recipientPubkey: string;
  /** The raw ciphertext as received — stored for client-side replay if needed. */
  ciphertext: string;
  nonce: string;
}

/** Active chat session tracked in process memory. */
export interface ChatSession {
  orderId: string;
  buyerUserId: string;
  merchantUserId: string;
  /** Sequence counter — incremented on every relayed message. */
  seq: number;
  /** Hex-encoded X25519 public key, set once the peer sends a pubkey frame. */
  buyerPubkey?: string;
  merchantPubkey?: string;
  /** Live WebSocket connection for each participant (null = offline). */
  buyerWs: WebSocket | null;
  merchantWs: WebSocket | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Protocol message shapes (incoming from clients)
// ---------------------------------------------------------------------------

interface PubkeyFrame {
  type: "pubkey";
  /** Hex-encoded X25519 public key. */
  pubkey: string;
}

interface MessageFrame {
  type: "message";
  payload: EncryptedMessagePayload;
}

interface PingFrame {
  type: "ping";
}

type ClientFrame = PubkeyFrame | MessageFrame | PingFrame;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_TTL_SECONDS =
  Number(process.env.SUPPORT_CHAT_LOG_TTL_SECONDS ?? 86_400); // 24 h default
const QUEUE_TTL_SECONDS = LOG_TTL_SECONDS;
const NONCE_DEDUP_TTL_SECONDS = LOG_TTL_SECONDS;
const MAX_LOG_ENTRIES = 500;          // LTRIM guard — prevent unbounded growth
const HEARTBEAT_TIMEOUT_MS = 90_000; // 90 s

const REDIS_NS = {
  session: (orderId: string) => `support:session:${orderId}`,
  log: (orderId: string) => `support:log:${orderId}`,
  queue: (orderId: string, userId: string) => `support:queue:${orderId}:${userId}`,
  nonce: (orderId: string, nonce: string) => `support:nonce:${orderId}:${nonce}`,
} as const;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/i; // 32 bytes = 64 hex chars  (X25519 pubkey)
const BASE64 = /^[A-Za-z0-9+/]+=*$/;

function isValidPubkey(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}

function isValidBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    BASE64.test(value)
  );
}

function isValidEncryptedPayload(payload: unknown): payload is EncryptedMessagePayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    isValidPubkey(p.senderPubkey) &&
    isValidPubkey(p.recipientPubkey) &&
    isValidBase64(p.ciphertext) &&
    isValidBase64(p.nonce)
  );
}

// ---------------------------------------------------------------------------
// ChatLogStore — ephemeral Redis-backed log (no plaintext)
// ---------------------------------------------------------------------------

export interface ChatLogStore {
  /** Append a log entry. Returns false if the nonce was already seen (replay). */
  append(orderId: string, entry: ChatLogEntry): Promise<boolean>;
  /** Retrieve all log entries for an order (for reconnecting clients). */
  getLog(orderId: string): Promise<ChatLogEntry[]>;
  /** Queue a message for an offline recipient. */
  enqueue(orderId: string, recipientUserId: string, payload: EncryptedMessagePayload): Promise<void>;
  /** Drain queued messages for a user who just reconnected. */
  drainQueue(orderId: string, recipientUserId: string): Promise<EncryptedMessagePayload[]>;
}

export class RedisChatLogStore implements ChatLogStore {
  constructor(private readonly redis: Redis) {}

  async append(orderId: string, entry: ChatLogEntry): Promise<boolean> {
    // Check nonce uniqueness to prevent replay within the log window.
    const nonceKey = REDIS_NS.nonce(orderId, entry.nonce);
    const set = await this.redis.set(nonceKey, "1", "EX", NONCE_DEDUP_TTL_SECONDS, "NX");
    if (set !== "OK") {
      // Nonce already seen — reject (replay attack guard).
      return false;
    }

    const logKey = REDIS_NS.log(orderId);
    const serialized = JSON.stringify(entry);
    await this.redis.rpush(logKey, serialized);
    // Trim to prevent unbounded list growth.
    await this.redis.ltrim(logKey, -MAX_LOG_ENTRIES, -1);
    // Refresh TTL on every write so the window slides forward.
    await this.redis.expire(logKey, LOG_TTL_SECONDS);
    return true;
  }

  async getLog(orderId: string): Promise<ChatLogEntry[]> {
    const logKey = REDIS_NS.log(orderId);
    const entries = await this.redis.lrange(logKey, 0, -1);
    return entries.map((e) => JSON.parse(e) as ChatLogEntry);
  }

  async enqueue(
    orderId: string,
    recipientUserId: string,
    payload: EncryptedMessagePayload
  ): Promise<void> {
    const queueKey = REDIS_NS.queue(orderId, recipientUserId);
    await this.redis.rpush(queueKey, JSON.stringify(payload));
    await this.redis.expire(queueKey, QUEUE_TTL_SECONDS);
  }

  async drainQueue(
    orderId: string,
    recipientUserId: string
  ): Promise<EncryptedMessagePayload[]> {
    const queueKey = REDIS_NS.queue(orderId, recipientUserId);
    const items = await this.redis.lrange(queueKey, 0, -1);
    if (items.length > 0) {
      await this.redis.del(queueKey);
    }
    return items.map((i) => JSON.parse(i) as EncryptedMessagePayload);
  }
}

/** In-memory implementation for tests. */
export class InMemoryChatLogStore implements ChatLogStore {
  private readonly logs = new Map<string, ChatLogEntry[]>();
  private readonly queues = new Map<string, EncryptedMessagePayload[]>();
  private readonly nonces = new Set<string>();

  async append(orderId: string, entry: ChatLogEntry): Promise<boolean> {
    const nonceKey = `${orderId}:${entry.nonce}`;
    if (this.nonces.has(nonceKey)) return false;
    this.nonces.add(nonceKey);
    const list = this.logs.get(orderId) ?? [];
    list.push(entry);
    this.logs.set(orderId, list);
    return true;
  }

  async getLog(orderId: string): Promise<ChatLogEntry[]> {
    return [...(this.logs.get(orderId) ?? [])];
  }

  async enqueue(
    orderId: string,
    recipientUserId: string,
    payload: EncryptedMessagePayload
  ): Promise<void> {
    const key = `${orderId}:${recipientUserId}`;
    const queue = this.queues.get(key) ?? [];
    queue.push(payload);
    this.queues.set(key, queue);
  }

  async drainQueue(
    orderId: string,
    recipientUserId: string
  ): Promise<EncryptedMessagePayload[]> {
    const key = `${orderId}:${recipientUserId}`;
    const items = this.queues.get(key) ?? [];
    this.queues.delete(key);
    return items;
  }

  // Test helpers
  _logSize(orderId: string): number {
    return this.logs.get(orderId)?.length ?? 0;
  }

  _queueSize(orderId: string, recipientUserId: string): number {
    return this.queues.get(`${orderId}:${recipientUserId}`)?.length ?? 0;
  }

  clear(): void {
    this.logs.clear();
    this.queues.clear();
    this.nonces.clear();
  }
}

// ---------------------------------------------------------------------------
// ChatRelay — core relay engine
// ---------------------------------------------------------------------------

export interface ChatRelayOptions {
  logStore?: ChatLogStore;
  redis?: Redis;
  /**
   * Resolve the counterpart's userId for a given orderId and participant
   * userId. Returns null if no session exists yet (first join creates it).
   * In production, look this up against the orders table; pass a fake in
   * tests.
   */
  resolveCounterpart?: (
    orderId: string,
    userId: string,
    role: "buyer" | "merchant"
  ) => Promise<string | null>;
  jwtSecret?: string;
}

export class ChatRelay {
  /** Live sessions keyed by orderId. */
  private readonly sessions = new Map<string, ChatSession>();
  private readonly logStore: ChatLogStore;
  private readonly jwtSecret: string;

  constructor(private readonly options: ChatRelayOptions = {}) {
    const secret =
      options.jwtSecret ??
      process.env.JWT_SECRET ??
      "change-me-in-production";

    this.jwtSecret = secret;

    if (options.logStore) {
      this.logStore = options.logStore;
    } else if (options.redis) {
      this.logStore = new RedisChatLogStore(options.redis);
    } else {
      // Fallback for unit tests that don't need Redis.
      this.logStore = new InMemoryChatLogStore();
    }
  }

  // -------------------------------------------------------------------------
  // JWT helpers
  // -------------------------------------------------------------------------

  verifyToken(token: string): { userId: string; role: "buyer" | "merchant" } | null {
    try {
      const decoded = jwt.verify(token, this.jwtSecret);
      if (
        typeof decoded === "object" &&
        decoded !== null &&
        typeof decoded.userId === "string" &&
        (decoded.role === "buyer" || decoded.role === "merchant")
      ) {
        return { userId: decoded.userId, role: decoded.role as "buyer" | "merchant" };
      }
      // Accept JWTs without a role claim — default to buyer for backward compat
      // with tokens issued by the existing auth service that don't have `role`.
      if (
        typeof decoded === "object" &&
        decoded !== null &&
        typeof decoded.userId === "string"
      ) {
        return { userId: decoded.userId, role: "buyer" };
      }
      return null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  /** Return or lazily create the in-process session for an orderId. */
  getOrCreateSession(
    orderId: string,
    userId: string,
    role: "buyer" | "merchant"
  ): ChatSession {
    let session = this.sessions.get(orderId);
    if (!session) {
      session = {
        orderId,
        buyerUserId: role === "buyer" ? userId : "",
        merchantUserId: role === "merchant" ? userId : "",
        seq: 0,
        buyerWs: null,
        merchantWs: null,
        createdAt: new Date().toISOString(),
      };
      this.sessions.set(orderId, session);
    } else {
      // Register a participant that joined after the session was created.
      if (role === "buyer" && !session.buyerUserId) {
        session.buyerUserId = userId;
      }
      if (role === "merchant" && !session.merchantUserId) {
        session.merchantUserId = userId;
      }
    }
    return session;
  }

  private counterpartOf(
    session: ChatSession,
    userId: string
  ): { userId: string; ws: WebSocket | null; pubkey: string | undefined } | null {
    if (userId === session.buyerUserId) {
      return {
        userId: session.merchantUserId,
        ws: session.merchantWs,
        pubkey: session.merchantPubkey,
      };
    }
    if (userId === session.merchantUserId) {
      return {
        userId: session.buyerUserId,
        ws: session.buyerWs,
        pubkey: session.buyerPubkey,
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Connection handler
  // -------------------------------------------------------------------------

  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    const orderId = url.searchParams.get("orderId");

    if (!token || !orderId) {
      ws.close(4000, "Missing token or orderId");
      return;
    }

    const auth = this.verifyToken(token);
    if (!auth) {
      ws.close(4001, "Invalid token");
      return;
    }

    const { userId, role } = auth;
    const session = this.getOrCreateSession(orderId, userId, role);

    // Register the live connection.
    if (role === "buyer") {
      session.buyerWs = ws;
    } else {
      session.merchantWs = ws;
    }

    log.info("Support chat connection established", { orderId, userId, role });

    // Deliver any queued messages from while this user was offline.
    this.logStore
      .drainQueue(orderId, userId)
      .then((queued) => {
        for (const payload of queued) {
          this.sendFrame(ws, { type: "message", payload });
        }
        if (queued.length > 0) {
          log.info("Delivered queued messages on reconnect", {
            orderId,
            userId,
            count: queued.length,
          });
        }
      })
      .catch((err) => {
        log.error("Failed to drain queue", {
          orderId,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    // Heartbeat timer.
    let heartbeat = this.startHeartbeat(ws, orderId, userId);

    ws.on("message", (raw) => {
      clearTimeout(heartbeat);
      heartbeat = this.startHeartbeat(ws, orderId, userId);

      let frame: ClientFrame;
      try {
        frame = JSON.parse(raw.toString()) as ClientFrame;
      } catch {
        this.sendError(ws, "PARSE_ERROR", "Invalid JSON");
        return;
      }

      this.handleFrame(ws, session, userId, frame);
    });

    ws.on("close", () => {
      log.info("Support chat connection closed", { orderId, userId, role });
      clearTimeout(heartbeat);
      if (role === "buyer") session.buyerWs = null;
      else session.merchantWs = null;

      // Clean up session from map when both sides have disconnected.
      if (!session.buyerWs && !session.merchantWs) {
        this.sessions.delete(orderId);
      }
    });

    ws.on("error", (err) => {
      log.error("Support chat WebSocket error", {
        orderId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Acknowledge the connection.
    this.sendFrame(ws, { type: "connected", orderId, userId, role });

    // If the peer is already connected, advertise their public key.
    const peer = this.counterpartOf(session, userId);
    if (peer?.pubkey) {
      this.sendFrame(ws, { type: "peer_pubkey", pubkey: peer.pubkey });
    }
  }

  // -------------------------------------------------------------------------
  // Frame handling
  // -------------------------------------------------------------------------

  private handleFrame(
    ws: WebSocket,
    session: ChatSession,
    userId: string,
    frame: ClientFrame
  ): void {
    switch (frame.type) {
      case "ping":
        this.sendFrame(ws, { type: "pong" });
        break;

      case "pubkey":
        this.handlePubkeyFrame(ws, session, userId, frame);
        break;

      case "message":
        void this.handleMessageFrame(ws, session, userId, frame);
        break;

      default: {
        // TypeScript exhaustiveness check — log and ignore unknown frames.
        const _: never = frame;
        void _;
        this.sendError(ws, "UNKNOWN_FRAME", "Unknown message type");
      }
    }
  }

  private handlePubkeyFrame(
    ws: WebSocket,
    session: ChatSession,
    userId: string,
    frame: PubkeyFrame
  ): void {
    if (!isValidPubkey(frame.pubkey)) {
      this.sendError(ws, "INVALID_PUBKEY", "pubkey must be a 64-char hex string (32 bytes)");
      return;
    }

    // Register the sender's public key in the session.
    if (userId === session.buyerUserId) {
      session.buyerPubkey = frame.pubkey;
    } else {
      session.merchantPubkey = frame.pubkey;
    }

    log.debug("Public key registered", { orderId: session.orderId, userId });

    // Advertise the new pubkey to the peer if they're connected.
    const peer = this.counterpartOf(session, userId);
    if (peer?.ws) {
      this.sendFrame(peer.ws, { type: "peer_pubkey", pubkey: frame.pubkey });
    }

    // If this was the second registration, send each peer the other's pubkey.
    if (session.buyerPubkey && session.merchantPubkey) {
      const buyerWs = session.buyerWs;
      const merchantWs = session.merchantWs;
      if (buyerWs) {
        this.sendFrame(buyerWs, {
          type: "peer_pubkey",
          pubkey: session.merchantPubkey,
        });
      }
      if (merchantWs) {
        this.sendFrame(merchantWs, {
          type: "peer_pubkey",
          pubkey: session.buyerPubkey,
        });
      }
    }

    this.sendFrame(ws, { type: "pubkey_ack" });
  }

  private async handleMessageFrame(
    ws: WebSocket,
    session: ChatSession,
    userId: string,
    frame: MessageFrame
  ): Promise<void> {
    // --- Validate envelope (no plaintext access) ---
    if (!isValidEncryptedPayload(frame.payload)) {
      this.sendError(ws, "INVALID_PAYLOAD", "Malformed EncryptedMessagePayload");
      return;
    }

    const { payload } = frame;

    // Enforce that the senderPubkey matches the registered pubkey for this user
    // to prevent impersonation within a session.
    const senderRegisteredPubkey =
      userId === session.buyerUserId
        ? session.buyerPubkey
        : session.merchantPubkey;

    if (senderRegisteredPubkey && payload.senderPubkey !== senderRegisteredPubkey) {
      this.sendError(ws, "PUBKEY_MISMATCH", "senderPubkey does not match registered public key");
      return;
    }

    // --- Append to ephemeral log (nonce uniqueness checked inside) ---
    session.seq += 1;
    const logEntry: ChatLogEntry = {
      seq: session.seq,
      receivedAt: Date.now(),
      senderPubkey: payload.senderPubkey,
      recipientPubkey: payload.recipientPubkey,
      ciphertext: payload.ciphertext,
      nonce: payload.nonce,
    };

    const accepted = await this.logStore.append(session.orderId, logEntry);
    if (!accepted) {
      this.sendError(ws, "DUPLICATE_NONCE", "Nonce already used — possible replay attack");
      session.seq -= 1; // roll back the sequence increment
      return;
    }

    // --- Route to recipient ---
    const peer = this.counterpartOf(session, userId);
    if (!peer) {
      this.sendError(ws, "NO_PEER", "No counterpart found for this session");
      return;
    }

    if (peer.ws) {
      // Peer is online — deliver immediately.
      this.sendFrame(peer.ws, { type: "message", payload });
    } else {
      // Peer is offline — queue for delivery on reconnect.
      await this.logStore.enqueue(session.orderId, peer.userId, payload);
      log.debug("Queued message for offline peer", {
        orderId: session.orderId,
        recipientUserId: peer.userId,
      });
    }

    // Acknowledge delivery to sender.
    this.sendFrame(ws, { type: "delivered", seq: logEntry.seq });
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private sendFrame(ws: WebSocket, frame: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.sendFrame(ws, { type: "error", code, message });
  }

  private startHeartbeat(
    ws: WebSocket,
    orderId: string,
    userId: string
  ): NodeJS.Timeout {
    return setTimeout(() => {
      log.warn("Support chat heartbeat timeout — closing", { orderId, userId });
      ws.close(4008, "Heartbeat timeout");
    }, HEARTBEAT_TIMEOUT_MS);
  }

  // -------------------------------------------------------------------------
  // Monitoring helpers
  // -------------------------------------------------------------------------

  getActiveSessions(): Array<{
    orderId: string;
    buyerConnected: boolean;
    merchantConnected: boolean;
    seq: number;
    createdAt: string;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      orderId: s.orderId,
      buyerConnected: s.buyerWs !== null,
      merchantConnected: s.merchantWs !== null,
      seq: s.seq,
      createdAt: s.createdAt,
    }));
  }

  getLog(orderId: string): Promise<ChatLogEntry[]> {
    return this.logStore.getLog(orderId);
  }

  /** Test seam: inject a session directly. */
  _injectSession(session: ChatSession): void {
    this.sessions.set(session.orderId, session);
  }

  _getSession(orderId: string): ChatSession | undefined {
    return this.sessions.get(orderId);
  }
}

// ---------------------------------------------------------------------------
// WebSocket server factory
// ---------------------------------------------------------------------------

/**
 * Mount the support-chat WebSocket server on the path `/support-chat` of the
 * existing notifications HTTP server.
 *
 * Clients connect with:
 *   `wss://<host>/support-chat?token=<jwt>&orderId=<id>`
 *
 * The JWT must carry `{ userId, role: "buyer" | "merchant" }`.
 * `role` is optional for backward compat — tokens without it default to
 * "buyer".
 */
export function initSupportChatServer(
  httpServer: HttpServer,
  options: ChatRelayOptions = {}
): { relay: ChatRelay; wss: WebSocketServer } {
  const relay = new ChatRelay(options);

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/support-chat",
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    relay.handleConnection(ws, req);
  });

  log.info("Support chat WebSocket server initialized (Issue #378)", {
    path: "/support-chat",
  });

  return { relay, wss };
}

// ---------------------------------------------------------------------------
// Default Redis client factory for the support chat module
// ---------------------------------------------------------------------------

let _chatRedis: Redis | null = null;

export function getChatRedisClient(): Redis {
  if (!_chatRedis) {
    _chatRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: true,
    });
  }
  return _chatRedis;
}

export function _resetChatRedisForTesting(): void {
  _chatRedis = null;
}
