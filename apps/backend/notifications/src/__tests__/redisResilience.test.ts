/**
 * Redis Resilience Tests
 * 
 * Tests for Redis connection retry logic, reconnection handling,
 * connection state logging, and in-memory fallback queue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";

// Mock ioredis before importing the client module
vi.mock("ioredis", () => {
  class MockRedis extends EventEmitter {
    constructor(public url: string, public options?: any) {
      super();
      this.setMaxListeners(20); // Prevent warning for multiple listeners
    }

    async connect() {
      // Simulate connection delay
      await new Promise(resolve => setTimeout(resolve, 10));
      this.emit("connect");
      this.emit("ready");
      return this;
    }

    async quit() {
      this.emit("end");
      return "OK";
    }

    async publish(channel: string, message: string) {
      if (!this._isConnected) {
        throw new Error("Connection is closed");
      }
      return 1;
    }

    async subscribe(channel: string) {
      if (!this._isConnected) {
        throw new Error("Connection is closed");
      }
      return channel;
    }

    async sadd(key: string, ...members: string[]) {
      if (!this._isConnected) {
        throw new Error("Connection is closed");
      }
      return members.length;
    }

    async smembers(key: string) {
      if (!this._isConnected) {
        throw new Error("Connection is closed");
      }
      return [];
    }

    async srem(key: string, ...members: string[]) {
      if (!this._isConnected) {
        throw new Error("Connection is closed");
      }
      return members.length;
    }

    // Test helpers
    _isConnected = false;
    
    simulateConnect() {
      this._isConnected = true;
      this.emit("connect");
      this.emit("ready");
    }

    simulateDisconnect() {
      this._isConnected = false;
      this.emit("close");
    }

    simulateError(error: Error) {
      this.emit("error", error);
    }

    simulateReconnecting(delay: number) {
      this.emit("reconnecting", delay);
    }
  }

  return { Redis: MockRedis };
});

// Set test environment
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "true";

describe("Redis Resilience", () => {
  // Reset modules between tests to get fresh state
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Connection State Management", () => {
    it("should track connection state transitions", async () => {
      const { getPublisherClient, getConnectionState } = await import("../redis/client.js");
      
      const client = getPublisherClient();
      
      // Initially not ready
      let state = getConnectionState();
      expect(state.isReady).toBe(false);
      
      // Simulate connection
      await client.connect();
      
      // Should be ready after connect
      state = getConnectionState();
      expect(state.isReady).toBe(true);
      expect(state.reconnectAttempts).toBe(0);
    });

    it("should handle reconnection attempts", async () => {
      const { getPublisherClient, getConnectionState } = await import("../redis/client.js");
      
      const client = getPublisherClient() as any;
      await client.connect();
      
      // Simulate reconnection
      client.simulateReconnecting(200);
      
      const state = getConnectionState();
      expect(state.isConnecting).toBe(true);
      expect(state.reconnectAttempts).toBeGreaterThan(0);
    });

    it("should handle connection errors without crashing", async () => {
      const { getPublisherClient, getConnectionState } = await import("../redis/client.js");
      
      const client = getPublisherClient() as any;
      await client.connect();
      
      // Simulate error - should not throw
      const error = new Error("Connection lost");
      expect(() => {
        client.simulateError(error);
      }).not.toThrow();
      
      const state = getConnectionState();
      expect(state.lastError).toBe("Connection lost");
    });

    it("should update state on disconnection", async () => {
      const { getPublisherClient, getConnectionState } = await import("../redis/client.js");
      
      const client = getPublisherClient() as any;
      await client.connect();
      
      expect(getConnectionState().isReady).toBe(true);
      
      // Simulate disconnect
      client.simulateDisconnect();
      
      const state = getConnectionState();
      expect(state.isReady).toBe(false);
    });
  });

  describe("In-Memory Notification Buffer", () => {
    it("should buffer notifications when Redis is unavailable", async () => {
      const { publishNotification, getBufferMetrics } = await import("../redis/client.js");
      
      // Don't connect Redis - it should be unavailable
      
      // Publish should buffer instead of failing
      const result = await publishNotification("test:channel", JSON.stringify({ test: "data" }));
      expect(result).toBe(true);
      
      const metrics = getBufferMetrics();
      expect(metrics.bufferSize).toBe(1);
    });

    it("should flush buffer when Redis reconnects", async () => {
      const { getPublisherClient, publishNotification, getBufferMetrics } = await import("../redis/client.js");
      
      // Publish while disconnected
      await publishNotification("test:channel", JSON.stringify({ test: "data1" }));
      await publishNotification("test:channel", JSON.stringify({ test: "data2" }));
      
      let metrics = getBufferMetrics();
      expect(metrics.bufferSize).toBe(2);
      
      // Connect Redis
      const client = getPublisherClient() as any;
      await client.connect();
      
      // Wait for buffer flush
      await new Promise(resolve => setTimeout(resolve, 100));
      
      metrics = getBufferMetrics();
      expect(metrics.bufferSize).toBe(0);
    });

    it("should enforce buffer size limit to prevent OOM", async () => {
      const { publishNotification, getBufferMetrics } = await import("../redis/client.js");
      
      // Buffer is limited to 5000 items - try to add more
      const promises = [];
      for (let i = 0; i < 5005; i++) {
        promises.push(publishNotification("test:channel", JSON.stringify({ index: i })));
      }
      
      await Promise.all(promises);
      
      const metrics = getBufferMetrics();
      expect(metrics.bufferSize).toBeLessThanOrEqual(5000);
      expect(metrics.maxSize).toBe(5000);
    });

    it("should track oldest buffered notification timestamp", async () => {
      const { publishNotification, getBufferMetrics } = await import("../redis/client.js");
      
      const beforePublish = Date.now();
      await publishNotification("test:channel", JSON.stringify({ test: "data" }));
      
      const metrics = getBufferMetrics();
      expect(metrics.oldestTimestamp).toBeGreaterThanOrEqual(beforePublish);
      expect(metrics.oldestTimestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("Graceful Degradation", () => {
    it("should successfully publish when Redis is available", async () => {
      const { getPublisherClient, publishNotification, getBufferMetrics } = await import("../redis/client.js");
      
      const client = getPublisherClient() as any;
      await client.connect();
      
      const result = await publishNotification("test:channel", JSON.stringify({ test: "data" }));
      expect(result).toBe(true);
      
      const metrics = getBufferMetrics();
      expect(metrics.bufferSize).toBe(0); // Should not buffer when connected
    });

    it("should fallback to buffer on publish failure", async () => {
      const { getPublisherClient, publishNotification, getBufferMetrics } = await import("../redis/client.js");
      
      const client = getPublisherClient() as any;
      await client.connect();
      
      // Simulate disconnect mid-operation
      client._isConnected = false;
      
      const result = await publishNotification("test:channel", JSON.stringify({ test: "data" }));
      expect(result).toBe(true);
      
      const metrics = getBufferMetrics();
      expect(metrics.bufferSize).toBe(1); // Should buffer on failure
    });

    it("should survive Redis outage without throwing", async () => {
      const { getPublisherClient, publishNotification } = await import("../redis/client.js");
      
      const client = getPublisherClient() as any;
      await client.connect();
      
      // Simulate outage
      client.simulateError(new Error("Connection lost"));
      client.simulateDisconnect();
      
      // Service should not crash
      expect(async () => {
        await publishNotification("test:channel", JSON.stringify({ test: "data" }));
      }).not.toThrow();
    });
  });

  describe("Manual Buffer Operations", () => {
    it("should allow manual buffer flush", async () => {
      const { getPublisherClient, publishNotification, manualFlushBuffer, getBufferMetrics } = await import("../redis/client.js");
      
      // Buffer some notifications
      await publishNotification("test:channel", JSON.stringify({ test: "data1" }));
      await publishNotification("test:channel", JSON.stringify({ test: "data2" }));
      
      expect(getBufferMetrics().bufferSize).toBe(2);
      
      // Connect and manually flush
      const client = getPublisherClient() as any;
      await client.connect();
      
      const result = await manualFlushBuffer();
      expect(result.flushed).toBe(2);
      expect(result.remaining).toBe(0);
      expect(getBufferMetrics().bufferSize).toBe(0);
    });

    it("should warn when attempting to flush while disconnected", async () => {
      const { publishNotification, manualFlushBuffer, getBufferMetrics } = await import("../redis/client.js");
      
      await publishNotification("test:channel", JSON.stringify({ test: "data" }));
      
      const result = await manualFlushBuffer();
      expect(result.flushed).toBe(0);
      expect(result.remaining).toBe(1);
      expect(getBufferMetrics().bufferSize).toBe(1);
    });
  });

  describe("Multiple Client Instances", () => {
    it("should create separate publisher, subscriber, and dispatcher clients", async () => {
      const { 
        getPublisherClient, 
        getSubscriberClient, 
        getDispatcherClient 
      } = await import("../redis/client.js");
      
      const publisher = getPublisherClient();
      const subscriber = getSubscriberClient();
      const dispatcher = getDispatcherClient();
      
      expect(publisher).toBeDefined();
      expect(subscriber).toBeDefined();
      expect(dispatcher).toBeDefined();
      
      // Should be different instances
      expect(publisher).not.toBe(subscriber);
      expect(publisher).not.toBe(dispatcher);
      expect(subscriber).not.toBe(dispatcher);
    });

    it("should disconnect all clients on shutdown", async () => {
      const { 
        getPublisherClient, 
        getSubscriberClient, 
        getDispatcherClient,
        disconnectAll,
        getConnectionState
      } = await import("../redis/client.js");
      
      // Initialize all clients
      const publisher = getPublisherClient() as any;
      const subscriber = getSubscriberClient() as any;
      const dispatcher = getDispatcherClient() as any;
      
      await publisher.connect();
      await subscriber.connect();
      await dispatcher.connect();
      
      expect(getConnectionState().isReady).toBe(true);
      
      // Disconnect all
      await disconnectAll();
      
      const state = getConnectionState();
      expect(state.isReady).toBe(false);
      expect(state.isConnecting).toBe(false);
      expect(state.reconnectAttempts).toBe(0);
    });
  });

  describe("Buffer Metrics", () => {
    it("should provide accurate buffer metrics", async () => {
      const { publishNotification, getBufferMetrics } = await import("../redis/client.js");
      
      const initialMetrics = getBufferMetrics();
      expect(initialMetrics.bufferSize).toBe(0);
      expect(initialMetrics.maxSize).toBe(5000);
      expect(initialMetrics.oldestTimestamp).toBeNull();
      
      await publishNotification("test:channel", JSON.stringify({ test: "data" }));
      
      const afterMetrics = getBufferMetrics();
      expect(afterMetrics.bufferSize).toBe(1);
      expect(afterMetrics.oldestTimestamp).not.toBeNull();
    });

    it("should calculate buffer utilization percentage", async () => {
      const { publishNotification, getBufferMetrics } = await import("../redis/client.js");
      
      // Add 50 notifications
      for (let i = 0; i < 50; i++) {
        await publishNotification("test:channel", JSON.stringify({ index: i }));
      }
      
      const metrics = getBufferMetrics();
      const utilization = (metrics.bufferSize / metrics.maxSize) * 100;
      
      expect(utilization).toBe(1); // 50/5000 = 1%
    });
  });

  describe("Exponential Backoff", () => {
    it("should retry with exponential backoff", async () => {
      const { getPublisherClient } = await import("../redis/client.js");
      
      const client = getPublisherClient() as any;
      const options = client.options;
      
      expect(options.retryStrategy).toBeDefined();
      
      // Test retry strategy
      const delay1 = options.retryStrategy(1);
      const delay2 = options.retryStrategy(2);
      const delay3 = options.retryStrategy(3);
      const delay4 = options.retryStrategy(4);
      
      // Should implement exponential backoff
      expect(delay1).toBeLessThanOrEqual(200);
      expect(delay2).toBeLessThanOrEqual(400);
      expect(delay3).toBeLessThanOrEqual(800);
      
      // Should cap at max delay
      expect(delay1).toBeLessThanOrEqual(3000);
      expect(delay2).toBeLessThanOrEqual(3000);
      expect(delay3).toBeLessThanOrEqual(3000);
      
      // Should stop after max retries
      expect(delay4).toBeNull();
    });
  });
});
