import { createLogger } from "@delegolabs/utils";
import { SagaCoordinator, type SagaStep as BaseSagaStep, type SagaStore, type SagaRecord } from "../../src/saga/index.js";
import type { EscrowSagaContext } from "@delegolabs/types";
import { getInventoryReservationService } from "../../src/inventory/reservation.js";

const log = createLogger("orchestrator:escrow:saga", process.env.LOG_LEVEL ?? "info");

// Interfaces for remote calls
export interface EscrowServices {
  submitSorobanEscrow: (context: EscrowSagaContext) => Promise<{ escrowId: string }>;
  refundSorobanEscrow: (escrowId: string) => Promise<void>;
  recordOrderDb: (context: EscrowSagaContext) => Promise<void>;
  deleteOrderDb: (orderId: string) => Promise<void>;
}

// Default mock implementation to allow chaos testing
export const defaultEscrowServices: EscrowServices = {
  submitSorobanEscrow: async () => ({ escrowId: `escrow_${Date.now()}` }),
  refundSorobanEscrow: async () => {},
  recordOrderDb: async () => {},
  deleteOrderDb: async () => {},
};

export function createEscrowSagaCoordinator(
  store: SagaStore,
  services: EscrowServices = defaultEscrowServices
): SagaCoordinator<EscrowSagaContext> {
  const reserveStockStep: BaseSagaStep<EscrowSagaContext> = {
    name: "reserve_stock",
    async execute(context) {
      log.info("Executing reserve_stock", { sagaId: context.sagaId });
      const inventory = getInventoryReservationService();
      if (context.payload.items && Array.isArray(context.payload.items)) {
        await inventory.reserve(context.payload.items as any);
      }
      return { ...context, step: "reserve_stock" };
    },
    async compensate(context) {
      log.info("Compensating reserve_stock", { sagaId: context.sagaId });
      const inventory = getInventoryReservationService();
      if (context.payload.items && Array.isArray(context.payload.items)) {
        await inventory.release(context.payload.items as any);
      }
      return context;
    },
  };

  const submitSorobanEscrowStep: BaseSagaStep<EscrowSagaContext> = {
    name: "submit_soroban_escrow",
    async execute(context) {
      log.info("Executing submit_soroban_escrow", { sagaId: context.sagaId });
      const { escrowId } = await services.submitSorobanEscrow(context);
      return {
        ...context,
        step: "submit_soroban_escrow",
        payload: { ...context.payload, escrowId },
      };
    },
    async compensate(context) {
      log.info("Compensating submit_soroban_escrow", { sagaId: context.sagaId });
      if (context.payload.escrowId) {
        await services.refundSorobanEscrow(context.payload.escrowId as string);
      }
      return context;
    },
  };

  const recordOrderDbStep: BaseSagaStep<EscrowSagaContext> = {
    name: "record_order_db",
    async execute(context) {
      log.info("Executing record_order_db", { sagaId: context.sagaId });
      await services.recordOrderDb(context);
      return { ...context, step: "record_order_db" };
    },
    async compensate(context) {
      log.info("Compensating record_order_db", { sagaId: context.sagaId });
      await services.deleteOrderDb(context.orderId);
      return context;
    },
  };

  const completeStep: BaseSagaStep<EscrowSagaContext> = {
    name: "complete",
    async execute(context) {
      log.info("Executing complete", { sagaId: context.sagaId });
      return { ...context, step: "complete", status: "succeeded" };
    },
    async compensate(context) {
      return context;
    },
  };

  return new SagaCoordinator<EscrowSagaContext>({
    steps: [reserveStockStep, submitSorobanEscrowStep, recordOrderDbStep, completeStep],
    store,
  });
}
