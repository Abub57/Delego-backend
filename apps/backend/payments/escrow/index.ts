import { createLogger } from "@delegolabs/utils";
import { getEscrowContractId } from "./config.js";
import { submitContractCall } from "./wallet-client.js";
import { getEscrowCircuitBreaker } from "./circuitBreaker.js";
import { normalizeContractError } from "./errors.js";
import type {
  DepositEscrowParams,
  EscrowOperationResult,
  EscrowService,
  InitializeEscrowParams,
  RefundEscrowParams,
  ReleaseEscrowParams,
} from "./types.js";

const log = createLogger("payments:escrow", process.env.LOG_LEVEL ?? "info");

function toEscrowResult(
  tx: { hash: string; ledger: number; success: boolean },
  escrowId?: string
): EscrowOperationResult {
  return {
    txHash: tx.hash,
    ledger: tx.ledger,
    success: tx.success,
    escrowId,
  };
}

function parseEscrowId(escrowId: string): number {
  const id = Number(escrowId);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid escrow ID: ${escrowId}`);
  }
  return id;
}

export const escrowService: EscrowService = {
  async initialize(params: InitializeEscrowParams): Promise<EscrowOperationResult> {
    const contractId = getEscrowContractId();
    const breaker = getEscrowCircuitBreaker();

    log.info("Initializing escrow contract on-chain", {
      contractId,
      sourceAddress: params.sourceAddress,
      adminAddress: params.adminAddress,
    });

    const tx = await (async () => {
      try {
        return await breaker.execute(() =>
          submitContractCall({
            sourceAddress: params.sourceAddress,
            contractId,
            method: "initialize",
            args: [params.adminAddress],
            memo: "Initialize escrow contract",
          })
        );
      } catch (err) {
        throw normalizeContractError(err);
      }
    })();

    log.info("Escrow contract initialized", { txHash: tx.hash, ledger: tx.ledger });
    return toEscrowResult(tx);
  },

  async deposit(params: DepositEscrowParams): Promise<EscrowOperationResult> {
    const contractId = getEscrowContractId();
    const breaker = getEscrowCircuitBreaker();

    log.info("Depositing funds into escrow on-chain", {
      contractId,
      sourceAddress: params.sourceAddress,
      buyerAddress: params.buyerAddress,
      sellerAddress: params.sellerAddress,
      orderId: params.orderId,
    });

    const tx = await (async () => {
      try {
        return await breaker.execute(() =>
          submitContractCall({
            sourceAddress: params.sourceAddress,
            contractId,
            method: "create_escrow",
            args: [params.buyerAddress, params.sellerAddress],
            memo: params.orderId
              ? `Deposit escrow for order ${params.orderId}`
              : "Deposit escrow funds",
            userId: params.userId,
          })
        );
      } catch (err) {
        throw normalizeContractError(err);
      }
    })();

    // Contract returns u64 escrow ID; wallet submit does not decode return values yet.
    log.info("Escrow deposit transaction completed", { txHash: tx.hash, ledger: tx.ledger });
    return toEscrowResult(tx);
  },

  async release(params: ReleaseEscrowParams): Promise<EscrowOperationResult> {
    const contractId = getEscrowContractId();
    const escrowId = parseEscrowId(params.escrowId);
    const breaker = getEscrowCircuitBreaker();

    log.info("Releasing escrow funds on-chain", {
      contractId,
      sourceAddress: params.sourceAddress,
      escrowId,
    });

    const tx = await (async () => {
      try {
        return await breaker.execute(() =>
          submitContractCall({
            sourceAddress: params.sourceAddress,
            contractId,
            method: "release",
            args: [escrowId],
            memo: `Release escrow ${params.escrowId}`,
          })
        );
      } catch (err) {
        throw normalizeContractError(err);
      }
    })();

    log.info("Escrow release transaction completed", {
      txHash: tx.hash,
      ledger: tx.ledger,
      escrowId: params.escrowId,
    });
    return toEscrowResult(tx, params.escrowId);
  },

  async refund(params: RefundEscrowParams): Promise<EscrowOperationResult> {
    const contractId = getEscrowContractId();
    const escrowId = parseEscrowId(params.escrowId);
    const breaker = getEscrowCircuitBreaker();

    log.info("Refunding escrow funds on-chain", {
      contractId,
      sourceAddress: params.sourceAddress,
      escrowId,
      refundReasonCode: params.refundReasonCode,
    });

    // Note: the escrow contract's `refund` method currently accepts only (escrow_id, caller).
    // We persist/publish `refundReasonCode` at the payments-service layer (API response/event payload)
    // and include it in the transaction memo for traceability.
    const tx = await (async () => {
      try {
        return await breaker.execute(() =>
          submitContractCall({
            sourceAddress: params.sourceAddress,
            contractId,
            method: "refund",
            args: [escrowId],
            memo: `Refund escrow ${params.escrowId} (${params.refundReasonCode})`,
          })
        );
      } catch (err) {
        throw normalizeContractError(err);
      }
    })();

    log.info("Escrow refund transaction completed", {
      txHash: tx.hash,
      ledger: tx.ledger,
      escrowId: params.escrowId,
      refundReasonCode: params.refundReasonCode,
    });
    return {
      ...toEscrowResult(tx, params.escrowId),
      // keep service-level traceability without requiring on-chain event changes
      // (EscrowOperationResult doesn't carry refund metadata yet)
    };
  },
};

