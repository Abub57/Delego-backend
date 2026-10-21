/**
 * Unit tests for LLM provider clients.
 * Issue #261: verifies tool call argument parsing and provider switching.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIClient } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import { GeminiClient } from "./gemini.js";
import {
  createLLMClient,
  createDefaultLLMClient,
  createFailoverLLMClient,
  resolveFallbackChain,
} from "./factory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(response),
    text: () => Promise.resolve(JSON.stringify(response)),
    statusText: "OK",
  });
}

const BASE_CONFIG = { apiKey: "test-key", maxRetries: 0 };

const MESSAGES = [{ role: "user" as const, content: "Hello" }];

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe("OpenAIClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns text content from a standard completion", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        choices: [{ message: { content: "Hi there!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      })
    );

    const client = new OpenAIClient(BASE_CONFIG);
    const result = await client.chat({ model: "gpt-4o", messages: MESSAGES });

    expect(result.content).toBe("Hi there!");
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(3);
    expect(result.finishReason).toBe("stop");
    expect(result.provider).toBe("openai");
  });

  it("parses tool call arguments from function_calling response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  function: {
                    name: "search_products",
                    arguments: JSON.stringify({ query: "blue shoes", limit: 5 }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      })
    );

    const client = new OpenAIClient(BASE_CONFIG);
    const result = await client.chat({
      model: "gpt-4o",
      messages: MESSAGES,
      tools: [{ name: "search_products", description: "Search", parameters: {} }],
    });

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].id).toBe("call_abc");
    expect(result.toolCalls![0].name).toBe("search_products");
    expect(result.toolCalls![0].arguments).toEqual({ query: "blue shoes", limit: 5 });
  });

  it("throws when the API returns a non-retryable error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
        statusText: "Unauthorized",
      })
    );

    const client = new OpenAIClient(BASE_CONFIG);
    await expect(client.chat({ model: "gpt-4o", messages: MESSAGES })).rejects.toThrow(
      "OpenAI API error 401"
    );
  });

  it("retries on 429 and succeeds on subsequent attempt", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            text: () => Promise.resolve("Too Many Requests"),
            statusText: "Too Many Requests",
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          statusText: "OK",
        });
      })
    );

    const client = new OpenAIClient({ apiKey: "test-key", maxRetries: 2, baseDelayMs: 0 });
    const result = await client.chat({ model: "gpt-4o", messages: MESSAGES });
    expect(result.content).toBe("ok");
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe("AnthropicClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns text content from a standard completion", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        content: [{ type: "text", text: "Hello from Claude" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 8, output_tokens: 4 },
      })
    );

    const client = new AnthropicClient(BASE_CONFIG);
    const result = await client.chat({ model: "claude-sonnet-4-6", messages: MESSAGES });

    expect(result.content).toBe("Hello from Claude");
    expect(result.provider).toBe("anthropic");
    expect(result.finishReason).toBe("stop");
  });

  it("parses tool_use blocks into toolCalls", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        content: [
          {
            type: "tool_use",
            id: "toolu_01",
            name: "get_merchant_reputation",
            input: { merchantAddress: "GXYZ" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 15, output_tokens: 5 },
      })
    );

    const client = new AnthropicClient(BASE_CONFIG);
    const result = await client.chat({
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
      tools: [{ name: "get_merchant_reputation", description: "Get reputation", parameters: {} }],
    });

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].id).toBe("toolu_01");
    expect(result.toolCalls![0].name).toBe("get_merchant_reputation");
    expect(result.toolCalls![0].arguments).toEqual({ merchantAddress: "GXYZ" });
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

describe("GeminiClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns text content from a standard completion", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        candidates: [
          {
            content: { parts: [{ text: "Gemini reply" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3, totalTokenCount: 9 },
      })
    );

    const client = new GeminiClient(BASE_CONFIG);
    const result = await client.chat({ model: "gemini-1.5-pro", messages: MESSAGES });

    expect(result.content).toBe("Gemini reply");
    expect(result.provider).toBe("gemini");
    expect(result.finishReason).toBe("stop");
  });

  it("parses functionCall parts into toolCalls", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "search_products",
                    args: { query: "running shoes" },
                  },
                },
              ],
            },
            finishReason: "FUNCTION_CALL",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      })
    );

    const client = new GeminiClient(BASE_CONFIG);
    const result = await client.chat({
      model: "gemini-1.5-pro",
      messages: MESSAGES,
      tools: [{ name: "search_products", description: "Search products", parameters: {} }],
    });

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe("search_products");
    expect(result.toolCalls![0].arguments).toEqual({ query: "running shoes" });
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe("LLM failover orchestration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back to the next provider when the preferred provider returns a 429", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("api.openai.com")) {
          calls.push("openai");
          return Promise.resolve({
            ok: false,
            status: 429,
            text: () => Promise.resolve("Too Many Requests"),
            statusText: "Too Many Requests",
          });
        }
        if (url.includes("api.anthropic.com")) {
          calls.push("anthropic");
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              content: [{ type: "text", text: "Recovered via Anthropic" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 3, output_tokens: 2 },
            }),
            statusText: "OK",
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      })
    );

    const client = createFailoverLLMClient({
      preferredProvider: "openai",
      fallbackChain: ["openai", "anthropic"],
      providerConfigs: {
        openai: { apiKey: "oa-key", maxRetries: 0, baseDelayMs: 0 },
        anthropic: { apiKey: "ant-key", maxRetries: 0, baseDelayMs: 0 },
      },
    });

    const result = await client.chat({
      model: "gpt-4o",
      messages: MESSAGES,
      preferredProvider: "openai",
      fallbackChain: ["openai", "anthropic"],
    });

    expect(result.provider).toBe("anthropic");
    expect(result.content).toBe("Recovered via Anthropic");
    expect(calls).toEqual(["openai", "anthropic"]);
    expect(client.getMetrics?.().find((m) => m.provider === "openai")?.failures).toBeGreaterThan(0);
  });

  it("tracks latency and error rate for each provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        statusText: "OK",
      })
    );

    const client = createFailoverLLMClient({
      preferredProvider: "openai",
      fallbackChain: ["openai"],
      providerConfigs: { openai: { apiKey: "oa-key", maxRetries: 0, baseDelayMs: 0 } },
    });

    await client.chat({ model: "gpt-4o", messages: MESSAGES });

    const metrics = client.getMetrics?.();
    expect(metrics).toBeDefined();
    expect(metrics?.[0]?.requests).toBe(1);
    expect(metrics?.[0]?.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics?.[0]?.errorRate).toBe(0);
  });
});

describe("createLLMClient", () => {
  it("creates an OpenAI client when provider is openai", () => {
    const client = createLLMClient("openai", { apiKey: "sk-test" });
    expect(client.provider).toBe("openai");
  });

  it("creates an Anthropic client when provider is anthropic", () => {
    const client = createLLMClient("anthropic", { apiKey: "ant-test" });
    expect(client.provider).toBe("anthropic");
  });

  it("creates a Gemini client when provider is gemini", () => {
    const client = createLLMClient("gemini", { apiKey: "gem-test" });
    expect(client.provider).toBe("gemini");
  });

  it("reads provider from LLM_PROVIDER env var", () => {
    const original = process.env["LLM_PROVIDER"];
    try {
      process.env["LLM_PROVIDER"] = "anthropic";
      process.env["ANTHROPIC_API_KEY"] = "ant-key";
      const client = createDefaultLLMClient();
      expect(client.provider).toBe("anthropic");
    } finally {
      process.env["LLM_PROVIDER"] = original;
      delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("throws when API key is missing", () => {
    const original = process.env["OPENAI_API_KEY"];
    try {
      delete process.env["OPENAI_API_KEY"];
      expect(() => createLLMClient("openai")).toThrow("API key");
    } finally {
      process.env["OPENAI_API_KEY"] = original;
    }
  });

  it("resolves a default fallback chain in provider preference order", () => {
    expect(resolveFallbackChain("openai", ["openai", "anthropic"])) .toEqual(["openai", "anthropic"]);
    expect(resolveFallbackChain("anthropic")).toEqual(["anthropic", "openai", "gemini"]);
  });
});
