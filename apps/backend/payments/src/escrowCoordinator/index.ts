import { createLogger } from "@delegolabs/utils";
import {
  extractEscrowIdFromTx,
  getContractReadSourceAddress,
  mapChainEscrowStatus,
  orderIdToContractBytes,
  readEscrowFromChain,
} from "./contractClient.js";
import { submitContractInvocationWithRetry } from "./contractInvocationRetry.js";
import {
  createPaymentRecord,
  findPaymentRecordByEscrowId,
  findPaymentRecordByOrderId,
  incrementPaymentRecordAmounts,
  updatePaymentRecord,
} from "./paymentRecordStore.js";
import { publishPaymentStatusEvent } from "./redisEvents.js";
import { getEscrowFundingLockManager } from "./escrowFundingLock.js";
import { checkEscrowVelocity } from "./fraudGuard.js";
import {
  InsufficientEscrowBalanceError,
  type DisputeEscrowParams,
  type DisputeResult,
  type EscrowCoordinator,
  type EscrowStatusResult,
  type FundEscrowParams,
  type FundEscrowResult,
  type PartialRefundEscrowParams,
  type PartialRefundResult,
  type PartialReleaseEscrowParams,
  type PartialReleaseResult,
  type PaymentRecord,
  type RefundEscrowParams,
  type RefundResult,
  type ReleaseEscrowParams,
  type ReleaseResult,
  type RemainingBalance,
} from "./types.js";

const log = createLogger("payments:escrow-coordinator", process.env.LOG_LEVEL ?? "info");

function parseEscrowId(escrowId: string): number {
  const id = Number(escrowId);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`Invalid escrow ID: ${escrowId}`);
  }
  return id;
}

function toFundResult(record: PaymentRecord, ledger = 0): FundEscrowResult {
  const funded =
    record.status === "funded" ||
    record.status === "released" ||
    record.status === "refunded" ||
    Boolean(record.fundTxHash);

  return {
    escrowId: record.escrowId ?? "",
    txHash: record.fundTxHash ?? "",
    ledger,
    status: funded ? "funded" : "failed",
  };
}

function toEscrowStatusResult(
  escrowId: string,
  buyer: string,
  seller: string,
  amount: string,
  status: EscrowStatusResult["status"],
  createdAt: number
): EscrowStatusResult {
  return { escrowId, buyer, seller, amount, status, createdAt };
}

function mapRecordStatusToEscrowStatus(
  status: PaymentRecord["status"]
): EscrowStatusResult["status"] | null {
  switch (status) {
    case "funded":
      return "funded";
    case "released":
      return "released";
    case "refunded":
      return "refunded";
    case "disputed":
      return "disputed";
    default:
      return null;
  }
}

/** Escrow balance still available for release/refund: total - released - refunded. */
function computeRemaining(record: PaymentRecord): bigint {
  return (
    BigInt(record.amountStroops) -
    BigInt(record.releasedAmountStroops) -
    BigInt(record.refundedAmountStroops)
  );
}

async function emitStatusEvent(
  channel:
    | "payment:funded"
    | "payment:released"
    | "payment:refunded"
    | "payment:disputed"
    | "payment:partial_released"
    | "payment:partial_refunded"
    | "payment:failed",
  record: PaymentRecord,
  txHash?: string,
  reason?: string
): Promise<void> {
  await publishPaymentStatusEvent(channel, {
    orderId: record.orderId,
    escrowId: record.escrowId ?? undefined,
    txHash,
    status: record.status,
    reason,
    occurredAt: new Date().toISOString(),
  });
}

export const escrowCoordinator: EscrowCoordinator = {
  async fundEscrow(params: FundEscrowParams): Promise<FundEscrowResult> {
    const existing = await findPaymentRecordByOrderId(params.orderId);
    if (existing) {
      log.info("Returning existing payment record for duplicate fund request", {
        orderId: params.orderId,
        paymentRecordId: existing.id,
      });
      return toFundResult(existing);
    }
    const velocity = await checkEscrowVelocity(params.buyerAddress);
    if (velocity.paused) {
      log.warn("Escrow funding blocked: buyer paused pending fraud review", {
        orderId: params.orderId,
        buyerAddress: params.buyerAddress,
      });
      return { escrowId: "", txHash: "", ledger: 0, status: "failed" };
    }

    // Issue #147 — Use adaptive locking for escrow funding
    const lockManager = getEscrowFundingLockManager();
    const lockHolderId = `fund:${params.orderId}`;
    const acquisition = await lockManager.acquireLock(params.orderId, lockHolderId);

    if (!acquisition) {
      log.warn("Could not acquire funding lock, proceeding without lock", {
        orderId: params.orderId,
      });
    }

    let record = await createPaymentRecord({
      orderId: params.orderId,
      escrowContractId: params.escrowContractId,
      buyerAddress: params.buyerAddress,
      sellerAddress: params.sellerAddress,
      tokenContractId: params.tokenContractId,
      amountStroops: params.amountStroops,
    });

    try {
      const tx = await submitContractInvocationWithRetry({
        sourceAddress: params.buyerAddress,
        contractId: params.escrowContractId,
        method: "deposit",
        args: [
          params.buyerAddress,
          params.sellerAddress,
          params.tokenContractId,
          params.amountStroops,
          orderIdToContractBytes(params.orderId),
          params.timeoutLedgers,
        ],
        memo: `Fund escrow for order ${params.orderId}`,
        amountStroops: params.amountStroops,
      });

      if (!tx.success) {
        record = await updatePaymentRecord(record.id, {
          status: "failed",
          failureReason: "Fund transaction failed on-chain",
        });
        await emitStatusEvent("payment:failed", record, tx.hash, "Fund transaction failed on-chain");
        return {
          escrowId: "",
          txHash: tx.hash,
          ledger: tx.ledger,
          status: "failed",
        };
      }

      const escrowId = await extractEscrowIdFromTx(tx.hash);
      record = await updatePaymentRecord(record.id, {
        escrowId,
        status: "funded",
        fundTxHash: tx.hash,
        failureReason: null,
      });
      await emitStatusEvent("payment:funded", record, tx.hash);

      if (acquisition) lockManager.releaseLock(acquisition, lockHolderId);

      return {
        escrowId,
        txHash: tx.hash,
        ledger: tx.ledger,
        status: "funded",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown fund error";
      log.error("Escrow fund failed", { orderId: params.orderId, error: message });
      record = await updatePaymentRecord(record.id, {
        status: "failed",
        failureReason: message,
      });
      await emitStatusEvent("payment:failed", record, undefined, message);

      if (acquisition) lockManager.releaseLock(acquisition, lockHolderId);

      return {
        escrowId: record.escrowId ?? "",
        txHash: record.fundTxHash ?? "",
        ledger: 0,
        status: "failed",
      };
    }
  },

  async releaseEscrow(params: ReleaseEscrowParams): Promise<ReleaseResult> {
    const record = await findPaymentRecordByEscrowId(params.escrowId);
    if (!record) {
      throw new Error(`Payment record not found for escrow ${params.escrowId}`);
    }

    if (record.status === "released" && record.releaseTxHash) {
      return {
        txHash: record.releaseTxHash,
        ledger: 0,
        status: "released",
        sellerAddress: record.sellerAddress,
        amount: record.amountStroops,
      };
    }

    await updatePaymentRecord(record.id, { failureReason: null });

    try {
      const tx = await submitContractInvocationWithRetry({
        sourceAddress: params.callerAddress,
        contractId: params.escrowContractId,
        method: "release",
        args: [parseEscrowId(params.escrowId), params.callerAddress],
        memo: `Release escrow ${params.escrowId}`,
      });

      if (!tx.success) {
        const updated = await updatePaymentRecord(record.id, {
          status: "failed",
          failureReason: "Release transaction failed on-chain",
        });
        await emitStatusEvent("payment:failed", updated, tx.hash, "Release transaction failed on-chain");
        return {
          txHash: tx.hash,
          ledger: tx.ledger,
          status: "failed",
          sellerAddress: record.sellerAddress,
          amount: record.amountStroops,
        };
      }

      const updated = await updatePaymentRecord(record.id, {
        status: "released",
        releaseTxHash: tx.hash,
        failureReason: null,
      });
      await emitStatusEvent("payment:released", updated, tx.hash);

      return {
        txHash: tx.hash,
        ledger: tx.ledger,
        status: "released",
        sellerAddress: record.sellerAddress,
        amount: record.amountStroops,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown release error";
      log.error("Escrow release failed", { escrowId: params.escrowId, error: message });
      const updated = await updatePaymentRecord(record.id, {
        status: "failed",
        failureReason: message,
      });
      await emitStatusEvent("payment:failed", updated, undefined, message);
      return {
        txHash: record.releaseTxHash ?? "",
        ledger: 0,
        status: "failed",
        sellerAddress: record.sellerAddress,
        amount: record.amountStroops,
      };
    }
  },

  async refundEscrow(params: RefundEscrowParams): Promise<RefundResult> {
    const record = await findPaymentRecordByEscrowId(params.escrowId);
    if (!record) {
      throw new Error(`Payment record not found for escrow ${params.escrowId}`);
    }

    if (record.status === "refunded" && record.refundTxHash) {
      return {
        txHash: record.refundTxHash,
        ledger: 0,
        status: "refunded",
        buyerAddress: record.buyerAddress,
        amount: record.amountStroops,
      };
    }

    await updatePaymentRecord(record.id, { failureReason: null });

    try {
      const tx = await submitContractInvocationWithRetry({
        sourceAddress: params.callerAddress,
        contractId: params.escrowContractId,
        method: "refund",
        args: [parseEscrowId(params.escrowId), params.callerAddress],
        memo: `Refund escrow ${params.escrowId} (${params.reason})`,
      });

      if (!tx.success) {
        const updated = await updatePaymentRecord(record.id, {
          status: "failed",
          failureReason: "Refund transaction failed on-chain",
        });
        await emitStatusEvent(
          "payment:failed",
          updated,
          tx.hash,
          `Refund transaction failed on-chain (${params.reason})`
        );
        return {
          txHash: tx.hash,
          ledger: tx.ledger,
          status: "failed",
          buyerAddress: record.buyerAddress,
          amount: record.amountStroops,
        };
      }

      const updated = await updatePaymentRecord(record.id, {
        status: "refunded",
        refundTxHash: tx.hash,
        failureReason: null,
      });
      await emitStatusEvent("payment:refunded", updated, tx.hash);

      return {
        txHash: tx.hash,
        ledger: tx.ledger,
        status: "refunded",
        buyerAddress: record.buyerAddress,
        amount: record.amountStroops,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown refund error";
      log.error("Escrow refund failed", {
        escrowId: params.escrowId,
        reason: params.reason,
        error: message,
      });
      const updated = await updatePaymentRecord(record.id, {
        status: "failed",
        failureReason: message,
      });
      await emitStatusEvent("payment:failed", updated, undefined, message);
      return {
        txHash: record.refundTxHash ?? "",
        ledger: 0,
        status: "failed",
        buyerAddress: record.buyerAddress,
        amount: record.amountStroops,
      };
    }
  },

  async disputeEscrow(params: DisputeEscrowParams): Promise<DisputeResult> {
    const record = await findPaymentRecordByEscrowId(params.escrowId);
    if (!record) {
      throw new Error(`Payment record not found for escrow ${params.escrowId}`);
    }

    if (record.status === "disputed" && record.disputeTxHash) {
      return {
        txHash: record.disputeTxHash,
        ledger: 0,
        status: "disputed",
        disputedBy: params.callerAddress,
      };
    }

    await updatePaymentRecord(record.id, { failureReason: null });

    try {
      const tx = await submitContractInvocationWithRetry({
        sourceAddress: params.callerAddress,
        contractId: params.escrowContractId,
        method: "dispute",
        args: [parseEscrowId(params.escrowId), params.callerAddress],
        memo: `Dispute escrow ${params.escrowId}`,
      });

      if (!tx.success) {
        const updated = await updatePaymentRecord(record.id, {
          status: "failed",
          failureReason: "Dispute transaction failed on-chain",
        });
        await emitStatusEvent("payment:failed", updated, tx.hash, "Dispute transaction failed on-chain");
        return {
          txHash: tx.hash,
          ledger: tx.ledger,
          status: "failed",
          disputedBy: params.callerAddress,
        };
      }

      const updated = await updatePaymentRecord(record.id, {
        status: "disputed",
        disputeTxHash: tx.hash,
        failureReason: null,
      });
      await emitStatusEvent("payment:disputed", updated, tx.hash);

      return {
        txHash: tx.hash,
        ledger: tx.ledger,
        status: "disputed",
        disputedBy: params.callerAddress,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown dispute error";
      log.error("Escrow dispute failed", { escrowId: params.escrowId, error: message });
      const updated = await updatePaymentRecord(record.id, {
        status: "failed",
        failureReason: message,
      });
      await emitStatusEvent("payment:failed", updated, undefined, message);
      return {
        txHash: record.disputeTxHash ?? "",
        ledger: 0,
        status: "failed",
        disputedBy: params.callerAddress,
      };
    }
  },

  // -------------------------------------------------------------------------
  // Issue #46 — Partial refunds & dispute mediation
  // -------------------------------------------------------------------------

  async partialRefundEscrow(params: PartialRefundEscrowParams): Promise<PartialRefundResult> {
    const record = await findPaymentRecordByEscrowId(params.escrowId);
    if (!record) {
      throw new Error(`Payment record not found for escrow ${params.escrowId}`);
    }

    const remaining = computeRemaining(record);
    const requested = BigInt(params.amountStroops);
    if (requested <= 0n || requested > remaining) {
      throw new InsufficientEscrowBalanceError(params.escrowId, remaining.toString(), params.amountStroops);
    }

    await updatePaymentRecord(record.id, { failureReason: null });

    try {
      const tx = await submitContractInvocationWithRetry({
        sourceAddress: params.callerAddress,
        contractId: params.escrowContractId,
        method: "partial_refund",
        args: [parseEscrowId(params.escrowId), params.callerAddress, params.amountStroops],
        memo: `Partial refund escrow ${params.escrowId} (${params.reason})`,
      });

      if (!tx.success) {
        const updated = await updatePaymentRecord(record.id, {
          status: "failed",
          failureReason: "Partial refund transaction failed on-chain",
        });
        await emitStatusEvent(
          "payment:failed",
          updated,
          tx.hash,
          `Partial refund transaction failed on-chain (${params.reason})`
        );
        return {
          txHash: tx.hash,
          ledger: tx.ledger,
          status: "failed",
          buyerAddress: record.buyerAddress,
          refundedAmount: "0",
          remainingAmount: remaining.toString(),
        };
      }

      const newRemaining = remaining - requested;
      const updated = await incrementPaymentRecordAmounts(record.id, {
        refundedDelta: params.amountStroops,
        // Only flip to the terminal "refunded" status once nothing is left and
        // nothing was ever released — a mixed release+refund history is left
        // as "disputed"/"funded" for the caller (dispute resolution) to finalize.
        status: newRemaining === 0n && record.releasedAmountStroops === "0" ? "refunded" : undefined,
      });
      await emitStatusEvent("payment:partial_refunded", updated, tx.hash, params.reason);

      return {
        txHash: tx.hash,
        ledger: tx.ledger,
        status: "partial_refunded",
        buyerAddress: record.buyerAddress,
        refundedAmount: params.amountStroops,
        remainingAmount: newRemaining.toString(),
      };
    } catch (err) {
      if (err instanceof InsufficientEscrowBalanceError) throw err;
      const message = err instanceof Error ? err.message : "Unknown partial refund error";
      log.error("Escrow partial refund failed", { escrowId: params.escrowId, error: message });
      const updated = await updatePaymentRecord(record.id, {
        status: "failed",
        failureReason: message,
      });
      await emitStatusEvent("payment:failed", updated, undefined, message);
      return {
        txHash: "",
        ledger: 0,
        status: "failed",
        buyerAddress: record.buyerAddress,
        refundedAmount: "0",
        remainingAmount: remaining.toString(),
      };
    }
  },

  async partialReleaseEscrow(params: PartialReleaseEscrowParams): Promise<PartialReleaseResult> {
    const record = await findPaymentRecordByEscrowId(params.escrowId);
    if (!record) {
      throw new Error(`Payment record not found for escrow ${params.escrowId}`);
    }

    const remaining = computeRemaining(record);
    const requested = BigInt(params.amountStroops);
    if (requested <= 0n || requested > remaining) {
      throw new InsufficientEscrowBalanceError(params.escrowId, remaining.toString(), params.amountStroops);
    }

    await updatePaymentRecord(record.id, { failureReason: null });

    try {
      const tx = await submitContractInvocationWithRetry({
        sourceAddress: params.callerAddress,
        contractId: params.escrowContractId,
        method: "partial_release",
        args: [parseEscrowId(params.escrowId), params.callerAddress, params.amountStroops],
        memo: params.memo ?? `Partial release escrow ${params.escrowId}`,
      });

      if (!tx.success) {
        const updated = await updatePaymentRecord(record.id, {
          status: "failed",
          failureReason: "Partial release transaction failed on-chain",
        });
        await emitStatusEvent("payment:failed", updated, tx.hash, "Partial release transaction failed on-chain");
        return {
          txHash: tx.hash,
          ledger: tx.ledger,
          status: "failed",
          sellerAddress: record.sellerAddress,
          releasedAmount: "0",
          remainingAmount: remaining.toString(),
        };
      }

      const newRemaining = remaining - requested;
      const updated = await incrementPaymentRecordAmounts(record.id, {
        releasedDelta: params.amountStroops,
        status: newRemaining === 0n && record.refundedAmountStroops === "0" ? "released" : undefined,
      });
      await emitStatusEvent("payment:partial_released", updated, tx.hash);

      return {
        txHash: tx.hash,
        ledger: tx.ledger,
        status: "partial_released",
        sellerAddress: record.sellerAddress,
        releasedAmount: params.amountStroops,
        remainingAmount: newRemaining.toString(),
      };
    } catch (err) {
      if (err instanceof InsufficientEscrowBalanceError) throw err;
      const message = err instanceof Error ? err.message : "Unknown partial release error";
      log.error("Escrow partial release failed", { escrowId: params.escrowId, error: message });
      const updated = await updatePaymentRecord(record.id, {
        status: "failed",
        failureReason: message,
      });
      await emitStatusEvent("payment:failed", updated, undefined, message);
      return {
        txHash: "",
        ledger: 0,
        status: "failed",
        sellerAddress: record.sellerAddress,
        releasedAmount: "0",
        remainingAmount: remaining.toString(),
      };
    }
  },

  async getRemainingBalance(escrowId: string): Promise<RemainingBalance> {
    const record = await findPaymentRecordByEscrowId(escrowId);
    if (!record) {
      throw new Error(`Payment record not found for escrow ${escrowId}`);
    }
    return {
      escrowId,
      orderId: record.orderId,
      buyerAddress: record.buyerAddress,
      sellerAddress: record.sellerAddress,
      totalAmount: record.amountStroops,
      releasedAmount: record.releasedAmountStroops,
      refundedAmount: record.refundedAmountStroops,
      remainingAmount: computeRemaining(record).toString(),
    };
  },

  async getEscrowStatus(escrowId: string): Promise<EscrowStatusResult> {
    const record = await findPaymentRecordByEscrowId(escrowId);
    if (record) {
      const mapped = mapRecordStatusToEscrowStatus(record.status);
      if (mapped) {
        return toEscrowStatusResult(
          escrowId,
          record.buyerAddress,
          record.sellerAddress,
          record.amountStroops,
          mapped,
          Math.floor(record.createdAt.getTime() / 1000)
        );
      }
    }

    const contractId = record?.escrowContractId ?? process.env.ESCROW_CONTRACT_ID;
    if (!contractId) {
      throw new Error("ESCROW_CONTRACT_ID is not configured");
    }

    const sourceAddress = getContractReadSourceAddress(record?.buyerAddress);
    const onChain = await readEscrowFromChain(contractId, escrowId, sourceAddress);

    return toEscrowStatusResult(
      String(onChain.escrow_id),
      onChain.buyer,
      onChain.seller,
      String(onChain.amount),
      mapChainEscrowStatus(onChain.status),
      Number(onChain.created_at)
    );
  },
};

export {
  InsufficientEscrowBalanceError,
  type DisputeEscrowParams,
  type DisputeResult,
  type EscrowCoordinator,
  type EscrowStatusResult,
  type FundEscrowParams,
  type FundEscrowResult,
  type PartialReleaseEscrowParams,
  type PartialReleaseResult,
  type PartialRefundEscrowParams,
  type PartialRefundResult,
  type RefundEscrowParams,
  type RefundResult,
  type ReleaseEscrowParams,
  type ReleaseResult,
  type RemainingBalance,
} from "./types.js";
