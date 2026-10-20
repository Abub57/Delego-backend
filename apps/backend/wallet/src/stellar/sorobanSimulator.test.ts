import { describe, expect, it, vi } from "vitest";
import { SorobanSimulationError, SorobanSimulationService } from "./sorobanSimulator.js";

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Api: {
      isSimulationSuccess: (response: { success?: boolean }) => response.success === true,
      isSimulationError: (response: { success?: boolean; error?: string }) =>
        response.success === false && typeof response.error === "string",
    },
  },
}));

describe("SorobanSimulationService", () => {
  it("extracts resources and footprints and applies a 15% buffer", async () => {
    const readOnlyKey = { toXDR: () => Buffer.from("read-only") };
    const readWriteKey = { toXDR: () => Buffer.from("read-write") };
    const simulateTransaction = vi.fn().mockResolvedValue({
      success: true,
      minResourceFee: "101",
      transactionData: {
        build: () => ({
          resources: () => ({
            instructions: () => 101,
            writeBytes: () => 201,
          }),
        }),
        getReadOnly: () => [readOnlyKey],
        getReadWrite: () => [readWriteKey],
      },
    });
    const service = new SorobanSimulationService({ simulateTransaction } as never);

    await expect(service.simulateTransaction({} as never)).resolves.toEqual({
      minResourceFee: "117",
      cpuInstructions: 117,
      memoryBytes: 232,
      readOnlyFootprint: [Buffer.from("read-only").toString("base64")],
      readWriteFootprint: [Buffer.from("read-write").toString("base64")],
      success: true,
    });
  });

  it("rounds the 15% safety margin up for small non-multiples", async () => {
    const simulateTransaction = vi.fn().mockResolvedValue({
      success: true,
      minResourceFee: "1",
      transactionData: {
        build: () => ({
          resources: () => ({ instructions: () => 1, writeBytes: () => 1 }),
        }),
        getReadOnly: () => [],
        getReadWrite: () => [],
      },
    });
    const service = new SorobanSimulationService({ simulateTransaction } as never);

    const result = await service.simulateTransaction({} as never);

    expect(result.minResourceFee).toBe("2");
    expect(result.cpuInstructions).toBe(2);
    expect(result.memoryBytes).toBe(2);
  });

  it("throws a typed error with diagnostic events when simulation reverts", async () => {
    const diagnosticEvents = [{ event: "contract failure" }];
    const simulateTransaction = vi.fn().mockResolvedValue({
      success: false,
      error: "Contract invocation failed",
      events: diagnosticEvents,
    });
    const service = new SorobanSimulationService({ simulateTransaction } as never);

    await expect(service.simulateTransaction({} as never)).rejects.toMatchObject({
      name: "SorobanSimulationError",
      message: "Contract invocation failed",
      diagnosticEvents,
    } satisfies Partial<SorobanSimulationError>);
  });
});
