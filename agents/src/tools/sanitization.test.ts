/**
 * Tool call argument sanitization & type coercion — Issue #362
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  sanitizeToolCall,
  assertSanitizedToolCall,
  sanitizeToolCalls,
  buildSelfCorrectionPrompt,
  ToolArgumentSanitizationError,
} from "./sanitization.js";
import {
  ToolRegistry,
  ToolValidationError,
  UnknownToolError,
  type AgentContext,
  type AgentTool,
} from "./registry.js";

const PaymentSchema = z.object({
  amountStroops: z.number().int().positive(),
  maxPriceStroops: z.number().int().nonnegative(),
  assetCode: z.string().min(1),
  quantity: z.number().int().positive(),
  expedite: z.boolean(),
  memo: z.string().optional(),
  tags: z.array(z.string()),
});

const context: AgentContext = {
  userId: "user-1",
  walletAddress: "GABC",
  delegationId: "del-1",
  spendingLimitRemainingStroops: "1000000",
};

describe("sanitizeToolCall — coercion", () => {
  it("passes through already-valid arguments", () => {
    const result = sanitizeToolCall("pay", {
      amountStroops: 1000,
      maxPriceStroops: 500,
      assetCode: "XLM",
      quantity: 1,
      expedite: false,
      tags: [],
    }, PaymentSchema);

    expect(result.executionAllowed).toBe(true);
    expect(result.validatedArguments.amountStroops).toBe(1000);
  });

  it("converts a numeric string to a number", () => {
    const result = sanitizeToolCall("pay", {
      amountStroops: "1000",
      maxPriceStroops: "500",
      assetCode: "XLM",
      quantity: 2,
      expedite: true,
      tags: [],
    }, PaymentSchema);

    expect(result.executionAllowed).toBe(true);
    expect(result.validatedArguments.amountStroops).toBe(1000);
  });

  it("converts a floating dollar string to integer stroops", () => {
    // The canonical bug from the issue: dollars where stroops are required.
    const result = sanitizeToolCall("pay", {
      amountStroops: "10.50",
      maxPriceStroops: "2.5",
      assetCode: "XLM",
      quantity: 1,
      expedite: false,
      tags: [],
    }, PaymentSchema);

    expect(result.executionAllowed).toBe(true);
    // 10.50 XLM = 105,000,000 stroops; 2.5 XLM = 25,000,000 stroops.
    expect(result.validatedArguments.amountStroops).toBe(105000000);
    expect(result.validatedArguments.maxPriceStroops).toBe(25000000);
  });

  it("strips currency symbols and thousands separators", () => {
    const result = sanitizeToolCall("pay", {
      amountStroops: "$1,000.25",
      maxPriceStroops: 1,
      assetCode: "XLM",
      quantity: 1,
      expedite: false,
      tags: [],
    }, PaymentSchema);

    expect(result.executionAllowed).toBe(true);
    expect(result.validatedArguments.amountStroops).toBe(10002500000);
  });

  it("coerces boolean-ish strings and numbers", () => {
    for (const [input, expected] of [
      ["true", true],
      ["yes", true],
      ["1", true],
      ["false", false],
      ["no", false],
      ["0", false],
      [1, true],
      [0, false],
    ] as const) {
      const result = sanitizeToolCall("pay", {
        amountStroops: 1,
        maxPriceStroops: 1,
        assetCode: "XLM",
        quantity: 1,
        expedite: input,
        tags: [],
      }, PaymentSchema);

      expect(result.executionAllowed).toBe(true);
      expect(result.validatedArguments.expedite).toBe(expected);
    }
  });

  it("parses a JSON string payload", () => {
    const result = sanitizeToolCall("pay", JSON.stringify({
      amountStroops: "10.5",
      maxPriceStroops: 5,
      assetCode: "XLM",
      quantity: 1,
      expedite: "true",
      tags: ["a"],
    }), PaymentSchema);

    expect(result.executionAllowed).toBe(true);
    expect(result.validatedArguments.amountStroops).toBe(105000000);
  });

  it("treats null/undefined/empty arguments as an empty object", () => {
    for (const raw of [null, undefined, "", "   "]) {
      const result = sanitizeToolCall("noop", raw, z.object({}).passthrough());
      expect(result.executionAllowed).toBe(true);
    }
  });

  it("coerces an integer number into a string-typed stroop field", () => {
    const result = sanitizeToolCall(
      "t",
      { totalAmountStroops: 1050 },
      z.object({ totalAmountStroops: z.string().regex(/^\d+$/) })
    );
    expect(result.executionAllowed).toBe(true);
    expect(result.validatedArguments.totalAmountStroops).toBe("1050");
  });

  it("converts a floating dollar string into a string-typed stroop field", () => {
    const result = sanitizeToolCall(
      "t",
      { totalAmountStroops: "10.5" },
      z.object({ totalAmountStroops: z.string().regex(/^\d+$/) })
    );
    expect(result.executionAllowed).toBe(true);
    expect(result.validatedArguments.totalAmountStroops).toBe("105000000");
  });

  it("does NOT coerce a number into an arbitrary string field (#262 contract)", () => {
    const result = sanitizeToolCall("t", { code: 12 }, z.object({ code: z.string() }));
    expect(result.executionAllowed).toBe(false);
    expect(result.sanitizationErrors?.join(" ")).toMatch(/must be a string/);
  });
});

describe("sanitizeToolCall — safe rejection", () => {
  it("rejects a decimal for a non-stroop integer instead of rounding", () => {
    const result = sanitizeToolCall("pay", {
      amountStroops: 1,
      maxPriceStroops: 1,
      assetCode: "XLM",
      quantity: 3.7,
      expedite: false,
      tags: [],
    }, PaymentSchema);

    expect(result.executionAllowed).toBe(false);
    expect(result.sanitizationErrors?.join(" ")).toMatch(/quantity must be an integer/);
  });

  it("reports the exact integer for a decimal number on a stroop field", () => {
    const result = sanitizeToolCall("pay", {
      amountStroops: 10.5,
      maxPriceStroops: 1,
      assetCode: "XLM",
      quantity: 1,
      expedite: false,
      tags: [],
    }, PaymentSchema);

    expect(result.executionAllowed).toBe(false);
    expect(result.sanitizationErrors?.join(" ")).toContain("105000000");
  });

  it("rejects a non-numeric string without partial parsing", () => {
    const result = sanitizeToolCall("pay", {
      amountStroops: "12abc",
      maxPriceStroops: 1,
      assetCode: "XLM",
      quantity: 1,
      expedite: false,
      tags: [],
    }, PaymentSchema);

    expect(result.executionAllowed).toBe(false);
    expect(result.sanitizationErrors?.join(" ")).toMatch(/must be a number/);
  });

  it("rejects non-finite numbers", () => {
    const result = sanitizeToolCall("pay", {
      amountStroops: Number.NaN,
      maxPriceStroops: 1,
      assetCode: "XLM",
      quantity: 1,
      expedite: false,
      tags: [],
    }, PaymentSchema);

    expect(result.executionAllowed).toBe(false);
  });

  it("rejects a non-object argument payload", () => {
    for (const raw of [42, [1, 2, 3], true]) {
      const result = sanitizeToolCall("pay", raw, PaymentSchema);
      expect(result.executionAllowed).toBe(false);
      expect(result.sanitizationErrors?.join(" ")).toMatch(/must be a JSON object/);
    }
  });

  it("rejects a string that is not valid JSON", () => {
    const result = sanitizeToolCall("pay", "{oops", PaymentSchema);
    expect(result.executionAllowed).toBe(false);
    expect(result.sanitizationErrors?.join(" ")).toMatch(/not valid JSON/);
  });

  it("reports schema-level failures with a field path", () => {
    const result = sanitizeToolCall("pay", {
      assetCode: "XLM",
      quantity: 1,
      expedite: false,
      tags: [],
    }, PaymentSchema);

    expect(result.executionAllowed).toBe(false);
    expect(result.sanitizationErrors?.join(" ")).toMatch(/amountStroops/);
  });

  it("never throws for malformed input", () => {
    const hostile: unknown[] = [
      undefined, null, 0, "", "[]", Symbol("x"),
      { toString: () => "boom" },
      Object.create(null),
    ];
    for (const raw of hostile) {
      expect(() => sanitizeToolCall("pay", raw, PaymentSchema)).not.toThrow();
    }
  });
});

describe("self-correction prompt", () => {
  it("names the tool and lists every problem", () => {
    const prompt = buildSelfCorrectionPrompt("pay", ["a is bad", "b is bad"]);

    expect(prompt).toContain('"pay"');
    expect(prompt).toContain("1. a is bad");
    expect(prompt).toContain("2. b is bad");
    expect(prompt).toContain("calling the tool again");
  });

  it("is attached to the throwing API", () => {
    let caught: unknown;
    try {
      assertSanitizedToolCall("pay", { quantity: 1.5 }, PaymentSchema);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ToolArgumentSanitizationError);
    const error = caught as ToolArgumentSanitizationError;
    expect(error.selfCorrectionPrompt).toContain('"pay"');
    expect(error.toolName).toBe("pay");
    expect(error.errors.length).toBeGreaterThan(0);
  });
});

describe("sanitizeToolCalls — batch", () => {
  const schemas = { pay: PaymentSchema, noop: z.object({}) };

  const baseArgs = {
    amountStroops: "10.5",
    maxPriceStroops: 1,
    assetCode: "XLM",
    quantity: 1,
    expedite: "true",
    tags: [],
  };

  it("separates allowed from rejected calls", () => {
    const result = sanitizeToolCalls(
      [
        { id: "1", name: "pay", arguments: baseArgs },
        { id: "2", name: "pay", arguments: { quantity: 1.5 } },
      ],
      schemas
    );

    expect(result.ok).toBe(false);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0].id).toBe("1");
    expect(
      (result.allowed[0].validatedArguments as { amountStroops: number }).amountStroops
    ).toBe(105000000);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].id).toBe("2");
    expect(result.rejected[0].selfCorrectionPrompt).toContain('"pay"');
  });

  it("rejects a hallucinated tool name without throwing", () => {
    const result = sanitizeToolCalls(
      [{ id: "1", name: "send_funds_elsewhere", arguments: {} }],
      schemas
    );

    expect(result.ok).toBe(false);
    expect(result.allowed).toHaveLength(0);
    expect(result.rejected[0].errors.join(" ")).toContain("Unknown tool");
    expect(result.rejected[0].selfCorrectionPrompt).toContain("pay, noop");
  });

  it("handles an empty or non-array batch", () => {
    expect(sanitizeToolCalls([], schemas).ok).toBe(true);
    expect(sanitizeToolCalls(undefined as never, schemas).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const echoTool: AgentTool<{ n: number }, number> = {
  name: "echo",
  description: "echo",
  inputSchema: z.object({ n: z.number().int() }),
  requiredPermission: "read_only",
  execute: async (input) => input.n,
};

describe("ToolRegistry interception (#362)", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(echoTool);
  });

  it("coerces arguments inside execute()", async () => {
    const out = await registry.execute("echo", { n: "42" }, context);
    expect(out).toBe(42);
  });

  it("throws ToolValidationError with a self-correction prompt, not a crash", async () => {
    await expect(
      registry.execute("echo", { n: 1.5 }, context)
    ).rejects.toBeInstanceOf(ToolValidationError);

    let caught: unknown;
    try {
      await registry.execute("echo", { n: "abc" }, context);
    } catch (err) {
      caught = err;
    }
    const error = caught as ToolValidationError;
    expect(error.selfCorrectionPrompt).toContain('"echo"');
  });

  it("validateToolCall reports without executing", () => {
    const result = registry.validateToolCall("echo", { n: "7" });
    expect(result.executionAllowed).toBe(true);
    expect(result.validatedArguments).toEqual({ n: 7 });

    const bad = registry.validateToolCall("echo", { n: 1.5 });
    expect(bad.executionAllowed).toBe(false);
  });

  it("executeToolCall resolves (does not throw) on malformed input", async () => {
    const result = await registry.executeToolCall(
      { id: "1", name: "echo", arguments: { n: "oops" } },
      context
    );

    expect(result.executionAllowed).toBe(false);
    if (!result.executionAllowed) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.selfCorrectionPrompt).toContain('"echo"');
    }
  });

  it("executeToolCall resolves with the output on a valid call", async () => {
    const result = await registry.executeToolCall(
      { id: "1", name: "echo", arguments: { n: "9" } },
      context
    );

    expect(result.executionAllowed).toBe(true);
    if (result.executionAllowed) {
      expect(result.output).toBe(9);
    }
  });

  it("executeToolCall resolves for an unknown tool", async () => {
    const result = await registry.executeToolCall(
      { id: "1", name: "nope", arguments: {} },
      context
    );

    expect(result.executionAllowed).toBe(false);
    if (!result.executionAllowed) {
      expect(result.selfCorrectionPrompt).toContain("echo");
    }
  });

  it("execute() throws UnknownToolError carrying a self-correction prompt", async () => {
    let caught: unknown;
    try {
      await registry.execute("nope", {}, context);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnknownToolError);
    expect((caught as UnknownToolError).availableTools).toEqual(["echo"]);
  });

  it("still enforces permissions after sanitization", async () => {
    const payTool: AgentTool<{ n: number }, number> = {
      ...echoTool,
      name: "pay_now",
      requiredPermission: "execute_payment",
    };
    registry.register(payTool);

    const readOnly: AgentContext = { ...context, delegationId: undefined };
    await expect(
      registry.execute("pay_now", { n: "1" }, readOnly)
    ).rejects.toThrow(/Permission denied/);
  });

  it("audits coerced (not raw) input", async () => {
    await registry.execute("echo", { n: "5" }, context);
    const entry = registry.getAuditLog().at(-1);
    expect(entry?.input).toEqual({ n: 5 });
    expect(entry?.success).toBe(true);
  });
});
