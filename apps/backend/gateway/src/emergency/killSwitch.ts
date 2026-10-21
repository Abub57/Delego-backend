/**
 * Emergency Kill-Switch Broadcast Service Across Gateway Nodes (Issue #375)
 *
 * Instantly invalidates compromised agent sessions or pauses deposit intake / traffic
 * across all gateway instances via Redis Pub/Sub.
 */

import { Redis } from "ioredis";
import { createLogger, type Logger } from "@delegolabs/utils";
import type { EmergencyBroadcastSignal } from "@delegolabs/types";
import { revokeToken, resetTokenBlacklist } from "../auth/tokenBlacklist.js";
import { getRedisClient } from "../rateLimit/redisClient.js";

const log = createLogger("gateway:emergency-killswitch", process.env.LOG_LEVEL ?? "info");

export const EMERGENCY_KILLSWITCH_CHANNEL = "emergency:broadcast:killswitch";

export interface KillSwitchState {
  trafficPaused: boolean;
  pausedAt?: number;
  pausedBy?: string;
  killedSessions: Set<string>;
}

export class EmergencyKillSwitchService {
  private redisSubscriber: Redis | null = null;
  private redisPublisher: Redis | null = null;
  private isSubscribed = false;
  private readonly state: KillSwitchState = {
    trafficPaused: false,
    killedSessions: new Set<string>(),
  };
  private readonly customCacheClearHandlers: Array<() => void | Promise<void>> = [];
  private readonly logger: Logger;

  constructor(options?: {
    subscriberRedis?: Redis;
    publisherRedis?: Redis;
    logger?: Logger;
  }) {
    this.logger = options?.logger ?? log;
    this.redisSubscriber = options?.subscriberRedis ?? null;
    this.redisPublisher = options?.publisherRedis ?? null;
  }

  /**
   * Register custom in-memory cache clear handlers that execute when a signal is received.
   */
  registerCacheClearHandler(handler: () => void | Promise<void>): void {
    this.customCacheClearHandlers.push(handler);
  }

  /**
   * Clears in-memory caches across gateway components.
   */
  async clearInMemoryCaches(signal: EmergencyBroadcastSignal): Promise<void> {
    this.logger.info("Clearing in-memory caches upon emergency broadcast signal", {
      action: signal.action,
      targetId: signal.targetId,
    });

    if (signal.action === "kill_session" && signal.targetId) {
      // Invalidate the session / token locally
      await revokeToken({
        jti: signal.targetId,
        userId: "emergency-killswitch",
        revokedAt: new Date(signal.timestamp).toISOString(),
        reason: "security",
        expiresAt: new Date(signal.timestamp + 24 * 60 * 60 * 1000).toISOString(),
      });
      this.state.killedSessions.add(signal.targetId);
    } else if (signal.action === "pause_all_traffic") {
      this.state.trafficPaused = true;
      this.state.pausedAt = signal.timestamp;
      this.state.pausedBy = signal.signedByAdmin;
      resetTokenBlacklist();
    } else if (signal.action === "resume") {
      this.state.trafficPaused = false;
      this.state.pausedAt = undefined;
      this.state.pausedBy = undefined;
    }

    // Run registered cache clear hooks
    for (const handler of this.customCacheClearHandlers) {
      try {
        await handler();
      } catch (err: any) {
        this.logger.error("Error executing custom cache clear handler", { error: err.message });
      }
    }
  }

  /**
   * Start subscribing to emergency broadcast signals on the Redis Pub/Sub channel.
   */
  async start(): Promise<void> {
    if (this.isSubscribed) return;

    if (!this.redisSubscriber) {
      try {
        this.redisSubscriber = getRedisClient();
      } catch (err: any) {
        this.logger.warn("Could not obtain Redis client for kill-switch subscription", {
          error: err.message,
        });
      }
    }

    if (this.redisSubscriber) {
      try {
        await this.redisSubscriber.subscribe(EMERGENCY_KILLSWITCH_CHANNEL);
        this.redisSubscriber.on("message", async (channel: string, message: string) => {
          if (channel === EMERGENCY_KILLSWITCH_CHANNEL) {
            await this.handleMessage(message);
          }
        });
        this.isSubscribed = true;
        this.logger.info("Emergency kill-switch subscriber started on channel", {
          channel: EMERGENCY_KILLSWITCH_CHANNEL,
        });
      } catch (err: any) {
        this.logger.error("Failed to subscribe to emergency kill-switch channel", {
          error: err.message,
        });
      }
    }
  }

  /**
   * Handles incoming broadcast message from Redis Pub/Sub.
   */
  async handleMessage(message: string): Promise<void> {
    try {
      const signal: EmergencyBroadcastSignal = JSON.parse(message);
      if (!signal || !signal.action || !signal.signedByAdmin) {
        this.logger.warn("Received malformed emergency broadcast signal", { raw: message });
        return;
      }

      this.logger.warn("Emergency broadcast signal received", {
        action: signal.action,
        targetId: signal.targetId,
        signedByAdmin: signal.signedByAdmin,
        timestamp: signal.timestamp,
      });

      await this.clearInMemoryCaches(signal);
    } catch (err: any) {
      this.logger.error("Failed to process emergency broadcast message", { error: err.message });
    }
  }

  /**
   * Broadcast an emergency signal to all gateway nodes.
   */
  async broadcast(signal: EmergencyBroadcastSignal): Promise<void> {
    if (!this.redisPublisher) {
      this.redisPublisher = getRedisClient();
    }

    const payload = JSON.stringify(signal);
    await this.redisPublisher.publish(EMERGENCY_KILLSWITCH_CHANNEL, payload);

    // Apply locally as well
    await this.clearInMemoryCaches(signal);

    this.logger.warn("Emergency broadcast signal published across gateway nodes", {
      action: signal.action,
      targetId: signal.targetId,
      signedByAdmin: signal.signedByAdmin,
    });
  }

  /**
   * Check if traffic is currently paused by kill-switch.
   */
  isTrafficPaused(): boolean {
    return this.state.trafficPaused;
  }

  /**
   * Check if a specific session/token has been killed.
   */
  isSessionKilled(sessionId: string): boolean {
    return this.state.killedSessions.has(sessionId);
  }

  /**
   * Get current state snapshot.
   */
  getState(): KillSwitchState {
    return {
      trafficPaused: this.state.trafficPaused,
      pausedAt: this.state.pausedAt,
      pausedBy: this.state.pausedBy,
      killedSessions: new Set(this.state.killedSessions),
    };
  }

  /**
   * Stop subscription and reset state (useful for cleanup and tests).
   */
  async stop(): Promise<void> {
    if (this.redisSubscriber && this.isSubscribed) {
      try {
        await this.redisSubscriber.unsubscribe(EMERGENCY_KILLSWITCH_CHANNEL);
      } catch {
        // Ignore unsubscribe errors during teardown
      }
      this.isSubscribed = false;
    }
    this.state.trafficPaused = false;
    this.state.pausedAt = undefined;
    this.state.pausedBy = undefined;
    this.state.killedSessions.clear();
  }
}

// Singleton instance
let killSwitchInstance: EmergencyKillSwitchService | null = null;

export function getEmergencyKillSwitchService(): EmergencyKillSwitchService {
  if (!killSwitchInstance) {
    killSwitchInstance = new EmergencyKillSwitchService();
  }
  return killSwitchInstance;
}

export function setEmergencyKillSwitchService(service: EmergencyKillSwitchService | null): void {
  killSwitchInstance = service;
}
