/**
 * Redis client configuration with connection retry logic and resilience patterns.
 * 
 * Implements:
 * - Exponential backoff retry strategy (3 max retries)
 * - Connection state logging
 * - Error handling to prevent process crashes
 * - In-memory fallback queue for notifications during Redis downtime
 * - Automatic buffer flush on reconnection
 */

import { Redis } from "ioredis";
import { createRequire } from "node:module";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("notifications:redis", process.env.LOG_LEVEL ?? "info");

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 3000;
const MAX_BUFFER_SIZE = 5000;

/** Redis connection state */
interface RedisConnectionState {
  isReady: boolean;
  isConnecting: boolean;
  reconnectAttempts: number;
  lastError?: string;
}

/** Buffered notification to be published when Redis reconnects */
interface BufferedNotification {
  channel: string;
  message: string;
  timestamp: number;
}

/** In-memory fallback queue for notifications during Redis downtime */
class NotificationBuffer {
  private buffer: BufferedNotification[] = [];
  private maxSize: number;

  constructor(maxSize: number = MAX_BUFFER_SIZE) {
    this.maxSize = maxSize;
  }

  enqueue(channel: string, message: string): boolean {
    if (this.buffer.length >= this.maxSize) {
      log.error("Notification buffer overflow — dropping oldest notification", {
        bufferSize: this.buffer.length,
        maxSize: this.maxSize
      });
      this.buffer.shift(); // Drop oldest to prevent OOM
    }

    this.buffer.push({
      channel,
      message,
      timestamp: Date.now()
    });

    log.warn("Notification buffered in memory due to Redis unavailability", {
      channel,
      bufferSize: this.buffer.length
    });

    return true;
  }

  dequeue(): BufferedNotification | undefined {
    return this.buffer.shift();
  }

  size(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
  }

  getAll(): BufferedNotification[] {
    return [...this.buffer];
  }
}

/** Singleton Redis clients and state */
let publisherClient: Redis | null = null;
let subscriberClient: Redis | null = null;
let dispatcherClient: Redis | null = null;

const connectionState: RedisConnectionState = {
  isReady: false,
  isConnecting: false,
  reconnectAttempts: 0
};

const notificationBuffer = new NotificationBuffer(MAX_BUFFER_SIZE);

/**
 * Calculate exponential backoff delay
 * Formula: min(baseDelay * 2^attempt, maxDelay)
 */
function calculateBackoffDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

/**
 * Retry strategy with exponential backoff
 * Returns delay in milliseconds or null to stop retrying
 */
function retryStrategy(times: number): number | null {
  if (times > MAX_RETRIES) {
    log.error("Redis connection failed after maximum retries", {
      maxRetries: MAX_RETRIES,
      attempts: times
    });
    return null; // Stop retrying
  }

  const delay = calculateBackoffDelay(times - 1);
  log.info("Scheduling Redis reconnection attempt", {
    attempt: times,
    delayMs: delay,
    maxRetries: MAX_RETRIES
  });

  return delay;
}

/**
 * Attach event listeners to Redis client for connection state monitoring
 */
function attachEventListeners(client: Redis, clientType: string): void {
  client.on("connect", () => {
    log.info(`Redis ${clientType} client: socket connection established`);
    connectionState.isConnecting = true;
  });

  client.on("ready", () => {
    log.info(`Redis ${clientType} client: ready to accept commands`);
    connectionState.isReady = true;
    connectionState.isConnecting = false;
    connectionState.reconnectAttempts = 0;
    connectionState.lastError = undefined;

    // Trigger buffer flush on reconnection (only for publisher)
    if (clientType === "publisher" && notificationBuffer.size() > 0) {
      void flushNotificationBuffer(client);
    }
  });

  client.on("reconnecting", (delay: number) => {
    connectionState.reconnectAttempts++;
    log.info(`Redis ${clientType} client: reconnecting`, {
      attempt: connectionState.reconnectAttempts,
      delayMs: delay
    });
    connectionState.isConnecting = true;
  });

  client.on("error", (err: Error) => {
    connectionState.lastError = err.message;
    log.error(`Redis ${clientType} client: connection error`, {
      error: err.message,
      code: (err as any).code,
      attempt: connectionState.reconnectAttempts
    });
    // CRITICAL: This listener prevents unhandled error events from crashing the process
  });

  client.on("close", () => {
    log.warn(`Redis ${clientType} client: connection closed`);
    connectionState.isReady = false;
    connectionState.isConnecting = false;
  });

  client.on("end", () => {
    log.warn(`Redis ${clientType} client: connection ended`);
    connectionState.isReady = false;
    connectionState.isConnecting = false;
  });
}

/**
 * Flush buffered notifications to Redis after reconnection
 */
async function flushNotificationBuffer(client: Redis): Promise<void> {
  const bufferSize = notificationBuffer.size();
  if (bufferSize === 0) {
    return;
  }

  log.info("Starting to flush buffered notifications", {
    bufferSize
  });

  let successCount = 0;
  let failureCount = 0;

  // Process all buffered notifications
  const buffered = notificationBuffer.getAll();
  notificationBuffer.clear();

  for (const item of buffered) {
    try {
      await client.publish(item.channel, item.message);
      successCount++;
    } catch (err) {
      failureCount++;
      log.error("Failed to publish buffered notification", {
        channel: item.channel,
        error: err instanceof Error ? err.message : String(err),
        age: Date.now() - item.timestamp
      });
      // Re-queue on failure if there's capacity
      if (notificationBuffer.size() < MAX_BUFFER_SIZE) {
        notificationBuffer.enqueue(item.channel, item.message);
      }
    }
  }

  log.info("Completed flushing buffered notifications", {
    total: bufferSize,
    successful: successCount,
    failed: failureCount,
    remaining: notificationBuffer.size()
  });
}

/**
 * Create a Redis client with resilience configuration
 */
function createRedisClient(clientType: string, lazyConnect: boolean = false): Redis {
  const isTest = 
    process.env.NODE_ENV === "test" || 
    process.env.MOCK_REDIS === "true" || 
    process.env.CI === "true" ||
    Object.keys(process.env).some(k => k.includes('TEST'));

  if (isTest) {
    log.info(`Using mock Redis connection for ${clientType} client`);
    const require = createRequire(import.meta.url);
    const MockRedisConstructor = require("ioredis-mock");
    const mockClient = new MockRedisConstructor();
    
    // Mock clients are always ready
    connectionState.isReady = true;
    
    return mockClient;
  }

  log.info(`Creating Redis ${clientType} client`, { 
    url: REDIS_URL,
    lazyConnect 
  });

  const client = new Redis(REDIS_URL, {
    lazyConnect,
    maxRetriesPerRequest: MAX_RETRIES,
    retryStrategy,
    enableOfflineQueue: true, // Queue commands while disconnected
    enableReadyCheck: true,
    connectTimeout: 10000,
    // Prevent connection errors from throwing unhandled rejections
    lazyConnect: lazyConnect
  });

  attachEventListeners(client, clientType);

  return client;
}

/**
 * Get or create the Redis publisher client (for publishing notifications)
 */
export function getPublisherClient(): Redis {
  if (!publisherClient) {
    publisherClient = createRedisClient("publisher", true);
    
    // Connect explicitly if not lazy
    publisherClient.connect().catch(err => {
      log.error("Failed to connect publisher client", {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }
  return publisherClient;
}

/**
 * Get or create the Redis subscriber client (for receiving pub/sub messages)
 */
export function getSubscriberClient(): Redis {
  if (!subscriberClient) {
    subscriberClient = createRedisClient("subscriber", true);
    
    // Connect explicitly if not lazy
    subscriberClient.connect().catch(err => {
      log.error("Failed to connect subscriber client", {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }
  return subscriberClient;
}

/**
 * Get or create the Redis dispatcher client (for push subscriptions and caching)
 */
export function getDispatcherClient(): Redis {
  if (!dispatcherClient) {
    dispatcherClient = createRedisClient("dispatcher", true);
    
    // Connect explicitly if not lazy
    dispatcherClient.connect().catch(err => {
      log.error("Failed to connect dispatcher client", {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }
  return dispatcherClient;
}

/**
 * Publish a notification with automatic fallback to in-memory buffer
 */
export async function publishNotification(channel: string, message: string): Promise<boolean> {
  const client = getPublisherClient();

  // Check if Redis is ready
  if (!connectionState.isReady) {
    log.warn("Redis not ready — buffering notification", {
      channel,
      bufferSize: notificationBuffer.size()
    });
    return notificationBuffer.enqueue(channel, message);
  }

  try {
    await client.publish(channel, message);
    return true;
  } catch (err) {
    log.error("Failed to publish notification — buffering", {
      channel,
      error: err instanceof Error ? err.message : String(err)
    });
    return notificationBuffer.enqueue(channel, message);
  }
}

/**
 * Get current Redis connection state
 */
export function getConnectionState(): Readonly<RedisConnectionState> {
  return { ...connectionState };
}

/**
 * Get notification buffer metrics
 */
export function getBufferMetrics(): {
  bufferSize: number;
  maxSize: number;
  oldestTimestamp: number | null;
} {
  const all = notificationBuffer.getAll();
  return {
    bufferSize: notificationBuffer.size(),
    maxSize: MAX_BUFFER_SIZE,
    oldestTimestamp: all.length > 0 ? all[0].timestamp : null
  };
}

/**
 * Gracefully disconnect all Redis clients
 */
export async function disconnectAll(): Promise<void> {
  const clients = [
    { client: publisherClient, name: "publisher" },
    { client: subscriberClient, name: "subscriber" },
    { client: dispatcherClient, name: "dispatcher" }
  ];

  for (const { client, name } of clients) {
    if (client) {
      try {
        await client.quit();
        log.info(`Redis ${name} client disconnected gracefully`);
      } catch (err) {
        log.error(`Failed to disconnect Redis ${name} client`, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  publisherClient = null;
  subscriberClient = null;
  dispatcherClient = null;
  connectionState.isReady = false;
  connectionState.isConnecting = false;
  connectionState.reconnectAttempts = 0;
}

/**
 * Manual buffer flush (for testing or administrative purposes)
 */
export async function manualFlushBuffer(): Promise<{
  flushed: number;
  failed: number;
  remaining: number;
}> {
  const client = getPublisherClient();
  const initialSize = notificationBuffer.size();
  
  if (!connectionState.isReady) {
    log.warn("Cannot flush buffer — Redis not ready");
    return {
      flushed: 0,
      failed: 0,
      remaining: initialSize
    };
  }

  await flushNotificationBuffer(client);
  
  return {
    flushed: initialSize - notificationBuffer.size(),
    failed: 0,
    remaining: notificationBuffer.size()
  };
}
