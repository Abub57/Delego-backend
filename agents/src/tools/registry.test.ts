/**
 * Unit tests for the upgraded ToolRegistry.
 * Issue #262: Zod validation, permission enforcement, timeouts, and audit log.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  ToolRegistry,
  ToolValidationError,
  ToolPermissionError,
  ToolTimeoutError,
} from "./registry.js";
import type { AgentContext, AgentTool } from "./registry.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const READ_CONTEXT: AgentContext = {
  userId: "user-1",
  walletAddress: "GXYZ",
  spendingLimitRemainingStroops: "0",
};

const PAYMENT_CONTEXT: AgentContext = {
  userId: "user-2",
  walletAddress: "GXYZ",
  delegationId: "del-1",
  spendingLimitRemainingStroops: "100000",
};

function makeEchoTool(
  permission: AgentTool["requiredPermission"] = "read_only"
): AgentTool<{ msg: string }, string> {
  return {
    name: "echo",
    description: "Echoes a message",
    inputSchema: z.object({ msg: z.string() }),
    requiredPermission: permission,
    execute: async (input) => input.msg,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("ToolRegistry.register", () => {
  it("registers a tool and lists it", () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool());
    const tools = registry.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("echo");
    expect(tools[0].requiredPermission).toBe("read_only");
  });

  it("throws when registering duplicate names", () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool());
    expect(() => registry.register(makeEchoTool())).toThrow("already registered");
  });
});

// ---------------------------------------------------------------------------
// Execution — happy path
// ---------------------------------------------------------------------------

describe("ToolRegistry.execute — success", () => {
  it("executes a tool and returns the result", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool());
    const result = await registry.execute("echo", { msg: "hello" }, READ_CONTEXT);
    expect(result).toBe("hello");
  });

  it("records an audit entry on success", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool());
    await registry.execute("echo", { msg: "test" }, READ_CONTEXT);
    const log = registry.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].success).toBe(true);
    expect(log[0].toolName).toBe("echo");
    expect(log[0].output).toBe("test");
    expect(log[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("calls the async audit logger with the entry", async () => {
    const logger = vi.fn().mockResolvedValue(undefined);
    const registry = new ToolRegistry(logger);
    registry.register(makeEchoTool());
    await registry.execute("echo", { msg: "logged" }, READ_CONTEXT);
    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0][0]).toMatchObject({
      toolName: "echo",
      success: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Execution — validation errors
// ---------------------------------------------------------------------------

describe("ToolRegistry.execute — Zod validation", () => {
  it("throws ToolValidationError when required field is missing", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool());
    await expect(registry.execute("echo", {}, READ_CONTEXT)).rejects.toBeInstanceOf(
      ToolValidationError
    );
  });

  it("throws ToolValidationError when field type is wrong", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool());
    await expect(
      registry.execute("echo", { msg: 42 }, READ_CONTEXT)
    ).rejects.toBeInstanceOf(ToolValidationError);
  });

  it("records a failure audit entry on validation error", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool());
    await registry.execute("echo", {}, READ_CONTEXT).catch(() => {});
    const log = registry.getAuditLog();
    expect(log[0].success).toBe(false);
    expect(log[0].error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Execution — permission errors
// ---------------------------------------------------------------------------

describe("ToolRegistry.execute — permissions", () => {
  it("allows read_only tool with a context that has no delegation", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool("read_only"));
    const result = await registry.execute("echo", { msg: "ok" }, READ_CONTEXT);
    expect(result).toBe("ok");
  });

  it("throws ToolPermissionError for execute_payment tool without delegation", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool("execute_payment"));
    await expect(
      registry.execute("echo", { msg: "fail" }, READ_CONTEXT)
    ).rejects.toBeInstanceOf(ToolPermissionError);
  });

  it("allows execute_payment tool when context has delegation and balance", async () => {
    const registry = new ToolRegistry();
    registry.register(makeEchoTool("execute_payment"));
    const result = await registry.execute("echo", { msg: "paid" }, PAYMENT_CONTEXT);
    expect(result).toBe("paid");
  });
});

// ---------------------------------------------------------------------------
// Execution — timeouts
// ---------------------------------------------------------------------------

describe("ToolRegistry.execute — timeout", () => {
  it("throws ToolTimeoutError when tool exceeds timeout", async () => {
    vi.useFakeTimers();

    const slowTool: AgentTool<Record<string, never>, void> = {
      name: "slow",
      description: "Never resolves quickly",
      inputSchema: z.object({}),
      requiredPermission: "read_only",
      execute: () => new Promise(() => {}), // never resolves
    };

    const registry = new ToolRegistry();
    registry.register(slowTool);

    const promise = registry.execute("slow", {}, READ_CONTEXT);
    // Advance past the 10-second timeout
    vi.advanceTimersByTime(11_000);

    await expect(promise).rejects.toBeInstanceOf(ToolTimeoutError);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Unknown tool
// ---------------------------------------------------------------------------

describe("ToolRegistry.execute — unknown tool", () => {
  it("throws when tool name is not registered", async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute("nonexistent", {}, READ_CONTEXT)).rejects.toThrow(
      "Unknown tool"
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #533 — pre-execution spend-velocity guard
// ---------------------------------------------------------------------------

describe("ToolRegistry.execute — pre-execution guard", () => {
  it("runs the guard before executing the tool", async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry(
      undefined,
      undefined,
      (toolName) => {
        calls.push(`guard:${toolName}`);
      }
    );
    registry.register(makeEchoTool("read_only"));

    await registry.execute("echo", { msg: "ok" }, READ_CONTEXT);
    expect(calls).toEqual(["guard:echo"]);
  });

  it("aborts execution when the guard throws", async () => {
    const execute = vi.fn(async () => "should-not-run");
    const tool: AgentTool<{ msg: string }, string> = {
      name: "pay",
      description: "pays",
      inputSchema: z.object({ msg: z.string() }),
      requiredPermission: "read_only",
      execute,
    };
    const registry = new ToolRegistry(undefined, undefined, () => {
      throw new Error("Spend velocity exceeded");
    });
    registry.register(tool);

    await expect(
      registry.execute("pay", { msg: "ok" }, READ_CONTEXT)
    ).rejects.toThrow("Spend velocity exceeded");
    expect(execute).not.toHaveBeenCalled();
  });

  it("records the guard failure in the audit log", async () => {
    const registry = new ToolRegistry(undefined, undefined, () => {
      throw new Error("velocity");
    });
    registry.register(makeEchoTool("read_only"));

    await expect(registry.execute("echo", { msg: "ok" }, READ_CONTEXT)).rejects.toThrow();
    const log = registry.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].success).toBe(false);
    expect(log[0].error).toMatch(/velocity/);
  });
});
