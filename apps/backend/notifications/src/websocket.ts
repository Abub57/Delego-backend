
import type { Server, IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import {
  createLogger,
  enableSocketKeepAlive,
  WebSocketStallMonitor,
  type WebSocketMonitorConfig,
} from "@delegolabs/utils";
import { getSubscriberClient } from "./redis/client.js";

const SERVICE_NAME = "notifications";
const log = createLogger(SERVICE_NAME, process.env.LOG_LEVEL ?? "info");

/**
 * #30 — This service verifies WebSocket auth tokens with JWT_SECRET. If the env var is
 * left unset in production, falling back to this well-known string lets anyone forge a
 * valid token for any userId, since the "secret" is public (checked into source control).
 */
export const DEFAULT_NOTIFICATIONS_JWT_SECRET = "change-me-in-production";

/**
 * Resolves the effective JWT secret, refusing to start in production on the well-known
 * default. Mirrors the guard in apps/backend/wallet/src/vault.ts (#31) for the same class
 * of risk: a public fallback secret protecting real user data.
 *
 * - Production + unset/default → throws (fail closed; refuses to start).
 * - Non-production + unset/default → warns and falls back to the default (local/dev ergonomics).
 * - Any environment with a real secret configured → returns it unchanged.
 */
export function resolveJwtSecret(
  rawValue: string | undefined = process.env.JWT_SECRET,
  nodeEnv: string | undefined = process.env.NODE_ENV
): string {
  const isDefault = !rawValue || rawValue === DEFAULT_NOTIFICATIONS_JWT_SECRET;

  if (isDefault) {
    if (nodeEnv === "production") {
      throw new Error(
        "JWT_SECRET must be set in production and must not equal the default development value"
      );
    }
    log.warn("Using default notifications JWT_SECRET — set JWT_SECRET before deploying to production");
    return DEFAULT_NOTIFICATIONS_JWT_SECRET;
  }

  return rawValue;
}

const JWT_SECRET = resolveJwtSecret();
const HEARTBEAT_TIMEOUT = 60_000; // 60 seconds

/**
 * Issue #343 — a network drop can silently kill the TCP connection
 * underneath a client's WebSocket without either side ever seeing a
 * `close`/`error` event: the app-level JSON `{type: "ping"}` heartbeat
 * above only catches this if the *client* is still alive enough to send
 * one. This config drives a server-initiated, protocol-level ping/pong
 * check (native WebSocket ping frames) that detects and recycles a
 * genuinely stalled socket within 30 seconds, independent of the client.
 */
const STALL_MONITOR_CONFIG: WebSocketMonitorConfig = {
  heartbeatIntervalMs: 10_000,
  readTimeoutMs: 30_000,
  reconnectBackoffMs: 1_000,
  maxConsecutiveMisses: 3,
};

export interface PushConnection {
  connectionId: string;
  userId: string;
  subscribedTopics: string[];
  connectedAt: string;
  lastHeartbeatAt: string;
  ws: WebSocket;
  heartbeatTimeout?: NodeJS.Timeout;
  stallMonitor?: WebSocketStallMonitor;
}

export interface PushNotificationEvent {
  topic: string;
  type: string;
  payload: Record<string, unknown>;
  publishedAt: string;
}

export interface WebSocketMetrics {
  totalConnections: number;
  authenticatedConnections: number;
  messagesSent: number;
  messagesReceived: number;
  connectionsByUser: Record<string, number>;
}

let messagesSent = 0;
let messagesReceived = 0;

const connections = new Map<string, PushConnection>();
const redisSubscriber = getSubscriberClient();

if (process.env.NODE_ENV !== "test" && process.env.CI !== "true" && process.env.MOCK_REDIS !== "true") {
  redisSubscriber.subscribe("notifications:*", (err: Error | null | undefined) => {
    if (err) {
      log.error("Failed to subscribe to Redis channel", { error: err });
    } else {
      log.info("Subscribed to Redis notifications channel");
    }
  });

  redisSubscriber.on("message", (_channel: string, message: string) => {
    try {
      const event: PushNotificationEvent = JSON.parse(message);
      broadcastToTopic(event.topic, event);
    } catch (err) {
      log.error("Failed to parse Redis message", { error: err });
    }
  });
}

function verifyJwt(token: string): { userId: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === "object" && decoded !== null && "userId" in decoded) {
      return decoded as { userId: string };
    }
    return null;
  } catch {
    return null;
  }
}

function sendMessage(ws: WebSocket, message: unknown) {
  ws.send(JSON.stringify(message));
  messagesSent += 1;
}

function broadcastToTopic(topic: string, event: PushNotificationEvent) {
  for (const conn of connections.values()) {
    if (conn.subscribedTopics.includes(topic)) {
      sendMessage(conn.ws, event);
    }
  }
}

export function broadcastNotificationToUser(
  userId: string,
  event: Omit<PushNotificationEvent, "topic" | "publishedAt"> & Partial<Pick<PushNotificationEvent, "publishedAt">>
): void {
  const notification: PushNotificationEvent = {
    ...event,
    topic: `user:${userId}`,
    publishedAt: event.publishedAt ?? new Date().toISOString(),
  };
  broadcastToTopic(notification.topic, notification);
}

export function getWebSocketMetrics(): WebSocketMetrics {
  const connectionsByUser: Record<string, number> = {};
  for (const connection of connections.values()) {
    connectionsByUser[connection.userId] = (connectionsByUser[connection.userId] ?? 0) + 1;
  }
  return {
    totalConnections: connections.size,
    authenticatedConnections: connections.size,
    messagesSent,
    messagesReceived,
    connectionsByUser,
  };
}

function broadcastPresence(userId: string, online: boolean): void {
  broadcastNotificationToUser(userId, {
    type: "presence",
    payload: { userId, online },
  });
}

function handleConnection(ws: WebSocket, req: IncomingMessage) {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    ws.close(401, "Missing authentication token");
    return;
  }

  const decoded = verifyJwt(token);
  if (!decoded) {
    ws.close(401, "Invalid authentication token");
    return;
  }

  const connectionId = randomUUID();
  const connectedAt = new Date().toISOString();

  const initialTopics = ["user:" + decoded.userId];
  const connection: PushConnection = {
    connectionId,
    userId: decoded.userId,
    subscribedTopics: initialTopics,
    connectedAt,
    lastHeartbeatAt: connectedAt,
    ws,
  };

  connections.set(connectionId, connection);
  broadcastPresence(decoded.userId, true);

  log.info("New WebSocket connection established", {
    connectionId,
    userId: decoded.userId,
  });

  // Issue #343 — TCP keep-alive on the raw socket underneath this
  // connection, so a genuinely dead peer is reported by the OS instead of
  // hanging indefinitely with no close/error event.
  enableSocketKeepAlive(req.socket);

  // Issue #343 — server-initiated protocol-level ping/pong monitoring.
  // Detects a silently stalled connection (no close/error event fired,
  // but nothing is getting through) within 30s and recycles it, instead
  // of relying solely on the client-driven JSON heartbeat below.
  const stallMonitor = new WebSocketStallMonitor(
    ws,
    {
      onStalled: (reason) => {
        log.warn("Stalled WebSocket connection detected, recycling", {
          connectionId,
          userId: decoded.userId,
          reason,
        });
        if (connection.heartbeatTimeout) {
          clearTimeout(connection.heartbeatTimeout);
        }
        connections.delete(connectionId);
        if (![...connections.values()].some((item) => item.userId === decoded.userId)) {
          broadcastPresence(decoded.userId, false);
        }
      },
    },
    STALL_MONITOR_CONFIG
  );
  stallMonitor.start();
  connection.stallMonitor = stallMonitor;

  const resetHeartbeat = () => {
    if (connection.heartbeatTimeout) {
      clearTimeout(connection.heartbeatTimeout);
    }

    connection.lastHeartbeatAt = new Date().toISOString();

    connection.heartbeatTimeout = setTimeout(() => {
      log.warn("WebSocket connection timed out, closing", {
        connectionId,
        userId: decoded.userId,
      });
      ws.close(408, "Heartbeat timeout");
      connections.delete(connectionId);
    }, HEARTBEAT_TIMEOUT);
  };

  resetHeartbeat();

  ws.on("message", (data: import("ws").RawData) => {
    messagesReceived += 1;
    try {
      const message = JSON.parse(data.toString());

      if (message.type === "ping") {
        sendMessage(ws, { type: "pong" });
        resetHeartbeat();
      } else if (message.type === "subscribe") {
        const topics: string[] = message.topics || [];
        const ownTopic = `user:${decoded.userId}`;

        // Only allow subscribing to own user topic
        const allowed: string[] = [];
        const rejected: string[] = [];
        for (const topic of topics) {
          if (topic === ownTopic) {
            allowed.push(topic);
          } else {
            rejected.push(topic);
          }
        }

        if (rejected.length > 0) {
          log.warn("Rejected unauthorized topic subscription", {
            connectionId,
            userId: decoded.userId,
            rejected,
          });
          sendMessage(ws, {
            type: "error",
            message: "Cannot subscribe to other users' topics",
            rejected,
          });
        }

        if (allowed.length > 0) {
          connection.subscribedTopics = [
            ...new Set([...connection.subscribedTopics, ...allowed]),
          ];
        }

        sendMessage(ws, {
          type: "subscribed",
          topics: connection.subscribedTopics,
        });
      } else if (message.type === "unsubscribe") {
        const topics = message.topics || [];
        connection.subscribedTopics = connection.subscribedTopics.filter(
          (t) => !topics.includes(t)
        );
        sendMessage(ws, {
          type: "unsubscribed",
          topics: connection.subscribedTopics,
        });
      }
    } catch (err) {
      log.error("Failed to process WebSocket message", {
        error: err,
        connectionId,
      });
    }
  });

  ws.on("close", () => {
    log.info("WebSocket connection closed", {
      connectionId,
      userId: decoded.userId,
    });
    if (connection.heartbeatTimeout) {
      clearTimeout(connection.heartbeatTimeout);
    }
    connections.delete(connectionId);
    if (![...connections.values()].some((item) => item.userId === decoded.userId)) {
      broadcastPresence(decoded.userId, false);
    }
  });

  ws.on("error", (err: Error) => {
    log.error("WebSocket connection error", {
      error: err,
      connectionId,
      userId: decoded.userId,
    });
  });
}

export function initWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ server });

  wss.on("connection", handleConnection);

  log.info("WebSocket server initialized");

  return wss;
}

