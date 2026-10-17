/**
 * Tests for Redis Streams event sourcing implementation.
 *
 * Covers:
 *   - Stream creation and configuration
 *   - Event publishing (single and batch)
 *   - Consumer group processing
 *   - Exactly-once semantics with pending entries
 *   - Event replay from any position
 *   - Stream trimming and retention policies
 *   - Consumer group state management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RedisStreamManager, type StreamConfig } from "./streams.js";

// Mock Redis client
class MockRedisClient {
  private readonly streams = new Map<string, Map<string, Record<string, string>>>();
  private readonly consumerGroups = new Map<string, Map<string, any>>();
  private readonly streamInfo = new Map<string, any>();
  private lastTimestamp = 0;
  private lastSequence = 0;

  constructor() {
    this.streams.set("events", new Map());
    this.streamInfo.set("events", {
      "length": 0,
      "first-entry": null,
      "last-entry": null,
    });
  }

  multi() {
    const ops: Array<() => Promise<any>> = [];
    const pipeline = {
      xAdd: (stream: string, id: string, fields: Record<string, string>) => {
        ops.push(() => this.xAdd(stream, id, fields));
        return pipeline;
      },
      exec: async () => {
        const results = [];
        for (const op of ops) {
          results.push(await op());
        }
        return results;
      },
    };
    return pipeline;
  }

  async xAdd(stream: string, id: string, fields: Record<string, string>): Promise<string> {
    if (!this.streams.has(stream)) {
      this.streams.set(stream, new Map());
      this.streamInfo.set(stream, { "length": 0, "first-entry": null, "last-entry": null });
    }

    const streamMap = this.streams.get(stream)!;
    const entryId = fields?.id || (id === "*" ? `${Date.now()}-${this.lastSequence++}` : id);
    streamMap.set(entryId, fields);
    this.streamInfo.get(stream)["length"] = streamMap.size;
    this.streamInfo.get(stream)["last-entry"] = { id: entryId, fields };

    if (streamMap.size === 1) {
      this.streamInfo.get(stream)["first-entry"] = { id: entryId, fields };
    }

    return entryId;
  }

  async xTrim(stream: string, strategy: string, threshold: string): Promise<number> {
    const streamMap = this.streams.get(stream);
    if (!streamMap) return 0;

    if (strategy === "MAXLEN") {
      const maxLength = parseInt(threshold, 10);
      const entries = Array.from(streamMap.entries());
      const toDelete = entries.slice(0, entries.length - maxLength);

      for (const [id] of toDelete) {
        streamMap.delete(id);
      }

      this.streamInfo.get(stream)["length"] = streamMap.size;
      if (streamMap.size > 0) {
        this.streamInfo.get(stream)["first-entry"] = { id: entries[maxLength]?.[0], fields: entries[maxLength]?.[1] };
      }
    }

    return 0;
  }

  async xReadGroup(
    group: string,
    consumer: string,
    options: { streams: [string, string]; count?: number; block?: number }
  ): Promise<any[]> {
    const [streamName, startId] = options.streams;

    if (!this.consumerGroups.has(streamName)) {
      this.consumerGroups.set(streamName, new Map());
    }

    const groups = this.consumerGroups.get(streamName)!;
    if (!groups.has(group)) {
      groups.set(group, {
        consumers: new Map(),
        pending: new Map(),
        entriesRead: 0,
      });
    }

    const groupData = groups.get(group)!;
    if (!groupData.consumers.has(consumer)) {
      groupData.consumers.set(consumer, { name: consumer, pending: 0 });
    }

    const streamMap = this.streams.get(streamName);
    if (!streamMap) return null;

    const messages: any[] = [];
    let count = options.count ?? 10;
    let found = 0;

    for (const [id, fields] of streamMap.entries()) {
      if (startId === ">" || this.shouldDeliver(groupData, id, consumer)) {
        messages.push({
          id,
          fields,
        });
        groupData.pending.set(id, { consumer, count: 0 });
        groupData.consumers.get(consumer)!.pending++;
        groupData.entriesRead++;

        if (++found >= count) break;
      }
    }

    return messages.length > 0 ? [[streamName, messages]] : null;
  }

  private shouldDeliver(groupData: any, id: string, consumer: string): boolean {
    const pending = groupData.pending.get(id);
    if (!pending) return true;
    if (pending.consumer === consumer) return true;
    return false;
  }

  async xAck(stream: string, group: string, ...ids: string[]): Promise<number> {
    if (!this.consumerGroups.has(stream)) return 0;

    const groups = this.consumerGroups.get(stream)!;
    if (!groups.has(group)) return 0;

    const groupData = groups.get(group)!;
    let acked = 0;

    for (const id of ids) {
      if (groupData.pending.has(id)) {
        groupData.pending.delete(id);
        acked++;
      }
    }

    return acked;
  }

  async xPending(stream: string, group: string): Promise<any[]> {
    if (!this.consumerGroups.has(stream)) return ["0"];
    if (!this.consumerGroups.get(stream)!.has(group)) return ["0"];

    const groupData = this.consumerGroups.get(stream)!.get(group)!;
    return [
      groupData.pending.size.toString(),
      "0-0",
      groupData.pending.size > 0 ? Array.from(groupData.pending.keys())[0] : null,
      groupData.pending.size > 0 ? Array.from(groupData.pending.keys())[groupData.pending.size - 1] : null,
    ];
  }

  async xPendingRange(
    stream: string,
    group: string,
    start: string,
    end: string,
    count: number,
    consumer: string
  ): Promise<any[]> {
    if (!this.consumerGroups.has(stream)) return [];
    if (!this.consumerGroups.get(stream)!.has(group)) return [];

    const groupData = this.consumerGroups.get(stream)!.get(group)!;
    const messages: any[] = [];

    for (const [id, data] of groupData.pending.entries()) {
      messages.push([id, data.consumer, 0, data.count]);
      if (messages.length >= count) break;
    }

    return messages;
  }

  async xClaim(
    stream: string,
    group: string,
    consumer: string,
    minIdleTime: number,
    ids: string[]
  ): Promise<any[]> {
    if (!this.consumerGroups.has(stream)) return [];
    if (!this.consumerGroups.get(stream)!.has(group)) return [];

    const groupData = this.consumerGroups.get(stream)!.get(group)!;
    const claimed: any[] = [];

    for (const id of ids) {
      const pending = groupData.pending.get(id);
      if (pending) {
        const oldConsumer = pending.consumer;
        pending.consumer = consumer;
        pending.count = (pending.count || 0) + 1;

        const streamMap = this.streams.get(stream);
        if (streamMap && streamMap.has(id)) {
          claimed.push({ id, fields: streamMap.get(id)! });
        }
      }
    }

    return claimed;
  }

  async xInfoStream(stream: string): Promise<any> {
    if (!this.streamInfo.has(stream)) return null;
    return {
      ...this.streamInfo.get(stream),
      "first-entry": this.streamInfo.get(stream)["first-entry"],
      "last-entry": this.streamInfo.get(stream)["last-entry"],
      "length": this.streamInfo.get(stream)["length"],
      "radix-tree-keys": 1,
      "radix-tree-nodes": 1,
      "groups": this.consumerGroups.has(stream) ? this.consumerGroups.get(stream)!.size : 0,
      "entries-read": this.consumerGroups.has(stream)
        ? Array.from(this.consumerGroups.get(stream)!.values()).reduce((sum, g) => sum + (g.entriesRead || 0), 0)
        : 0,
    };
  }

  async xInfoGroup(stream: string, group?: string): Promise<any> {
    if (!this.consumerGroups.has(stream)) return null;

    const groups = this.consumerGroups.get(stream)!;

    if (group) {
      if (!groups.has(group)) return null;
      const groupData = groups.get(group)!;
      return {
        name: group,
        "consumers": groupData.consumers.size,
        "pending": groupData.pending.size,
        "last-delivered-id": groupData.entriesRead > 0 ? `${groupData.entriesRead - 1}-0` : "0-0",
        "entries-read": groupData.entriesRead,
      };
    }

    return Array.from(groups.keys()).map((name) => ({
      name,
      consumers: groups.get(name)!.consumers.size,
      pending: groups.get(name)!.pending.size,
      "last-delivered-id": groups.get(name)!.entriesRead > 0 ? `${groups.get(name)!.entriesRead - 1}-0` : "0-0",
      "entries-read": groups.get(name)!.entriesRead,
    }));
  }

  async xInfoGroups(stream: string): Promise<any[]> {
    return this.xInfoGroup(stream);
  }

  async xInfoConsumers(stream: string, group: string): Promise<any[]> {
    if (!this.consumerGroups.has(stream)) return [];
    if (!this.consumerGroups.get(stream)!.has(group)) return [];

    const groupData = this.consumerGroups.get(stream)!.get(group)!;
    return Array.from(groupData.consumers.entries()).map(([name, data]) => ({
      name,
      pending: data.pending,
      idle: 0,
      active: Date.now(),
    }));
  }

  async xGroup(operation: string, stream: string, group: string, startId?: string, options?: any): Promise<any> {
    if (operation === "CREATE") {
      if (!this.streams.has(stream)) {
        this.streams.set(stream, new Map());
        this.streamInfo.set(stream, { "length": 0, "first-entry": null, "last-entry": null });
      }
      if (!this.consumerGroups.has(stream)) {
        this.consumerGroups.set(stream, new Map());
      }
      if (!this.consumerGroups.get(stream)!.has(group)) {
        this.consumerGroups.get(stream)!.set(group, {
          consumers: new Map(),
          pending: new Map(),
          entriesRead: 0,
        });
      }
      return "OK";
    }

    if (operation === "DESTROY") {
      if (this.consumerGroups.has(stream)) {
        this.consumerGroups.get(stream)!.delete(group);
      }
      return 1;
    }

    if (operation === "RESET") {
      if (this.consumerGroups.has(stream) && this.consumerGroups.get(stream)!.has(group)) {
        this.consumerGroups.get(stream)!.get(group)!.pending.clear();
        this.consumerGroups.get(stream)!.get(group)!.entriesRead = 0;
      }
      return "OK";
    }

    return null;
  }

  async xLen(stream: string): Promise<string> {
    if (!this.streams.has(stream)) return "0";
    return this.streams.get(stream)!.size.toString();
  }

  async del(key: string): Promise<number> {
    if (this.streams.has(key)) {
      this.streams.delete(key);
    }
    if (this.streamInfo.has(key)) {
      this.streamInfo.delete(key);
    }
    if (this.consumerGroups.has(key)) {
      this.consumerGroups.delete(key);
    }
    return 1;
  }

  async xReadRange(
    stream: string,
    start: string,
    end: string,
    options?: { count?: number }
  ): Promise<any[]> {
    const streamMap = this.streams.get(stream);
    if (!streamMap) return null;

    const messages: any[] = [];
    let count = options?.count ?? 100;
    let found = 0;

    for (const [id, fields] of streamMap.entries()) {
      if (start && start !== "0" && start !== "-" && id < start) {
        continue;
      }
      if (end && end !== "+" && id > end) {
        continue;
      }
      messages.push({ id, fields });
      if (++found >= count) break;
    }

    return messages.length > 0 ? [[stream, messages]] : null;
  }

  async xAddWithMaxLen(
    stream: string,
    id: string,
    fields: Record<string, string>,
    maxLength: number
  ): Promise<string> {
    const result = await this.xAdd(stream, id, fields);
    await this.xTrim(stream, "MAXLEN", maxLength.toString());
    return result;
  }
}

describe("RedisStreamManager", () => {
  let client: MockRedisClient;
  let manager: RedisStreamManager<{ amount: number; currency: string }>;

  beforeEach(() => {
    client = new MockRedisClient();
    manager = new RedisStreamManager<{ amount: number; currency: string }>(
      "events",
      {
        maxLength: 1000,
        trimStrategy: "maxlen",
        retentionMs: 24 * 60 * 60 * 1000,
        consumerGroups: [
          { name: "payment-group", consumers: 2, claimMinIdleMs: 30000 },
          { name: "fraud-group", consumers: 1, claimMinIdleMs: 10000 },
        ],
      },
      client
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Initialization", () => {
    it("should initialize stream and consumer groups", async () => {
      await manager.initialize();

      const info = await client.xInfoStream("events");
      expect(info).not.toBeNull();
      expect(info?.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Publishing Events", () => {
    it("should publish a single event", async () => {
      const id = await manager.publish("payment.created", {
        amount: 100,
        currency: "USD",
      });

      expect(id).toMatch(/^\d+-[a-f0-9]{8}$/);
      expect(await client.xLen("events")).toBe("1");
    });

    it("should publish batch events", async () => {
      const ids = await manager.publishBatch([
        { type: "payment.created", payload: { amount: 100, currency: "USD" } },
        { type: "payment.completed", payload: { amount: 100, currency: "USD" } },
      ]);

      expect(ids).toHaveLength(2);
      expect(await client.xLen("events")).toBe("2");
    });

    it("should trim stream when max length exceeded", async () => {
      const shortManager = new RedisStreamManager("short-stream", {
        maxLength: 3,
        trimStrategy: "maxlen",
        consumerGroups: [{ name: "default", consumers: 1, claimMinIdleMs: 30000 }],
      }, new MockRedisClient());

      await shortManager.initialize();

      await shortManager.publish("type1", { data: "a" });
      await shortManager.publish("type2", { data: "b" });
      await shortManager.publish("type3", { data: "c" });
      await shortManager.publish("type4", { data: "d" });

      const length = await shortManager.getStreamLength();
      expect(length).toBeLessThanOrEqual(3);
    });
  });

  describe("Consumer Group Processing", () => {
    it("should process events with consumer group", async () => {
      await manager.initialize();
      await manager.publish("payment.created", { amount: 100, currency: "USD" });

      let processedCount = 0;
      const handler = async () => {
        processedCount++;
      };

      const result = await manager.processWithConsumerGroup(
        "payment-group",
        "consumer-1",
        handler
      );

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);
    });

    it("never crashes on a corrupted payload — archives it to the poison stream instead (#334)", async () => {
      await manager.initialize();

      // Simulate a message with invalid JSON in its payload field, bypassing
      // the normal publish() path (e.g. a producer bug or bit-flip on the wire).
      await client.xAdd("events", "*", {
        id: "corrupt-1",
        type: "payment.created",
        payload: "{not valid json",
        metadata: "{}",
        timestamp: new Date().toISOString(),
      });

      const handler = vi.fn(async () => {});

      const result = await manager.processWithConsumerGroup(
        "payment-group",
        "consumer-1",
        handler
      );

      expect(result.poisoned).toBe(1);
      expect(result.failed).toBe(0);
      expect(handler).not.toHaveBeenCalled();

      // The corrupted message is archived for manual inspection and
      // acknowledged so it is never redelivered.
      expect(await client.xLen("events:poison")).toBe("1");
      const pending = await client.xPending("events", "payment-group");
      expect(parseInt(pending[0] as string, 10)).toBe(0);
    });

    it("should handle exactly-once with pending entries", async () => {
      await manager.initialize();
      await manager.publish("payment.created", { amount: 100, currency: "USD" });

      let processCount = 0;
      const handler = async () => {
        processCount++;
        throw new Error("Simulated failure");
      };

      try {
        await manager.processWithConsumerGroup(
          "payment-group",
          "consumer-1",
          handler
        );
      } catch {
        // Expected
      }

      // Should retry pending entry on next call
      const handlerSuccess = async () => {
        processCount++;
      };

      await manager.processWithConsumerGroup(
        "payment-group",
        "consumer-1",
        handlerSuccess
      );

      expect(processCount).toBe(2);
    });

    it("should calculate processing metrics correctly", async () => {
      await manager.initialize();

      for (let i = 0; i < 5; i++) {
        await manager.publish("payment.created", { amount: 100, currency: "USD" });
      }

      const handler = async () => {
        // Simulate processing time
        await new Promise((resolve) => setTimeout(resolve, 10));
      };

      const result = await manager.processWithConsumerGroup(
        "payment-group",
        "consumer-1",
        handler
      );

      expect(result.processed).toBe(5);
      expect(result.avgProcessingMs).toBeGreaterThan(0);
    });
  });

  describe("Event Replay", () => {
    it("should replay events from beginning", async () => {
      await manager.initialize();
      await manager.publish("payment.created", { amount: 100, currency: "USD" });
      await manager.publish("payment.completed", { amount: 100, currency: "USD" });

      let replayedCount = 0;
      const handler = async () => {
        replayedCount++;
        return true;
      };

      const count = await manager.replayAll(handler);

      expect(count).toBe(2);
      expect(replayedCount).toBe(2);
    });

    it("should replay events from specific position", async () => {
      await manager.initialize();
      await manager.publish("payment.created", { amount: 100, currency: "USD" });
      const lastId = await manager.publish("payment.completed", { amount: 100, currency: "USD" });

      let replayedCount = 0;
      const handler = async () => {
        replayedCount++;
        return true;
      };

      const count = await manager.replayFrom(lastId, handler);

      expect(count).toBe(1);
    });

    it("should allow replay to be stopped early", async () => {
      await manager.initialize();
      await manager.publish("payment.created", { amount: 100, currency: "USD" });
      await manager.publish("payment.completed", { amount: 100, currency: "USD" });

      let replayedCount = 0;
      const handler = async () => {
        replayedCount++;
        return replayedCount < 2; // Stop after second event
      };

      const count = await manager.replayAll(handler);

      expect(count).toBe(2);
    });
  });

  describe("Consumer Group State", () => {
    it("should get consumer group state", async () => {
      await manager.initialize();

      const state = await manager.getConsumerGroupState("payment-group");

      expect(state.groupName).toBe("payment-group");
      expect(state.stream).toBe("events");
      expect(state.consumers).toBeInstanceOf(Array);
    });

    it("should list all consumer groups", async () => {
      await manager.initialize();

      const groups = await manager.listConsumerGroups();

      expect(groups.length).toBeGreaterThanOrEqual(1);
      expect(groups[0]).toHaveProperty("groupName");
      expect(groups[0]).toHaveProperty("consumers");
    });

    it("should add and remove consumer groups", async () => {
      await manager.initialize();

      await manager.addConsumerGroup("new-group");
      const groups = await manager.listConsumerGroups();
      expect(groups.some((g) => g.groupName === "new-group")).toBe(true);

      await manager.removeConsumerGroup("new-group");
      const groupsAfter = await manager.listConsumerGroups();
      expect(groupsAfter.some((g) => g.groupName === "new-group")).toBe(false);
    });
  });

  describe("Stream Management", () => {
    it("should get stream info", async () => {
      await manager.initialize();
      await manager.publish("payment.created", { amount: 100, currency: "USD" });

      const info = await manager.getStreamInfo();

      expect(info).not.toBeNull();
      expect(info?.length).toBe(1);
    });

    it("should reset consumer group", async () => {
      await manager.initialize();

      await manager.resetConsumerGroup("payment-group");
      const state = await manager.getConsumerGroupState("payment-group");

      expect(state.entriesRead).toBe(0);
    });

    it("should delete stream", async () => {
      await manager.initialize();

      await manager.deleteStream();

      const length = await manager.getStreamLength();
      expect(length).toBe(0);
    });
  });

  describe("Stream Config", () => {
    it("should create manager with default config", () => {
      const defaultManager = new RedisStreamManager<{ data: string }>(
        "default-stream"
      );

      expect(defaultManager).toBeDefined();
    });

    it("should create manager with custom config", () => {
      const customConfig: Partial<StreamConfig> = {
        maxLength: 5000,
        trimStrategy: "maxlen",
        retentionMs: 48 * 60 * 60 * 1000,
        consumerGroups: [
          { name: "custom-group", consumers: 3, claimMinIdleMs: 60000 },
        ],
      };

      const customManager = new RedisStreamManager("custom-stream", customConfig);

      expect(customManager).toBeDefined();
    });
  });
});