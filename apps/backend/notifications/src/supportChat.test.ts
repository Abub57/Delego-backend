/**
 * Tests for Issue #378 — End-to-End Encrypted Customer Support Channel
 *
 * Covers:
 *   - EncryptedMessagePayload validation (shape, hex pubkeys, base64 ciphertext/nonce)
 *   - InMemoryChatLogStore: append, log retrieval, queue/dequeue, nonce dedup
 *   - ChatRelay: JWT verification, session creation, pubkey exchange, message routing,
 *     offline queuing, nonce replay rejection, heartbeat, monitoring helpers
 *   - Integration: full buyer↔merchant conversation over fake WebSockets
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import WebSocket from "ws";
import jwt from "jsonwebtoken";

import {
  ChatRelay,
  InMemoryChatLogStore,
  type ChatSession,
  type ChatLogEntry,
  type EncryptedMessagePayload,
} from "./supportChat.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SECRET = "test-jwt-secret-for-378";

function makeToken(userId: string, role?: "buyer" | "merchant"): string {
  const payload: Record<string, string> = { userId };
  if (role) payload.role = role;
  return jwt.sign(payload, SECRET, { expiresIn: "1h" });
}

/** Build a valid 32-byte pubkey as lowercase hex (64 chars). */
function fakePubkey(seed = "aa"): string {
  return seed.repeat(32).slice(0, 64);
}

/** Build a valid base64-encoded value of a given byte length. */
function fakeBase64(byteLength = 64): string {
  return Buffer.alloc(byteLength).fill(0xab).toString("base64");
}

function makePayload(overrides: Partial<EncryptedMessagePayload> = {}): EncryptedMessagePayload {
  return {
    senderPubkey: fakePubkey("aa"),
    recipientPubkey: fakePubkey("bb"),
    ciphertext: fakeBase64(48),
    nonce: fakeBase64(12),
    ...overrides,
  };
}

/**
 * A minimal fake WebSocket that records sent frames and exposes helpers.
 */
function makeFakeWs(): {
  ws: WebSocket;
  sent: Array<Record<string, unknown>>;
  closed: { code?: number; reason?: string } | null;
} {
  const sent: Array<Record<string, unknown>> = [];
  let closed: { code?: number; reason?: string } | null = null;
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const ws = {
    readyState: WebSocket.OPEN,
    send: vi.fn((raw: string) => {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    }),
    close: vi.fn((code?: number, reason?: string) => {
      closed = { code, reason };
      (ws as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
      for (const cb of listeners.get("close") ?? []) cb();
    }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    }),
  } as unknown as WebSocket;

  return { ws, sent, closed };
}

/** Build a fake IncomingMessage with query params. */
function makeFakeReq(token: string, orderId: string): import("http").IncomingMessage {
  return {
    url: `/support-chat?token=${encodeURIComponent(token)}&orderId=${orderId}`,
    headers: { host: "localhost" },
  } as unknown as import("http").IncomingMessage;
}

// ---------------------------------------------------------------------------
// 1. InMemoryChatLogStore
// ---------------------------------------------------------------------------

describe("InMemoryChatLogStore", () => {
  let store: InMemoryChatLogStore;

  beforeEach(() => {
    store = new InMemoryChatLogStore();
  });

  it("appends a log entry and retrieves it", async () => {
    const entry: ChatLogEntry = {
      seq: 1,
      receivedAt: Date.now(),
      senderPubkey: fakePubkey("aa"),
      recipientPubkey: fakePubkey("bb"),
      ciphertext: fakeBase64(48),
      nonce: fakeBase64(12),
    };
    const ok = await store.append("order-1", entry);
    expect(ok).toBe(true);
    const log = await store.getLog("order-1");
    expect(log).toHaveLength(1);
    expect(log[0].seq).toBe(1);
  });

  it("rejects a duplicate nonce (replay protection)", async () => {
    const entry: ChatLogEntry = {
      seq: 1,
      receivedAt: Date.now(),
      senderPubkey: fakePubkey("aa"),
      recipientPubkey: fakePubkey("bb"),
      ciphertext: fakeBase64(48),
      nonce: fakeBase64(12),
    };
    await store.append("order-1", entry);
    const duplicate = await store.append("order-1", { ...entry, seq: 2 });
    expect(duplicate).toBe(false);
    // Log should still only have 1 entry
    expect(store._logSize("order-1")).toBe(1);
  });

  it("accepts the same nonce in a different order (nonces are order-scoped)", async () => {
    const entry: ChatLogEntry = {
      seq: 1,
      receivedAt: Date.now(),
      senderPubkey: fakePubkey("aa"),
      recipientPubkey: fakePubkey("bb"),
      ciphertext: fakeBase64(48),
      nonce: fakeBase64(12),
    };
    await store.append("order-A", entry);
    const ok = await store.append("order-B", entry); // same nonce, different order
    expect(ok).toBe(true);
  });

  it("returns empty log for unknown orderId", async () => {
    const log = await store.getLog("nonexistent");
    expect(log).toEqual([]);
  });

  it("queues a message for an offline recipient and drains it", async () => {
    const payload = makePayload();
    await store.enqueue("order-1", "user-merchant", payload);
    expect(store._queueSize("order-1", "user-merchant")).toBe(1);

    const drained = await store.drainQueue("order-1", "user-merchant");
    expect(drained).toHaveLength(1);
    expect(drained[0].nonce).toBe(payload.nonce);

    // After draining the queue should be empty
    expect(store._queueSize("order-1", "user-merchant")).toBe(0);
  });

  it("draining an empty queue returns []", async () => {
    const drained = await store.drainQueue("order-X", "user-nobody");
    expect(drained).toEqual([]);
  });

  it("enqueues multiple messages and drains them in FIFO order", async () => {
    const p1 = makePayload({ nonce: fakeBase64(12) });
    const p2 = makePayload({ nonce: Buffer.alloc(12).fill(0x02).toString("base64") });
    await store.enqueue("order-1", "user-buyer", p1);
    await store.enqueue("order-1", "user-buyer", p2);
    const drained = await store.drainQueue("order-1", "user-buyer");
    expect(drained).toHaveLength(2);
    expect(drained[0].nonce).toBe(p1.nonce);
    expect(drained[1].nonce).toBe(p2.nonce);
  });
});

// ---------------------------------------------------------------------------
// 2. ChatRelay — JWT verification
// ---------------------------------------------------------------------------

describe("ChatRelay.verifyToken", () => {
  it("returns null for an invalid token", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    expect(relay.verifyToken("bad-token")).toBeNull();
  });

  it("returns userId and role for a valid buyer token", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    const token = makeToken("user-1", "buyer");
    const result = relay.verifyToken(token);
    expect(result?.userId).toBe("user-1");
    expect(result?.role).toBe("buyer");
  });

  it("returns userId and role for a valid merchant token", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    const token = makeToken("merchant-1", "merchant");
    const result = relay.verifyToken(token);
    expect(result?.userId).toBe("merchant-1");
    expect(result?.role).toBe("merchant");
  });

  it("defaults role to 'buyer' when the claim is absent", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    // makeToken without role arg produces a JWT without a role claim
    const token = makeToken("user-2");
    const result = relay.verifyToken(token);
    expect(result?.role).toBe("buyer");
  });

  it("returns null for an expired token", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    const token = jwt.sign({ userId: "u", role: "buyer" }, SECRET, { expiresIn: -1 });
    expect(relay.verifyToken(token)).toBeNull();
  });

  it("returns null for a token signed with the wrong secret", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    const token = jwt.sign({ userId: "u", role: "buyer" }, "wrong-secret");
    expect(relay.verifyToken(token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. ChatRelay — connection lifecycle
// ---------------------------------------------------------------------------

describe("ChatRelay — connection lifecycle", () => {
  it("closes the connection with 4000 when token is missing", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    const { ws, closed } = makeFakeWs();
    const req = makeFakeReq("", "order-1");
    // Override to remove token
    (req as Record<string, unknown>).url = "/support-chat?orderId=order-1";
    relay.handleConnection(ws, req);
    expect(closed?.code).toBe(4000);
  });

  it("closes the connection with 4000 when orderId is missing", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    const { ws, closed } = makeFakeWs();
    const req = {
      url: `/support-chat?token=${makeToken("u1", "buyer")}`,
      headers: { host: "localhost" },
    } as unknown as import("http").IncomingMessage;
    relay.handleConnection(ws, req);
    expect(closed?.code).toBe(4000);
  });

  it("closes the connection with 4001 for an invalid JWT", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    const { ws, closed } = makeFakeWs();
    const req = makeFakeReq("invalid-token", "order-1");
    relay.handleConnection(ws, req);
    expect(closed?.code).toBe(4001);
  });

  it("sends a 'connected' frame on successful authentication", () => {
    const store = new InMemoryChatLogStore();
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: store });
    const { ws, sent } = makeFakeWs();
    const token = makeToken("buyer-1", "buyer");
    const req = makeFakeReq(token, "order-x");
    relay.handleConnection(ws, req);

    const connectedFrame = sent.find((f) => f.type === "connected");
    expect(connectedFrame).toBeDefined();
    expect(connectedFrame?.orderId).toBe("order-x");
    expect(connectedFrame?.userId).toBe("buyer-1");
    expect(connectedFrame?.role).toBe("buyer");
  });

  it("registers the session with the correct roles", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws } = makeFakeWs();
    relay.handleConnection(ws, makeFakeReq(makeToken("buyer-1", "buyer"), "order-1"));
    const session = relay._getSession("order-1");
    expect(session?.buyerUserId).toBe("buyer-1");
  });

  it("responds to ping with pong", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws, sent } = makeFakeWs();
    relay.handleConnection(ws, makeFakeReq(makeToken("b1", "buyer"), "order-ping"));

    // Simulate a ping message from the client
    const emitter = ws as unknown as { emit: (event: string, data: Buffer) => void };
    emitter.emit("message", Buffer.from(JSON.stringify({ type: "ping" })));

    const pong = sent.find((f) => f.type === "pong");
    expect(pong).toBeDefined();
  });

  it("sends an error for unknown frame types", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws, sent } = makeFakeWs();
    relay.handleConnection(ws, makeFakeReq(makeToken("b1", "buyer"), "order-unk"));

    const emitter = ws as unknown as { emit: (event: string, data: Buffer) => void };
    emitter.emit("message", Buffer.from(JSON.stringify({ type: "unicorn" })));

    const errFrame = sent.find((f) => f.type === "error");
    expect(errFrame?.code).toBe("UNKNOWN_FRAME");
  });
});

// ---------------------------------------------------------------------------
// 4. ChatRelay — public key exchange
// ---------------------------------------------------------------------------

describe("ChatRelay — public key exchange", () => {
  it("sends pubkey_ack after a valid pubkey registration", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws, sent } = makeFakeWs();
    relay.handleConnection(ws, makeFakeReq(makeToken("b1", "buyer"), "order-pk"));

    const emitter = ws as unknown as { emit: (event: string, data: Buffer) => void };
    emitter.emit("message", Buffer.from(JSON.stringify({ type: "pubkey", pubkey: fakePubkey("cc") })));

    expect(sent.some((f) => f.type === "pubkey_ack")).toBe(true);
  });

  it("rejects a pubkey that is not a 64-char hex string", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws, sent } = makeFakeWs();
    relay.handleConnection(ws, makeFakeReq(makeToken("b1", "buyer"), "order-badpk"));

    const emitter = ws as unknown as { emit: (event: string, data: Buffer) => void };
    emitter.emit("message", Buffer.from(JSON.stringify({ type: "pubkey", pubkey: "not-hex" })));

    const errFrame = sent.find((f) => f.type === "error");
    expect(errFrame?.code).toBe("INVALID_PUBKEY");
  });

  it("forwards peer pubkey to the counterpart when both are connected", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws: buyerWs, sent: buyerSent } = makeFakeWs();
    const { ws: merchantWs, sent: merchantSent } = makeFakeWs();

    const orderId = "order-both-online";
    relay.handleConnection(buyerWs, makeFakeReq(makeToken("buyer-1", "buyer"), orderId));
    relay.handleConnection(merchantWs, makeFakeReq(makeToken("merchant-1", "merchant"), orderId));

    const buyerPubkey = fakePubkey("11");
    const merchantPubkey = fakePubkey("22");

    const buyerEmit = buyerWs as unknown as { emit: (e: string, d: Buffer) => void };
    const merchantEmit = merchantWs as unknown as { emit: (e: string, d: Buffer) => void };

    buyerEmit.emit("message", Buffer.from(JSON.stringify({ type: "pubkey", pubkey: buyerPubkey })));
    merchantEmit.emit("message", Buffer.from(JSON.stringify({ type: "pubkey", pubkey: merchantPubkey })));

    // Merchant should have received buyer's pubkey
    const merchantGotBuyerPubkey = merchantSent.some(
      (f) => f.type === "peer_pubkey" && f.pubkey === buyerPubkey
    );
    expect(merchantGotBuyerPubkey).toBe(true);

    // Buyer should have received merchant's pubkey
    const buyerGotMerchantPubkey = buyerSent.some(
      (f) => f.type === "peer_pubkey" && f.pubkey === merchantPubkey
    );
    expect(buyerGotMerchantPubkey).toBe(true);
  });

  it("sends the existing peer pubkey immediately when the second participant connects", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws: buyerWs } = makeFakeWs();
    const orderId = "order-late-join";

    // Buyer connects and registers pubkey
    relay.handleConnection(buyerWs, makeFakeReq(makeToken("buyer-1", "buyer"), orderId));
    const buyerEmit = buyerWs as unknown as { emit: (e: string, d: Buffer) => void };
    const buyerPubkey = fakePubkey("44");
    buyerEmit.emit("message", Buffer.from(JSON.stringify({ type: "pubkey", pubkey: buyerPubkey })));

    // Merchant connects later
    const { ws: merchantWs, sent: merchantSent } = makeFakeWs();
    relay.handleConnection(merchantWs, makeFakeReq(makeToken("merchant-1", "merchant"), orderId));

    // Merchant should receive buyer's pubkey immediately on connect
    const gotPubkey = merchantSent.some(
      (f) => f.type === "peer_pubkey" && f.pubkey === buyerPubkey
    );
    expect(gotPubkey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. ChatRelay — message routing (core E2E relay)
// ---------------------------------------------------------------------------

describe("ChatRelay — message routing", () => {
  it("relays an encrypted message from buyer to merchant", async () => {
    const store = new InMemoryChatLogStore();
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: store });

    const { ws: buyerWs, sent: buyerSent } = makeFakeWs();
    const { ws: merchantWs, sent: merchantSent } = makeFakeWs();
    const orderId = "order-relay";

    relay.handleConnection(buyerWs, makeFakeReq(makeToken("buyer-1", "buyer"), orderId));
    relay.handleConnection(merchantWs, makeFakeReq(makeToken("merchant-1", "merchant"), orderId));

    const buyerPubkey = fakePubkey("aa");
    const buyerEmit = buyerWs as unknown as { emit: (e: string, d: Buffer) => void };

    // Register buyer pubkey first
    buyerEmit.emit("message", Buffer.from(JSON.stringify({ type: "pubkey", pubkey: buyerPubkey })));

    const session = relay._getSession(orderId)!;
    session.buyerPubkey = buyerPubkey;

    const payload = makePayload({ senderPubkey: buyerPubkey });

    // Send the message
    buyerEmit.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "message", payload }))
    );

    // Allow microtasks to flush
    await Promise.resolve();

    // Merchant receives the ciphertext
    const relayed = merchantSent.find((f) => f.type === "message");
    expect(relayed).toBeDefined();
    expect((relayed?.payload as EncryptedMessagePayload)?.ciphertext).toBe(payload.ciphertext);

    // Buyer receives 'delivered' ack
    const ack = buyerSent.find((f) => f.type === "delivered");
    expect(ack).toBeDefined();
    expect(typeof ack?.seq).toBe("number");

    // Log entry was recorded
    expect(store._logSize(orderId)).toBe(1);
  });

  it("rejects a message with a malformed EncryptedMessagePayload", async () => {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws: buyerWs, sent: buyerSent } = makeFakeWs();
    relay.handleConnection(buyerWs, makeFakeReq(makeToken("buyer-1", "buyer"), "order-bad-msg"));

    const emitter = buyerWs as unknown as { emit: (e: string, d: Buffer) => void };
    emitter.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "message", payload: { senderPubkey: "not-valid" } }))
    );

    await Promise.resolve();
    const errFrame = buyerSent.find((f) => f.type === "error");
    expect(errFrame?.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects a message with a mismatched senderPubkey", async () => {
    const store = new InMemoryChatLogStore();
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: store });
    const { ws: buyerWs, sent: buyerSent } = makeFakeWs();
    const orderId = "order-pubkey-mismatch";

    relay.handleConnection(buyerWs, makeFakeReq(makeToken("buyer-1", "buyer"), orderId));

    // Register buyer's pubkey
    const registeredPubkey = fakePubkey("aa");
    const emitter = buyerWs as unknown as { emit: (e: string, d: Buffer) => void };
    emitter.emit("message", Buffer.from(JSON.stringify({ type: "pubkey", pubkey: registeredPubkey })));

    // Send a message with a DIFFERENT senderPubkey
    const wrongPayload = makePayload({ senderPubkey: fakePubkey("ff") });
    emitter.emit("message", Buffer.from(JSON.stringify({ type: "message", payload: wrongPayload })));

    await Promise.resolve();
    const errFrame = buyerSent.find((f) => f.type === "error");
    expect(errFrame?.code).toBe("PUBKEY_MISMATCH");
  });

  it("rejects a replayed nonce", async () => {
    const store = new InMemoryChatLogStore();
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: store });
    const { ws: buyerWs, sent: buyerSent } = makeFakeWs();
    const { ws: merchantWs } = makeFakeWs();
    const orderId = "order-nonce-replay";

    relay.handleConnection(buyerWs, makeFakeReq(makeToken("buyer-1", "buyer"), orderId));
    relay.handleConnection(merchantWs, makeFakeReq(makeToken("merchant-1", "merchant"), orderId));

    const sharedNonce = fakeBase64(12);
    const payload = makePayload({ nonce: sharedNonce });
    const emitter = buyerWs as unknown as { emit: (e: string, d: Buffer) => void };

    emitter.emit("message", Buffer.from(JSON.stringify({ type: "message", payload })));
    await Promise.resolve();

    // Clear sent frames between the two sends
    buyerSent.length = 0;

    emitter.emit("message", Buffer.from(JSON.stringify({ type: "message", payload })));
    await Promise.resolve();

    const errFrame = buyerSent.find((f) => f.type === "error");
    expect(errFrame?.code).toBe("DUPLICATE_NONCE");
    // Log should still only have 1 entry (the first one)
    expect(store._logSize(orderId)).toBe(1);
  });

  it("queues a message when the recipient is offline and delivers on reconnect", async () => {
    const store = new InMemoryChatLogStore();
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: store });

    // Only buyer connects; merchant is offline
    const { ws: buyerWs } = makeFakeWs();
    const orderId = "order-offline";

    relay.handleConnection(buyerWs, makeFakeReq(makeToken("buyer-1", "buyer"), orderId));

    // Create the session with the merchant ID set (simulates prior session)
    const session = relay._getSession(orderId)!;
    session.merchantUserId = "merchant-1";

    const payload = makePayload();
    const emitter = buyerWs as unknown as { emit: (e: string, d: Buffer) => void };
    emitter.emit("message", Buffer.from(JSON.stringify({ type: "message", payload })));
    await Promise.resolve();

    // Message should be queued for the merchant
    expect(store._queueSize(orderId, "merchant-1")).toBe(1);

    // Now merchant reconnects
    const { ws: merchantWs, sent: merchantSent } = makeFakeWs();
    relay.handleConnection(merchantWs, makeFakeReq(makeToken("merchant-1", "merchant"), orderId));
    await Promise.resolve();

    // Merchant should receive the queued message
    const queued = merchantSent.find((f) => f.type === "message");
    expect(queued).toBeDefined();
    expect(store._queueSize(orderId, "merchant-1")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. ChatRelay — monitoring helpers
// ---------------------------------------------------------------------------

describe("ChatRelay — monitoring", () => {
  it("getActiveSessions returns empty array initially", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    expect(relay.getActiveSessions()).toEqual([]);
  });

  it("getActiveSessions shows connected participants", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws: buyerWs } = makeFakeWs();
    const { ws: merchantWs } = makeFakeWs();
    const orderId = "order-mon";

    relay.handleConnection(buyerWs, makeFakeReq(makeToken("buyer-1", "buyer"), orderId));
    relay.handleConnection(merchantWs, makeFakeReq(makeToken("merchant-1", "merchant"), orderId));

    const sessions = relay.getActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].buyerConnected).toBe(true);
    expect(sessions[0].merchantConnected).toBe(true);
  });

  it("removes the session when both sides disconnect", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws: buyerWs } = makeFakeWs();
    const { ws: merchantWs } = makeFakeWs();
    const orderId = "order-disconnect";

    relay.handleConnection(buyerWs, makeFakeReq(makeToken("buyer-1", "buyer"), orderId));
    relay.handleConnection(merchantWs, makeFakeReq(makeToken("merchant-1", "merchant"), orderId));

    // Simulate both sides closing
    const buyerEmit = buyerWs as unknown as { emit: (e: string) => void };
    const merchantEmit = merchantWs as unknown as { emit: (e: string) => void };
    buyerEmit.emit("close");
    merchantEmit.emit("close");

    expect(relay._getSession(orderId)).toBeUndefined();
    expect(relay.getActiveSessions()).toHaveLength(0);
  });

  it("getLog delegates to the store", async () => {
    const store = new InMemoryChatLogStore();
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: store });

    const entry: ChatLogEntry = {
      seq: 1,
      receivedAt: Date.now(),
      senderPubkey: fakePubkey("aa"),
      recipientPubkey: fakePubkey("bb"),
      ciphertext: fakeBase64(48),
      nonce: fakeBase64(12),
    };
    await store.append("order-log", entry);

    const log = await relay.getLog("order-log");
    expect(log).toHaveLength(1);
    expect(log[0].seq).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Envelope validation helpers (internal contract)
// ---------------------------------------------------------------------------

describe("EncryptedMessagePayload validation", () => {
  /** Access the private validator via a white-box test on the relay's message handling. */
  async function sendPayloadAndCapture(
    payload: unknown
  ): Promise<Array<Record<string, unknown>>> {
    const relay = new ChatRelay({ jwtSecret: SECRET, logStore: new InMemoryChatLogStore() });
    const { ws, sent } = makeFakeWs();
    relay.handleConnection(ws, makeFakeReq(makeToken("buyer-1", "buyer"), "order-v"));
    const session = relay._getSession("order-v")!;
    session.merchantUserId = "merchant-1";

    const emitter = ws as unknown as { emit: (e: string, d: Buffer) => void };
    emitter.emit("message", Buffer.from(JSON.stringify({ type: "message", payload })));
    await Promise.resolve();
    return sent;
  }

  it("accepts a valid payload", async () => {
    const sent = await sendPayloadAndCapture(makePayload());
    expect(sent.some((f) => f.type === "delivered")).toBe(true);
    expect(sent.some((f) => f.type === "error")).toBe(false);
  });

  it("rejects when senderPubkey is not 64-char hex", async () => {
    const sent = await sendPayloadAndCapture(makePayload({ senderPubkey: "short" }));
    expect(sent.find((f) => f.type === "error")?.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects when recipientPubkey is not 64-char hex", async () => {
    const sent = await sendPayloadAndCapture(makePayload({ recipientPubkey: "not-hex!" }));
    expect(sent.find((f) => f.type === "error")?.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects when ciphertext is empty", async () => {
    const sent = await sendPayloadAndCapture(makePayload({ ciphertext: "" }));
    expect(sent.find((f) => f.type === "error")?.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects when nonce is missing", async () => {
    const { nonce: _, ...noNonce } = makePayload();
    const sent = await sendPayloadAndCapture(noNonce);
    expect(sent.find((f) => f.type === "error")?.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects when payload is a primitive", async () => {
    const sent = await sendPayloadAndCapture("plaintext-string");
    expect(sent.find((f) => f.type === "error")?.code).toBe("INVALID_PAYLOAD");
  });
});

// ---------------------------------------------------------------------------
// 8. Session management
// ---------------------------------------------------------------------------

describe("ChatRelay — session management", () => {
  it("getOrCreateSession initialises a new session for a buyer", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    const session = relay.getOrCreateSession("order-new", "buyer-1", "buyer");
    expect(session.orderId).toBe("order-new");
    expect(session.buyerUserId).toBe("buyer-1");
    expect(session.merchantUserId).toBe("");
    expect(session.seq).toBe(0);
  });

  it("getOrCreateSession adds the merchant to an existing session", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    relay.getOrCreateSession("order-join", "buyer-1", "buyer");
    const session = relay.getOrCreateSession("order-join", "merchant-1", "merchant");
    expect(session.buyerUserId).toBe("buyer-1");
    expect(session.merchantUserId).toBe("merchant-1");
  });

  it("does not overwrite a buyerUserId that is already set", () => {
    const relay = new ChatRelay({ jwtSecret: SECRET });
    relay.getOrCreateSession("order-ow", "buyer-original", "buyer");
    relay.getOrCreateSession("order-ow", "buyer-impostor", "buyer");
    expect(relay._getSession("order-ow")?.buyerUserId).toBe("buyer-original");
  });
});
