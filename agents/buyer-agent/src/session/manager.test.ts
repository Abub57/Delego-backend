/**
 * Session Manager tests — Issue #268
 */
import { describe, it, expect, vi } from "vitest";
import { SessionManager, SessionNotFoundError } from "./manager.js";
import type { AgentSessionState, LLMMessage } from "./types.js";

// ── mock Redis ────────────────────────────────────────────────────────────────

function makeRedis(initialData: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initialData };
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store[key] = value;
      return "OK" as const;
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const k of keys) delete store[k];
      return keys.length;
    }),
    _store: store,
  };
}

function makeState(overrides: Partial<AgentSessionState> = {}): AgentSessionState {
  return {
    sessionId: "s1",
    userId: "u1",
    agentId: "a1",
    messages: [],
    lastActiveAt: Date.now(),
    totalTokensConsumed: 0,
    ...overrides,
  };
}

// ── createSession ─────────────────────────────────────────────────────────────

describe("SessionManager.createSession", () => {
  it("returns a session with a unique sessionId", async () => {
    const redis = makeRedis();
    const mgr = new SessionManager(redis as any);
    const session = await mgr.createSession({ userId: "u1", agentId: "a1" });

    expect(session.sessionId).toBeDefined();
    expect(session.userId).toBe("u1");
    expect(session.messages).toHaveLength(0);
  });

  it("includes the system message when systemPrompt is provided", async () => {
    const redis = makeRedis();
    const mgr = new SessionManager(redis as any);
    const session = await mgr.createSession({
      userId: "u1",
      agentId: "a1",
      systemPrompt: "You are a buyer agent.",
    });

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("system");
    expect(session.messages[0].content).toBe("You are a buyer agent.");
  });

  it("persists to Redis with a 24-hour TTL", async () => {
    const redis = makeRedis();
    const mgr = new SessionManager(redis as any);
    await mgr.createSession({ userId: "u1", agentId: "a1" });

    const setCall = (redis.set as any).mock.calls[0];
    expect(setCall[2]).toBe("EX");
    expect(setCall[3]).toBe(86400); // 24 * 60 * 60
  });
});

// ── getSession ────────────────────────────────────────────────────────────────

describe("SessionManager.getSession", () => {
  it("returns null for non-existent session", async () => {
    const redis = makeRedis();
    const mgr = new SessionManager(redis as any);
    const result = await mgr.getSession("no-such-id");
    expect(result).toBeNull();
  });

  it("returns parsed session for existing key", async () => {
    const state = makeState();
    const redis = makeRedis({
      [`agent:session:${state.sessionId}`]: JSON.stringify(state),
    });
    const mgr = new SessionManager(redis as any);
    const result = await mgr.getSession(state.sessionId);
    expect(result?.sessionId).toBe("s1");
  });

  it("evicts corrupt data and returns null", async () => {
    const redis = makeRedis({ "agent:session:bad": "{not-json" });
    const mgr = new SessionManager(redis as any);
    const result = await mgr.getSession("bad");
    expect(result).toBeNull();
    expect(redis.del).toHaveBeenCalled();
  });
});

// ── appendMessage ─────────────────────────────────────────────────────────────

describe("SessionManager.appendMessage", () => {
  it("appends a message and saves the session", async () => {
    const state = makeState();
    const redis = makeRedis({
      [`agent:session:s1`]: JSON.stringify(state),
    });
    const mgr = new SessionManager(redis as any);

    const updated = await mgr.appendMessage({
      sessionId: "s1",
      message: { role: "user", content: "Find me some shoes" },
    });

    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0].content).toBe("Find me some shoes");
  });

  it("throws SessionNotFoundError for missing session", async () => {
    const redis = makeRedis();
    const mgr = new SessionManager(redis as any);

    await expect(
      mgr.appendMessage({
        sessionId: "gone",
        message: { role: "user", content: "hello" },
      })
    ).rejects.toThrow(SessionNotFoundError);
  });

  it("slides the TTL on each append", async () => {
    const state = makeState();
    const redis = makeRedis({ "agent:session:s1": JSON.stringify(state) });
    const mgr = new SessionManager(redis as any);

    await mgr.appendMessage({
      sessionId: "s1",
      message: { role: "user", content: "hello" },
    });

    const setCall = (redis.set as any).mock.calls.at(-1);
    expect(setCall[2]).toBe("EX");
    expect(setCall[3]).toBe(86400);
  });
});

// ── applyWindowingPolicy ──────────────────────────────────────────────────────

describe("SessionManager.applyWindowingPolicy", () => {
  it("preserves system messages when windowing", () => {
    const mgr = new SessionManager({} as any, 100); // very small token budget

    const systemMsg: LLMMessage = { role: "system", content: "System prompt." };
    // Add enough user/assistant messages to exceed 100 tokens
    const userMsgs: LLMMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "A".repeat(30), // 30 chars ≈ 7.5 tokens each
    }));

    const state = makeState({ messages: [systemMsg, ...userMsgs] });
    const result = mgr.applyWindowingPolicy(state);

    // System message must always survive
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("System prompt.");
  });

  it("does not trim messages when within token budget", () => {
    const mgr = new SessionManager({} as any, 10_000);
    const messages: LLMMessage[] = [
      { role: "system", content: "You are a buyer agent." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi, how can I help?" },
    ];
    const state = makeState({ messages });
    const result = mgr.applyWindowingPolicy(state);
    expect(result.messages).toHaveLength(3);
  });

  it("drops oldest user/assistant turns first", () => {
    const mgr = new SessionManager({} as any, 60); // tight budget
    const messages: LLMMessage[] = [
      { role: "system", content: "S" }, // preserved
      { role: "user", content: "First user message — old" }, // should be dropped first
      { role: "assistant", content: "First assistant response" },
      { role: "user", content: "Recent user message" }, // kept if budget allows
    ];
    const state = makeState({ messages });
    const result = mgr.applyWindowingPolicy(state);

    const nonSystem = result.messages.filter((m) => m.role !== "system");
    // The oldest messages should have been dropped
    const contents = nonSystem.map((m) => m.content);
    expect(contents).not.toContain("First user message — old");
  });
});
