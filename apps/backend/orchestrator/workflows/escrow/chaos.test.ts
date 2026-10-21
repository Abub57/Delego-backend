import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEscrowSagaCoordinator, type EscrowServices } from "./index.js";
import { InMemorySagaStore } from "../../src/saga/index.js";
import type { EscrowSagaContext } from "@delegolabs/types";
import { getInventoryReservationService } from "../../src/inventory/reservation.js";

vi.mock("../../src/inventory/reservation.js", () => {
  return {
    getInventoryReservationService: vi.fn(() => ({
      reserve: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

describe("Escrow Saga Chaos Testing", () => {
  let store: InMemorySagaStore;
  let services: EscrowServices;
  let inventoryMock: any;

  beforeEach(() => {
    store = new InMemorySagaStore();
    inventoryMock = getInventoryReservationService();
    vi.clearAllMocks();

    services = {
      submitSorobanEscrow: vi.fn().mockResolvedValue({ escrowId: "escrow_123" }),
      refundSorobanEscrow: vi.fn().mockResolvedValue(undefined),
      recordOrderDb: vi.fn().mockResolvedValue(undefined),
      deleteOrderDb: vi.fn().mockResolvedValue(undefined),
    };
  });

  const createInitialContext = (): EscrowSagaContext => ({
    sagaId: "saga_1",
    orderId: "order_1",
    status: "executing",
    step: "reserve_stock",
    payload: { items: [{ sku: "item1", quantity: 1 }] },
  });

  it("should complete successfully when no failures occur", async () => {
    const coordinator = createEscrowSagaCoordinator(store, services);
    const result = await coordinator.run(
      "saga_1",
      "order_1",
      createInitialContext(),
      { workflowType: "checkout", correlationId: "corr_1" }
    );

    expect(result.status).toBe("completed");
    expect(inventoryMock.reserve).toHaveBeenCalled();
    expect(services.submitSorobanEscrow).toHaveBeenCalled();
    expect(services.recordOrderDb).toHaveBeenCalled();
  });

  it("should execute compensation when submit_soroban_escrow fails (simulated crash)", async () => {
    services.submitSorobanEscrow = vi.fn().mockRejectedValue(new Error("Soroban RPC timeout"));

    const coordinator = createEscrowSagaCoordinator(store, services);
    
    await expect(coordinator.run(
      "saga_1",
      "order_1",
      createInitialContext(),
      { workflowType: "checkout", correlationId: "corr_1" }
    )).rejects.toThrow("Soroban RPC timeout");

    const state = await store.get("saga_1");
    expect(state?.status).toBe("compensated");
    
    // Check that reserve_stock was compensated
    expect(inventoryMock.release).toHaveBeenCalled();
    // refundSorobanEscrow should not be called because submit failed
    expect(services.refundSorobanEscrow).not.toHaveBeenCalled();
  });

  it("should refund escrow and release stock when record_order_db fails (split-brain prevention)", async () => {
    services.recordOrderDb = vi.fn().mockRejectedValue(new Error("Database connection lost"));

    const coordinator = createEscrowSagaCoordinator(store, services);
    
    await expect(coordinator.run(
      "saga_1",
      "order_1",
      createInitialContext(),
      { workflowType: "checkout", correlationId: "corr_1" }
    )).rejects.toThrow("Database connection lost");

    const state = await store.get("saga_1");
    expect(state?.status).toBe("compensated");
    
    // Compensation actions:
    expect(services.refundSorobanEscrow).toHaveBeenCalledWith("escrow_123");
    expect(inventoryMock.release).toHaveBeenCalled();
  });
  
  it("should handle worker crash and resume/compensate on recovery", async () => {
    // We simulate a complete worker crash by manually putting a running record in the store
    // where the step was left incomplete.
    await store.create({
      sagaId: "saga_chaos",
      orderId: "order_1",
      workflowType: "checkout",
      status: "running",
      currentStep: "record_order_db", // crashed while recording to DB
      completedSteps: [
        {
          stepName: "reserve_stock",
          status: "completed",
          output: { step: "reserve_stock" },
          completedAt: new Date().toISOString()
        },
        {
          stepName: "submit_soroban_escrow",
          status: "completed",
          output: { step: "submit_soroban_escrow", escrowId: "escrow_chaos_123" },
          completedAt: new Date().toISOString()
        }
      ],
      context: {
        ...createInitialContext(),
        payload: { escrowId: "escrow_chaos_123" }
      },
      version: 1,
      correlationId: "corr_chaos",
      error: null,
      expiresAt: null,
      claimExpiresAt: new Date(Date.now() - 10000), // Claim expired
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Make DB fail again upon recovery to trigger compensation
    services.recordOrderDb = vi.fn().mockRejectedValue(new Error("DB still down"));
    const coordinator = createEscrowSagaCoordinator(store, services);
    
    // Coordinator resume logic - we need to manually trigger run for existing saga to simulate resume or 
    // if the coordinator has a resume method, we use that.
    // In SagaCoordinator, `run` on an existing saga checks if it can resume.
    
    await expect(coordinator.run(
      "saga_chaos",
      "order_1",
      createInitialContext(),
      { workflowType: "checkout", correlationId: "corr_chaos" }
    )).rejects.toThrow("DB still down");

    const recoveredState = await store.get("saga_chaos");
    expect(recoveredState?.status).toBe("compensated"); 
    
    // The compensation should have rolled back escrow and inventory
    expect(services.refundSorobanEscrow).toHaveBeenCalledWith("escrow_chaos_123");
    expect(inventoryMock.release).toHaveBeenCalled();
  });
});
