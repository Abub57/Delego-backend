/**
 * Unit & Integration tests for Emergency Kill-Switch Broadcast Service (Issue #375)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EmergencyKillSwitchService,
  EMERGENCY_KILLSWITCH_CHANNEL,
  setEmergencyKillSwitchService,
  getEmergencyKillSwitchService,
} from "./killSwitch.js";
import { killSwitchMiddleware } from "../../middleware/killSwitch.js";
import { emergencyBroadcastHandler, emergencyStatusHandler } from "../../routes/admin.js";
import { isTokenRevokedSync } from "../auth/tokenBlacklist.js";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("@delegolabs/utils", async () => {
  const actual = await vi.importActual<typeof import("@delegolabs/utils")>("@delegolabs/utils");
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

vi.mock("../auth/authService.js", () => ({
  verifyToken: vi.fn(),
}));

vi.mock("../auth/tokenBlacklist.js", async () => {
  const actual = await vi.importActual<typeof import("../auth/tokenBlacklist.js")>("../auth/tokenBlacklist.js");
  return {
    ...actual,
    revokeToken: vi.fn().mockImplementation(actual.revokeToken),
  };
});

function createMockReq(body: string, headers: Record<string, string> = {}, url = "/api/v1/orders"): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json", ...headers };
  req.url = url;
  req.socket = { remoteAddress: "127.0.0.1" } as any;
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function createMockRes(): ServerResponse & { statusCode: number; body: string } {
  const res = {
    statusCode: 200,
    body: "",
    writeHead(status: number) {
      this.statusCode = status;
    },
    setHeader() {},
    end(body?: string) {
      if (body !== undefined) this.body = body;
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string };
}

describe("EmergencyKillSwitchService (Issue #375)", () => {
  let subscriberMock: any;
  let publisherMock: any;
  let service: EmergencyKillSwitchService;

  beforeEach(() => {
    const messageListeners = new Set<(channel: string, message: string) => void>();
    subscriberMock = {
      subscribe: vi.fn().mockResolvedValue(1),
      unsubscribe: vi.fn().mockResolvedValue(1),
      on: vi.fn().mockImplementation((event: string, cb: any) => {
        if (event === "message") messageListeners.add(cb);
      }),
      emitMessage: (channel: string, msg: string) => {
        for (const listener of messageListeners) listener(channel, msg);
      },
    };

    publisherMock = {
      publish: vi.fn().mockResolvedValue(1),
    };

    service = new EmergencyKillSwitchService({
      subscriberRedis: subscriberMock,
      publisherRedis: publisherMock,
    });
    setEmergencyKillSwitchService(service);
  });

  afterEach(async () => {
    await service.stop();
    setEmergencyKillSwitchService(null);
  });

  it("subscribes to Redis Pub/Sub channel on start", async () => {
    await service.start();
    expect(subscriberMock.subscribe).toHaveBeenCalledWith(EMERGENCY_KILLSWITCH_CHANNEL);
  });

  it("handles kill_session signal and blacklists target token", async () => {
    await service.start();
    const sessionId = "session_xyz_123";

    subscriberMock.emitMessage(
      EMERGENCY_KILLSWITCH_CHANNEL,
      JSON.stringify({
        action: "kill_session",
        targetId: sessionId,
        signedByAdmin: "admin_1",
        timestamp: Date.now(),
      })
    );

    // Wait a tick for async message processing
    await new Promise((r) => setTimeout(r, 10));

    expect(service.isSessionKilled(sessionId)).toBe(true);
    expect(isTokenRevokedSync(sessionId)).toBe(true);
  });

  it("handles pause_all_traffic and resume signals", async () => {
    await service.start();

    expect(service.isTrafficPaused()).toBe(false);

    subscriberMock.emitMessage(
      EMERGENCY_KILLSWITCH_CHANNEL,
      JSON.stringify({
        action: "pause_all_traffic",
        signedByAdmin: "admin_super",
        timestamp: Date.now(),
      })
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(service.isTrafficPaused()).toBe(true);

    subscriberMock.emitMessage(
      EMERGENCY_KILLSWITCH_CHANNEL,
      JSON.stringify({
        action: "resume",
        signedByAdmin: "admin_super",
        timestamp: Date.now(),
      })
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(service.isTrafficPaused()).toBe(false);
  });

  it("executes registered custom cache clear handlers on signal", async () => {
    const customClear = vi.fn();
    service.registerCacheClearHandler(customClear);

    await service.clearInMemoryCaches({
      action: "pause_all_traffic",
      signedByAdmin: "admin_test",
      timestamp: Date.now(),
    });

    expect(customClear).toHaveBeenCalled();
  });

  it("broadcasts signal to Redis publisher and updates local node", async () => {
    const signal = {
      action: "kill_session" as const,
      targetId: "compromised_token_999",
      signedByAdmin: "admin_sec",
      timestamp: Date.now(),
    };

    await service.broadcast(signal);

    expect(publisherMock.publish).toHaveBeenCalledWith(
      EMERGENCY_KILLSWITCH_CHANNEL,
      JSON.stringify(signal)
    );
    expect(service.isSessionKilled("compromised_token_999")).toBe(true);
  });
});

describe("killSwitchMiddleware (Issue #375)", () => {
  let service: EmergencyKillSwitchService;

  beforeEach(() => {
    service = new EmergencyKillSwitchService();
    setEmergencyKillSwitchService(service);
  });

  afterEach(async () => {
    await service.stop();
    setEmergencyKillSwitchService(null);
  });

  it("allows normal traffic when traffic is not paused", async () => {
    const middleware = killSwitchMiddleware();
    const req = createMockReq("", {}, "/api/v1/orders");
    const res = createMockRes();

    const allowed = await middleware(req, res);
    expect(allowed).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("rejects traffic with 503 when kill-switch is active", async () => {
    await service.clearInMemoryCaches({
      action: "pause_all_traffic",
      signedByAdmin: "admin",
      timestamp: Date.now(),
    });

    const middleware = killSwitchMiddleware();
    const req = createMockReq("", {}, "/api/v1/orders");
    const res = createMockRes();

    const allowed = await middleware(req, res);
    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("allows health check routes even during emergency traffic pause", async () => {
    await service.clearInMemoryCaches({
      action: "pause_all_traffic",
      signedByAdmin: "admin",
      timestamp: Date.now(),
    });

    const middleware = killSwitchMiddleware();
    const req = createMockReq("", {}, "/health");
    const res = createMockRes();

    const allowed = await middleware(req, res);
    expect(allowed).toBe(true);
  });
});

describe("Admin Emergency Endpoints (Issue #375)", () => {
  let service: EmergencyKillSwitchService;

  beforeEach(() => {
    service = new EmergencyKillSwitchService({
      publisherRedis: { publish: vi.fn().mockResolvedValue(1) } as any,
    });
    setEmergencyKillSwitchService(service);
  });

  afterEach(async () => {
    await service.stop();
    setEmergencyKillSwitchService(null);
  });

  it("broadcasts signal via POST /api/v1/admin/emergency/broadcast", async () => {
    const { verifyToken } = await import("../auth/authService.js");
    vi.mocked(verifyToken).mockReturnValue({
      userId: "admin_user_1",
      email: "admin@delego.io",
      roles: ["admin"],
    } as any);

    const req = createMockReq(
      JSON.stringify({
        action: "kill_session",
        targetId: "compromised_session_abc",
      }),
      { authorization: "Bearer valid_admin_token" }
    );
    const res = createMockRes();

    await emergencyBroadcastHandler(req, res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.success).toBe(true);
    expect(body.data.signal.action).toBe("kill_session");
    expect(service.isSessionKilled("compromised_session_abc")).toBe(true);
  });

  it("checks status via GET /api/v1/admin/emergency/status", async () => {
    const { verifyToken } = await import("../auth/authService.js");
    vi.mocked(verifyToken).mockReturnValue({
      userId: "admin_user_1",
      email: "admin@delego.io",
      roles: ["admin"],
    } as any);

    const req = createMockReq("", { authorization: "Bearer valid_admin_token" });
    const res = createMockRes();

    await emergencyStatusHandler(req, res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.trafficPaused).toBe(false);
  });
});
