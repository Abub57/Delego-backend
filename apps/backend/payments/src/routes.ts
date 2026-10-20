import type { IncomingMessage, ServerResponse } from "node:http";
import {
  route,
  json,
  createHealthRoutes,
  readBodyWithLimit,
  PayloadTooLargeError,
  requireServiceAuth,
  type Route,
} from "@delegolabs/utils";
import { escrowService } from "../escrow/index.js";
import { getPaymentsHealth } from "../escrow/health.js";
import { createPaymentsHealthRegistry } from "./health.js";
import { handleDeliveryConfirmationWebhook } from "../escrow/autoSettlement.js";
import { getWebhookSecret, verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "./autoRelease/hmac.js";
import {
  extractCarrierSignature,
  getCarrierWebhookSecret,
  normalizeEasyPostEvent,
  timingSafeHmacVerify,
  validateEasyPostPayload,
} from "./webhooks/carrierWebhook.js";
import { enqueueCarrierEvent } from "./webhooks/carrierQueue.js";
import { checkWebhookReplay, extractWebhookNonce, extractWebhookTimestamp } from "./webhooks/replayGuard.js";
import { handleDeliveryConfirmation } from "./autoRelease/service.js";
import { getWebhookIdempotencyKey, runIdempotently } from "./autoRelease/idempotency.js";
import { EscrowDisputedError, EscrowNotReleasableError } from "./autoRelease/types.js";
import { registerOracleRoutes } from "./oracle/routes.js";
import { ContractInvocationError } from "../escrow/errors.js";
import { settleOrder, refundOrder } from "../settlement/index.js";
import { getEscrowFundingLockManager } from "./escrowCoordinator/escrowFundingLock.js";
import {
  acquireLock,
  releaseLock,
  validateDeliveryConfirmation,
  validateDepositRequest,
  validateEscrowContractConfig,
  validateIdempotencyKey,
  validateInitializeRequest,
  validateRefundReasonCode,
  validateRefundRequest,
  validateReleaseRequest,
  type ValidationError,
} from "./validation.js";
import { InsufficientEscrowBalanceError } from "./escrowCoordinator/index.js";
import { assignMediator, executeDecision, openDispute, submitEvidence, submitMediationDecision } from "./disputes/mediation.js";
import { runAutoMediation, type AutoMediationInput } from "./disputes/mediator.js";
import { runTimeoutRefundSweep } from "./workers/timeoutRefund.js";
import { executePartialRefund, InvalidPartialRefundAmountError } from "./disputes/partialRefund.js";
import { getDisputeStore } from "./disputes/disputeStore.js";
import { checkOrderAccess, extractRequesterAddress, extractRequesterRole } from "./disputes/accessControl.js";
import { findPaymentRecordByEscrowId } from "./escrowCoordinator/paymentRecordStore.js";
import { listAuditLogForDispute } from "./disputes/auditLog.js";
import {
  DisputeAlreadyResolvedError,
  DisputeNotFoundError,
  InvalidResolutionAmountsError,
  InvalidStateTransitionError,
} from "./disputes/types.js";
import {
  validateAssignMediatorRequest,
  validateMediationDecision,
  validateOpenDisputeRequest,
  validatePartialRefundRequest,
  validateSubmitEvidenceRequest,
} from "./disputes/validation.js";
import {
  cancelSubscription,
  changeSubscriptionPlan,
  createSubscription,
  createSubscriptionPlan,
  getSubscription,
  getSubscriptionPlan,
  pauseSubscription,
  renewSubscription,
  resumeSubscription,
} from "./subscriptions/service.js";
import {
  SubscriptionNotActiveError,
  SubscriptionNotFoundError,
  SubscriptionPlanNotFoundError,
  UnsupportedPaymentMethodError,
} from "./subscriptions/types.js";
import {
  validateCancelSubscriptionRequest,
  validateChangePlanRequest,
  validateCreatePlanRequest,
  validateCreateSubscriptionRequest,
  validateRenewRequest,
} from "./subscriptions/validation.js";
import { registerShipment, getShipment, type RegisterShipmentDTO } from "./shipping/service.js";
import { validateRegisterShipment } from "./shipping/validation.js";
import {
  reserveStock,
  releaseReservation,
  getAvailableStock,
  validateReserveStockRequest,
  validateReservationId,
} from "./inventory/index.js";
import { initiatePayout, validateInitiatePayoutRequest } from "./payouts/index.js";
import {
  createDisbursementApproval,
  collectOfficerSignature,
  getDisbursementState,
  submitDisbursementApproval,
  listDisbursements,
  expireStaleDisbursements,
  DisbursementNotFoundError,
  OfficerNotAuthorizedError,
  DuplicateSignatureError,
  InvalidSignatureError,
  DisbursementClosedError,
  type CreateDisbursementApprovalInput,
  type SubmitOfficerSignatureInput,
} from "./disbursementApproval.js";
import {
  getExchangeRate,
  getExchangeRateHealth,
  refreshRate,
  ExchangeRateUnavailableError,
} from "./exchangeRate/index.js";
import { CircuitBreakerOpenError } from "./exchangeRate/circuitBreaker.js";

const paymentsHealthRegistry = createPaymentsHealthRegistry();
const requireOrchestratorServiceAuth = requireServiceAuth({
  envVar: "ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN",
});

// Body is capped at 1MB (see readBodyWithLimit) — an oversized body rejects
// with PayloadTooLargeError, which callers handle by responding 413.
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBodyWithLimit(req);
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", (err) => reject(err));
  });
}

function validationStatusCode(code: string): number {
  return code === "CONFIG_ERROR" ? 503 : 400;
}

function sendValidationError(res: ServerResponse, error: ValidationError): void {
  json(res, validationStatusCode(error.code), { data: null, error });
}

function sendPayloadTooLargeError(res: ServerResponse, err: PayloadTooLargeError): void {
  json(res, 413, {
    data: null,
    error: { code: "PAYLOAD_TOO_LARGE", message: err.message },
  });
}

function sendOperationError(res: ServerResponse, code: string, err: unknown): void {
  json(res, 400, {
    data: null,
    error: {
      code,
      message: err instanceof Error ? err.message : "Unknown error",
    },
  });
}

function sendContractError(res: ServerResponse, err: ContractInvocationError): void {
  const status = err.retryable ? 503 : 422;
  json(res, status, {
    data: null,
    error: {
      code: err.code,
      message: err.message,
      txHash: err.txHash ?? null,
    },
  });
}

function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? "";
    return code === "23505" || message.includes("duplicate key") || message.includes("unique constraint");
  }
  return false;
}

/**
 * Maps the typed errors thrown by the disputes/partial-refund service layer
 * to HTTP status codes. Returns `true` if `err` was handled (a response was
 * sent), `false` otherwise so the caller can fall back to a generic 400/500.
 */
function sendDisputeError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof InsufficientEscrowBalanceError) {
    json(res, 400, {
      data: null,
      error: {
        code: "INSUFFICIENT_ESCROW_BALANCE",
        message: err.message,
        details: { escrowId: err.escrowId, remainingAmount: err.remainingAmount, requestedAmount: err.requestedAmount },
      },
    });
    return true;
  }
  if (err instanceof InvalidPartialRefundAmountError || err instanceof InvalidResolutionAmountsError) {
    json(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: err.message } });
    return true;
  }
  if (err instanceof DisputeNotFoundError) {
    json(res, 404, { data: null, error: { code: "DISPUTE_NOT_FOUND", message: err.message } });
    return true;
  }
  if (err instanceof DisputeAlreadyResolvedError) {
    json(res, 409, { data: null, error: { code: "DISPUTE_ALREADY_RESOLVED", message: err.message } });
    return true;
  }
  if (err instanceof InvalidStateTransitionError) {
    json(res, 409, {
      data: null,
      error: { code: "INVALID_STATE_TRANSITION", message: err.message, details: { from: err.from, to: err.to } },
    });
    return true;
  }
  return false;
}

/** Maps typed errors from the subscriptions service layer to HTTP status codes. */
function sendSubscriptionError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof SubscriptionPlanNotFoundError) {
    json(res, 404, { data: null, error: { code: "SUBSCRIPTION_PLAN_NOT_FOUND", message: err.message } });
    return true;
  }
  if (err instanceof SubscriptionNotFoundError) {
    json(res, 404, { data: null, error: { code: "SUBSCRIPTION_NOT_FOUND", message: err.message } });
    return true;
  }
  if (err instanceof SubscriptionNotActiveError) {
    json(res, 409, {
      data: null,
      error: { code: "SUBSCRIPTION_NOT_ACTIVE", message: err.message, details: { status: err.status } },
    });
    return true;
  }
  if (err instanceof UnsupportedPaymentMethodError) {
    json(res, 400, { data: null, error: { code: "UNSUPPORTED_PAYMENT_METHOD", message: err.message } });
    return true;
  }
  return false;
}

async function ensureContractConfig(res: ServerResponse): Promise<boolean> {
  const config = validateEscrowContractConfig();
  if (!config.ok) {
    sendValidationError(res, config.error);
    return false;
  }
  return true;
}

export function registerRoutes(): Route[] {
  return [
    ...registerOracleRoutes(),
    route("GET", "/health", (_req, res) => {
      json(res, 200, { status: "ok", timestamp: new Date().toISOString() });
    }),
    ...createHealthRoutes({
      registry: paymentsHealthRegistry,
      serviceName: "payments",
      version: "0.0.1",
    }),

    route("GET", "/escrow/health", async (_req, res) => {
      const health = await getPaymentsHealth();
      json(res, 200, { data: health, error: null });
    }),

    route("POST", "/escrow/initialize", async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateInitializeRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        const result = await escrowService.initialize(validated.value);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        if (err instanceof ContractInvocationError) {
          sendContractError(res, err);
          return;
        }
        sendOperationError(res, "ESCROW_INITIALIZE_FAILED", err);
      }
    }),

    route("POST", "/escrow/deposit", async (req, res) => {
      let serviceAuthenticated = false;
      requireOrchestratorServiceAuth(req, res, () => {
        serviceAuthenticated = true;
      });
      if (!serviceAuthenticated) return;

      const authenticatedUserId = req.headers["x-delego-user-id"];
      if (typeof authenticatedUserId !== "string" || authenticatedUserId.trim().length === 0) {
        sendValidationError(res, {
          code: "VALIDATION_ERROR",
          message: "X-Delego-User-Id header is required",
        });
        return;
      }
      (req as IncomingMessage & { userId?: string }).userId = authenticatedUserId;

      let lockedOrderId: string | undefined;
      try {
        const idempotency = validateIdempotencyKey(req.headers as Record<string, string | string[] | undefined>, "/escrow/deposit");
        if (!idempotency.ok) {
          sendValidationError(res, idempotency.error);
          return;
        }
        const body = await readJsonBody(req);
        const validated = validateDepositRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        if (validated.value.orderId) {
          lockedOrderId = validated.value.orderId;
          const acquired = await acquireLock(lockedOrderId);
          if (!acquired) {
            json(res, 409, {
              data: null,
              error: {
                code: "DUPLICATE_FUNDING_REQUEST",
                message: `Escrow deposit is already in progress for order ${lockedOrderId}`,
                details: { orderId: lockedOrderId },
              },
            });
            return;
          }
        }

        const result = await escrowService.deposit({
          ...validated.value,
          userId: (req as IncomingMessage & { userId?: string }).userId,
        });
        json(res, 200, { data: result, error: null });
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        if (isDuplicateKeyError(err)) {
          json(res, 409, {
            data: null,
            error: {
              code: "DUPLICATE_FUNDING_REQUEST",
              message: "Escrow deposit record already exists for this order",
              details: { orderId: lockedOrderId },
            },
          });
          return;
        }
        if (err instanceof ContractInvocationError) {
          sendContractError(res, err);
          return;
        }
        sendOperationError(res, "ESCROW_DEPOSIT_FAILED", err);
      } finally {
        if (lockedOrderId) {
          await releaseLock(lockedOrderId);
        }
      }
    }),


    route("POST", "/escrow/:escrowId/release", async (req, res, params) => {
      try {
        const idempotency = validateIdempotencyKey(req.headers as Record<string, string | string[] | undefined>, "/escrow/:escrowId/release");
        if (!idempotency.ok) {
          sendValidationError(res, idempotency.error);
          return;
        }
        const body = await readJsonBody(req);
        const validated = validateReleaseRequest(body, params.escrowId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        const result = await escrowService.release(validated.value);
        json(res, 200, { data: result, error: null });
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        if (err instanceof ContractInvocationError) {
          sendContractError(res, err);
          return;
        }
        sendOperationError(res, "ESCROW_RELEASE_FAILED", err);
      }
    }),

    route("POST", "/escrow/:escrowId/refund", async (req, res, params) => {
      try {
        const idempotency = validateIdempotencyKey(req.headers as Record<string, string | string[] | undefined>, "/escrow/:escrowId/refund");
        if (!idempotency.ok) {
          sendValidationError(res, idempotency.error);
          return;
        }
        const body = await readJsonBody(req);
        const validated = validateRefundRequest(body, params.escrowId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        const result = await escrowService.refund(validated.value);
        json(res, 200, {
          data: {
            ...result,
            refundReasonCode: validated.value.refundReasonCode,
          },
          error: null,
        });

      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        if (err instanceof ContractInvocationError) {
          sendContractError(res, err);
          return;
        }
        sendOperationError(res, "ESCROW_REFUND_FAILED", err);
      }
    }),

    // Issue #35 — order-level escrow compensation, called by the orchestrator's
    // saga compensation steps (which only know orderId, not escrowId). Both
    // settleOrder/refundOrder are idempotent per orderId via payment_records.status,
    // so a retried compensation call safely returns the previously recorded outcome
    // instead of re-invoking the contract.
    route("POST", "/api/v1/orders/:orderId/release", async (_req, res, params) => {
      try {
        const outcome = await settleOrder(params.orderId);
        const status = outcome.status === "failed" ? 502 : 200;
        json(res, status, {
          data: outcome,
          error: outcome.status === "failed" ? { code: "ORDER_RELEASE_FAILED", message: outcome.reason ?? "Release failed" } : null,
        });
      } catch (err) {
        sendOperationError(res, "ORDER_RELEASE_FAILED", err);
      }
    }),

    route("POST", "/api/v1/orders/:orderId/refund", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const reasonValidation = validateRefundReasonCode(body);
        if (!reasonValidation.ok) {
          sendValidationError(res, reasonValidation.error);
          return;
        }

        const outcome = await refundOrder(params.orderId, reasonValidation.value);
        const status = outcome.status === "failed" ? 502 : 200;
        json(res, status, {
          data: outcome,
          error: outcome.status === "failed" ? { code: "ORDER_REFUND_FAILED", message: outcome.reason ?? "Refund failed" } : null,
        });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        sendOperationError(res, "ORDER_REFUND_FAILED", err);
      }
    }),

    // Issue #363 — delivery-confirmation webhook auto-triggers escrow release.
    //
    // Issue #24/#445 — this endpoint accepted the webhook with no signature
    // verification at all: anyone who could reach it could forge a delivery
    // confirmation and trigger escrow release. Verified the same way as
    // /escrow/:escrowId/delivery-confirmed (issue #45) — HMAC-SHA256 over the
    // raw body, constant-time comparison, via hmac.ts — reusing that route's
    // ESCROW_WEBHOOK_SECRET since both endpoints sit in the same trust
    // domain (a delivery-confirmation webhook driving escrow release).
    route("POST", "/webhooks/delivery-confirmation", async (req, res) => {
      try {
        const rawBody = await readRawBody(req);

        const secret = getWebhookSecret();
        if (!secret) {
          json(res, 503, {
            data: null,
            error: { code: "CONFIG_ERROR", message: "ESCROW_WEBHOOK_SECRET is not configured" },
          });
          return;
        }

        const signatureHeaderRaw =
          req.headers[WEBHOOK_SIGNATURE_HEADER] ?? req.headers["x-webhook-signature"] ?? req.headers["x-hub-signature-256"];
        const signatureHeader = Array.isArray(signatureHeaderRaw) ? signatureHeaderRaw[0] : signatureHeaderRaw;

        if (!verifyWebhookSignature(rawBody, signatureHeader, secret)) {
          json(res, 401, {
            data: null,
            error: { code: "UNAUTHORIZED", message: "Invalid or missing webhook signature" },
          });
          return;
        }

        let body: Record<string, unknown>;
        try {
          body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        } catch {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }

        // Issue #352 — timestamp tolerance + nonce replay protection, on top
        // of the HMAC signature check above (a valid signature alone
        // doesn't stop an intercepted request being replayed indefinitely).
        const replayCheck = await checkWebhookReplay("delivery-confirmation", {
          timestamp: extractWebhookTimestamp(req.headers as Record<string, string | string[] | undefined>),
          nonce: extractWebhookNonce(req.headers as Record<string, string | string[] | undefined>),
        });
        if (!replayCheck.ok) {
          json(res, 400, {
            data: null,
            error: { code: replayCheck.code ?? "REPLAY_REJECTED", message: replayCheck.message },
          });
          return;
        }

        const { webhookId, orderId, escrowId, escrowContractId, callerAddress, confirmedAt } = body;

        if (
          typeof webhookId !== "string" ||
          !webhookId ||
          typeof orderId !== "string" ||
          !orderId ||
          typeof escrowId !== "string" ||
          !escrowId ||
          typeof escrowContractId !== "string" ||
          !escrowContractId ||
          typeof callerAddress !== "string" ||
          !callerAddress
        ) {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message:
              "webhookId, orderId, escrowId, escrowContractId, and callerAddress are required",
          });
          return;
        }

        const result = await handleDeliveryConfirmationWebhook({
          webhookId,
          orderId,
          escrowId,
          escrowContractId,
          callerAddress,
          confirmedAt: typeof confirmedAt === "string" ? confirmedAt : new Date().toISOString(),
        });

        json(res, result.status === "failed" ? 502 : 200, { data: result, error: null });
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        sendOperationError(res, "DELIVERY_WEBHOOK_FAILED", err);
      }
    }),

    // ─── Issue #46 — Partial Refunds & Dispute Mediation ────────────────────

    route("POST", "/escrow/:escrowId/partial-refund", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validatePartialRefundRequest(body, params.escrowId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        const outcome = await executePartialRefund(validated.value);
        json(res, outcome.success ? 200 : 502, { data: outcome, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "PARTIAL_REFUND_FAILED", err);
      }
    }),

    route("POST", "/escrow/:escrowId/disputes", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateOpenDisputeRequest(body, params.escrowId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const dispute = await openDispute(validated.value);
        json(res, 201, { data: dispute, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_OPEN_FAILED", err);
      }
    }),

    // Issue #350 — IDOR mitigation: verify the requester is actually a
    // party to the dispute's underlying order before returning it.
    route("GET", "/disputes/:disputeId", async (req, res, params) => {
      const dispute = await getDisputeStore().findById(params.disputeId);
      if (!dispute) {
        json(res, 404, { data: null, error: { code: "DISPUTE_NOT_FOUND", message: `Dispute ${params.disputeId} not found` } });
        return;
      }

      const requesterAddress = extractRequesterAddress(
        req.headers as Record<string, string | string[] | undefined>
      );
      // Only hit the payment-record store once we actually have an
      // authenticated identity to check — callers that don't send one yet
      // (not migrated to the gateway's identity header) are unaffected.
      if (requesterAddress) {
        const requesterRole = extractRequesterRole(
          req.headers as Record<string, string | string[] | undefined>
        );
        const paymentRecord = dispute.escrowId
          ? await findPaymentRecordByEscrowId(dispute.escrowId)
          : null;
        const access = checkOrderAccess(paymentRecord, requesterAddress, requesterRole);
        if (!access.ok) {
          json(res, 403, {
            data: null,
            error: { code: "FORBIDDEN", message: "You do not have access to this dispute" },
          });
          return;
        }
      }

      const auditLog = await listAuditLogForDispute(params.disputeId);
      json(res, 200, { data: { ...dispute, auditLog }, error: null });
    }),

    route("POST", "/disputes/:disputeId/evidence", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateSubmitEvidenceRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const dispute = await submitEvidence(params.disputeId, validated.value);
        json(res, 200, { data: dispute, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_EVIDENCE_FAILED", err);
      }
    }),

    route("POST", "/disputes/:disputeId/mediator", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateAssignMediatorRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const dispute = await assignMediator(params.disputeId, validated.value.mediator, validated.value.assignedBy);
        json(res, 200, { data: dispute, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_MEDIATOR_ASSIGN_FAILED", err);
      }
    }),

    route("POST", "/disputes/:disputeId/decision", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateMediationDecision(body, params.disputeId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }
        if (!(await ensureContractConfig(res))) return;

        const dispute = await submitMediationDecision(validated.value);
        json(res, 200, { data: dispute, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_DECISION_FAILED", err);
      }
    }),

    // Retries executing an already-recorded decision (e.g. after a transient
    // Soroban failure left the dispute in "decided" rather than "resolved").
    route("POST", "/disputes/:disputeId/decision/retry", async (_req, res, params) => {
      try {
        if (!(await ensureContractConfig(res))) return;
        const dispute = await executeDecision(params.disputeId);
        json(res, 200, { data: dispute, error: null });
      } catch (err) {
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_DECISION_RETRY_FAILED", err);
      }
    }),

    // Issue #296 — Automated Dispute Mediation & Rule-Based Arbitration Engine
    // POST /disputes/:disputeId/auto-mediate
    // Runs the rule engine on the dispute and auto-executes if confident,
    // or escalates to human arbitration when evidence is ambiguous.
    route("POST", "/disputes/:disputeId/auto-mediate", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const tracking = body.tracking as AutoMediationInput["tracking"] | undefined;
        const partialRefundOffer = body.partialRefundOffer as AutoMediationInput["partialRefundOffer"] | undefined;

        const decision = await runAutoMediation({
          disputeId: params.disputeId,
          tracking,
          partialRefundOffer,
        });

        json(res, 200, { data: decision, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendDisputeError(res, err)) return;
        sendOperationError(res, "DISPUTE_AUTO_MEDIATION_FAILED", err);
      }
    }),

    // Issue #45 — HMAC-verified delivery-confirmation webhook driving escrow auto-release.
    route("POST", "/escrow/:escrowId/delivery-confirmed", async (req, res, params) => {
      try {
        const idempotencyKey = getWebhookIdempotencyKey(req.headers["x-idempotency-key"]);
        if (!idempotencyKey) {
          json(res, 400, {
            data: null,
            error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "X-Idempotency-Key header is required" },
          });
          return;
        }

        const rawBody = await readRawBody(req);

        const secret = getWebhookSecret();
        if (!secret) {
          json(res, 503, {
            data: null,
            error: { code: "CONFIG_ERROR", message: "ESCROW_WEBHOOK_SECRET is not configured" },
          });
          return;
        }

        const signatureHeaderRaw =
          req.headers[WEBHOOK_SIGNATURE_HEADER] ?? req.headers["x-hub-signature-256"];
        const signatureHeader = Array.isArray(signatureHeaderRaw) ? signatureHeaderRaw[0] : signatureHeaderRaw;

        if (!verifyWebhookSignature(rawBody, signatureHeader, secret)) {
          json(res, 401, {
            data: null,
            error: { code: "UNAUTHORIZED", message: "Invalid or missing webhook signature" },
          });
          return;
        }

        // Issue #352 — timestamp tolerance + nonce replay protection, on top
        // of the X-Idempotency-Key based response caching below (which
        // already makes a retried request with the same key safe to
        // resend, but doesn't bound how stale a request can be, nor dedupe
        // across a *different* idempotency key replaying the same nonce).
        const replayCheck = await checkWebhookReplay("escrow-delivery-confirmed", {
          timestamp: extractWebhookTimestamp(req.headers as Record<string, string | string[] | undefined>),
          nonce: extractWebhookNonce(req.headers as Record<string, string | string[] | undefined>),
        });
        if (!replayCheck.ok) {
          json(res, 400, {
            data: null,
            error: { code: replayCheck.code ?? "REPLAY_REJECTED", message: replayCheck.message },
          });
          return;
        }

        let body: Record<string, unknown>;
        try {
          body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        } catch {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }

        const validated = validateDeliveryConfirmation(body, params.escrowId);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const response = await runIdempotently(
          `delivery-confirmed:${params.escrowId}:${idempotencyKey}`,
          async () => {
            const result = await handleDeliveryConfirmation(validated.value, signatureHeader);
            if ("scheduled" in result) return { status: 202, body: { data: result, error: null } };
            return { status: result.success ? 200 : 502, body: { data: result, error: null } };
          },
        );

        json(res, response.status, response.body);
      } catch (err) {
        if (err instanceof EscrowDisputedError) {
          json(res, 409, { data: null, error: { code: "ESCROW_DISPUTED", message: err.message } });
          return;
        }
        if (err instanceof EscrowNotReleasableError) {
          json(res, 400, { data: null, error: { code: "ESCROW_NOT_RELEASABLE", message: err.message } });
          return;
        }
        sendOperationError(res, "DELIVERY_CONFIRMED_WEBHOOK_FAILED", err);
      }
    }),

    // ─── Issue #47 — Recurring Payment Subscriptions with Escrow ────────────

    route("POST", "/subscriptions/plans", async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateCreatePlanRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const plan = await createSubscriptionPlan(validated.value);
        json(res, 201, { data: plan, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        sendOperationError(res, "SUBSCRIPTION_PLAN_CREATE_FAILED", err);
      }
    }),

    route("GET", "/subscriptions/plans/:planId", async (_req, res, params) => {
      try {
        const plan = await getSubscriptionPlan(params.planId);
        json(res, 200, { data: plan, error: null });
      } catch (err) {
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_PLAN_FETCH_FAILED", err);
      }
    }),

    route("POST", "/subscriptions", async (req, res) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateCreateSubscriptionRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const subscription = await createSubscription(validated.value);
        json(res, 201, { data: subscription, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_CREATE_FAILED", err);
      }
    }),

    route("GET", "/subscriptions/:subscriptionId", async (_req, res, params) => {
      try {
        const subscription = await getSubscription(params.subscriptionId);
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_FETCH_FAILED", err);
      }
    }),

    route("POST", "/subscriptions/:subscriptionId/pause", async (_req, res, params) => {
      try {
        const subscription = await pauseSubscription(params.subscriptionId);
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_PAUSE_FAILED", err);
      }
    }),

    route("POST", "/subscriptions/:subscriptionId/resume", async (_req, res, params) => {
      try {
        const subscription = await resumeSubscription(params.subscriptionId);
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_RESUME_FAILED", err);
      }
    }),

    route("POST", "/subscriptions/:subscriptionId/cancel", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateCancelSubscriptionRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const subscription = await cancelSubscription(params.subscriptionId, validated.value);
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_CANCEL_FAILED", err);
      }
    }),

    route("PATCH", "/subscriptions/:subscriptionId/plan", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateChangePlanRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const subscription = await changeSubscriptionPlan(params.subscriptionId, validated.value.planId);
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_PLAN_CHANGE_FAILED", err);
      }
    }),

    // Manual/forced renewal — also what the billing scheduler calls internally.
    route("POST", "/subscriptions/:subscriptionId/renew", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        const validated = validateRenewRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const subscription = await renewSubscription(params.subscriptionId, { ...validated.value, force: true });
        json(res, 200, { data: subscription, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }
        if (sendSubscriptionError(res, err)) return;
        sendOperationError(res, "SUBSCRIPTION_RENEW_FAILED", err);
      }
    }),

    // Issue #147 — Lock metrics and optimization endpoints
    route("GET", "/escrow/lock/metrics", async (_req, res) => {
      const lockManager = getEscrowFundingLockManager();
      const metrics = lockManager.getMetrics("global");
      const globalContention = lockManager.getGlobalContentionRatio();
      json(res, 200, {
        data: {
          globalContentionRatio: globalContention,
          metrics,
        },
        error: null,
      });
    }),

    route("GET", "/escrow/lock/optimize", async (_req, res) => {
      const lockManager = getEscrowFundingLockManager();
      const optimization = lockManager.optimizeConfig();
      json(res, 200, { data: optimization, error: null });
    }),

    // ─── Issue #291 — Carrier Tracking Webhook Receiver (EasyPost) ─────────
    // POST /api/v1/webhooks/carriers/easypost
    // Verifies HMAC-SHA256 over the raw body, validates + normalizes the
    // EasyPost tracker.updated payload, and enqueues it for async BullMQ
    // processing. Responds 200 immediately (never awaits the worker) so
    // carriers get an ack well within 500ms. Redeliveries dedupe on
    // payload id via the queue jobId.
    route("POST", "/api/v1/webhooks/carriers/easypost", async (req, res) => {
      try {
        const rawBody = await readRawBody(req);

        const secret = getCarrierWebhookSecret();
        if (!secret) {
          json(res, 503, {
            data: null,
            error: { code: "CONFIG_ERROR", message: "EASYPOST_WEBHOOK_SECRET is not configured" },
          });
          return;
        }

        const signature = extractCarrierSignature(
          req.headers as Record<string, string | string[] | undefined>
        );
        // Issue #351: strictly timing-safe comparison via crypto.timingSafeEqual
        // (carrier-specific — see timingSafeHmacVerify in carrierWebhook.ts).
        if (!signature || !timingSafeHmacVerify(rawBody, secret, signature)) {
          json(res, 401, {
            data: null,
            error: { code: "UNAUTHORIZED", message: "Invalid or missing webhook signature" },
          });
          return;
        }

        let parsed: unknown;
        try {
          parsed = rawBody ? (JSON.parse(rawBody) as unknown) : {};
        } catch {
          sendValidationError(res, { code: "VALIDATION_ERROR", message: "Invalid JSON body" });
          return;
        }

        const validated = validateEasyPostPayload(parsed);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        // Issue #352 — timestamp tolerance + nonce replay protection, on top
        // of the HMAC signature check above. EasyPost's own `id` already
        // drives at-most-once queue processing via the BullMQ jobId
        // (see enqueueCarrierEvent), and EasyPost legitimately redelivers
        // the same id on retry — expecting a 200 ack each time — so this
        // only enforces the Redis-backed nonce dedupe for carriers that
        // send a dedicated X-Webhook-Nonce header.
        const replayCheck = await checkWebhookReplay("carrier-easypost", {
          timestamp: extractWebhookTimestamp(req.headers as Record<string, string | string[] | undefined>),
          nonce: extractWebhookNonce(req.headers as Record<string, string | string[] | undefined>),
        });
        if (!replayCheck.ok) {
          json(res, 400, {
            data: null,
            error: { code: replayCheck.code ?? "REPLAY_REJECTED", message: replayCheck.message },
          });
          return;
        }

        const event = normalizeEasyPostEvent(validated.value);
        await enqueueCarrierEvent(event);

        json(res, 200, {
          data: { received: true, id: event.eventId, trackingCode: event.trackingCode, status: event.status },
          error: null,
        });
      } catch (err) {
        sendOperationError(res, "CARRIER_WEBHOOK_FAILED", err);
      }
    }),

    // ─── Issue #297 — Timeout Refund Worker for Stalled Escrows ─────────────
    // POST /workers/timeout-refund/sweep
    // Triggers an on-demand sweep of timed-out funded escrows and submits
    // Soroban refund() transactions. Idempotent — skips disputed/released escrows.
    route("POST", "/workers/timeout-refund/sweep", async (_req, res) => {
      try {
        const result = await runTimeoutRefundSweep();
        json(res, 200, { data: result, error: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Timeout refund sweep failed";
        json(res, 503, {
          data: null,
          error: { code: "TIMEOUT_REFUND_SWEEP_FAILED", message },
        });
      }
    }),

    // ─── Shipment Registration Endpoint (Issue #XX) ─────────────────────────
    // POST /api/v1/merchant/orders/:orderId/shipment
    // Accepts merchant-submitted tracking numbers and registers with EasyPost/carrier
    route("POST", "/api/v1/merchant/orders/:orderId/shipment", async (req, res, params) => {
      try {
        const body = await readJsonBody(req);
        
        // Validate request body
        const validated = validateRegisterShipment(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const dto: RegisterShipmentDTO = {
          orderId: params.orderId,
          carrier: validated.value.carrier,
          trackingNumber: validated.value.trackingNumber,
        };

        // Register the shipment
        const result = await registerShipment(dto);

        if (!result.ok) {
          // Handle carrier-specific validation errors
          if (result.error.code === "INVALID_TRACKING_NUMBER") {
            json(res, 400, {
              data: null,
              error: {
                code: "INVALID_TRACKING_NUMBER",
                message: result.error.message,
                details: result.error.details,
              },
            });
            return;
          }
          // Handle EasyPost/Carrier API errors
          json(res, 502, {
            data: null,
            error: {
              code: result.error.code,
              message: result.error.message,
              details: result.error.details,
            },
          });
          return;
        }

        json(res, 201, {
          data: result.response,
          error: null,
        });
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        sendOperationError(res, "SHIPPING_REGISTRATION_FAILED", err);
      }
    }),

    // GET /api/v1/merchant/orders/:orderId/shipment
    // Retrieve shipment registration status
    route("GET", "/api/v1/merchant/orders/:orderId/shipment", async (_req, res, params) => {
      try {
        const shipment = getShipment(params.orderId);
        if (!shipment) {
          json(res, 404, {
            data: null,
            error: {
              code: "SHIPMENT_NOT_FOUND",
              message: `No shipment found for order ${params.orderId}`,
            },
          });
          return;
        }

        json(res, 200, {
          data: shipment,
          error: null,
        });
      } catch (err) {
        sendOperationError(res, "SHIPPING_FETCH_FAILED", err);
      }
    }),

    // ─── Inventory Reservation Endpoints (Issue #XX) ────────────────────────

    // POST /api/v1/inventory/reserve
    // Reserve stock for an order (escrow is proposed/funding is expected)
    route("POST", "/api/v1/inventory/reserve", async (req, res) => {
      try {
        const body = await readJsonBody(req);

        const validated = validateReserveStockRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const { productId, quantity, orderId, ttlMs } = validated.value;

        // Seed stock if not exists (optional, for demo purposes)
        // await seedStock(productId, 1000);

        const result = await reserveStock(productId, quantity, orderId, ttlMs);

        json(res, 201, {
          data: result,
          error: null,
        });
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        // InsufficientStockError maps to 409 Conflict
        if (err instanceof Error && (err as any).name === "InsufficientStockError") {
          json(res, 409, {
            data: null,
            error: {
              code: "INSUFFICIENT_STOCK",
              message: err instanceof Error ? err.message : "Insufficient stock",
            },
          });
          return;
        }
        sendOperationError(res, "INVENTORY_RESERVE_FAILED", err);
      }
    }),

    // POST /api/v1/inventory/reservations/:reservationId/release
    // Explicitly release a reservation (called after escrow is funded)
    route("POST", "/api/v1/inventory/reservations/:reservationId/release", async (_req, res, params) => {
      try {
        const validatedId = validateReservationId(params.reservationId);
        if (!validatedId.ok) {
          sendValidationError(res, validatedId.error);
          return;
        }
        const reservationId = validatedId.value;

        const result = await releaseReservation(reservationId, { strict: false });

        if (result.quantityRestored === 0) {
          json(res, 200, {
            data: result,
            error: null,
          });
        } else {
          json(res, 200, {
            data: result,
            error: null,
          });
        }
      } catch (err) {
        if (err instanceof Error && (err as any).name === "ReservationNotFoundError") {
          json(res, 404, {
            data: null,
            error: {
              code: "RESERVATION_NOT_FOUND",
              message: err instanceof Error ? err.message : "Reservation not found",
            },
          });
          return;
        }
        sendOperationError(res, "INVENTORY_RELEASE_FAILED", err);
      }
    }),

    // GET /api/v1/inventory/stock/:productId
    // Check current available stock
    route("GET", "/api/v1/inventory/stock/:productId", async (_req, res, params) => {
      try {
        const available = await getAvailableStock(params.productId);
        json(res, 200, {
          data: { productId: params.productId, available },
          error: null,
        });
      } catch (err) {
        sendOperationError(res, "INVENTORY_FETCH_FAILED", err);
      }
    }),

    // ─── Payout Endpoint (Issue #XX) ────────────────────────────────────────

    // POST /api/v1/payouts/initiate
    // Calculate platform commission and initiate escrow release
    route("POST", "/api/v1/payouts/initiate", async (req, res) => {
      try {
        const body = await readJsonBody(req);

        const validated = validateInitiatePayoutRequest(body);
        if (!validated.ok) {
          sendValidationError(res, validated.error);
          return;
        }

        const result = await initiatePayout(validated.value);

        json(res, 201, {
          data: result,
          error: null,
        });
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendPayloadTooLargeError(res, err);
          return;
        }
        if (err instanceof Error && err.message === "Invalid JSON body") {
          sendValidationError(res, {
            code: "VALIDATION_ERROR",
            message: "Invalid JSON body",
          });
          return;
        }
        // Check for common error patterns
        if (err instanceof Error && err.message.includes("not found")) {
          json(res, 404, {
            data: null,
            error: {
              code: "ESCROW_NOT_FOUND",
              message: err.message,
            },
          });
          return;
        }
        if (err instanceof Error && err.message.includes("not in funded status")) {
          json(res, 400, {
            data: null,
            error: {
              code: "INVALID_ESCROW_STATUS",
              message: err.message,
            },
          });
          return;
        }
        sendOperationError(res, "PAYOUT_INITIATION_FAILED", err);
      }
    }),

    // ─── Issue #374 — Enterprise Disbursement Multi-Sig Quorum ────────────────
    // POST   /disbursements/approvals                    – create approval request
    // GET    /disbursements/approvals                    – list all approvals
    // GET    /disbursements/approvals/:id                – get approval state
    // POST   /disbursements/approvals/:id/sign           – submit officer signature
    // POST   /disbursements/approvals/:id/submit         – manually submit when quorum met
    // POST   /disbursements/approvals/expire             – expire stale approvals

    route("POST", "/disbursements/approvals", async (req, res) => {
      try {
        const body = await readJsonBody(req) as unknown as CreateDisbursementApprovalInput;
        if (!body.disbursementId || !body.transactionXdr || !body.officers) {
          json(res, 400, {
            data: null,
            error: { code: "VALIDATION_ERROR", message: "disbursementId, transactionXdr, and officers are required" },
          });
          return;
        }
        if (!Array.isArray(body.officers) || body.officers.length < 2) {
          json(res, 400, {
            data: null,
            error: { code: "VALIDATION_ERROR", message: "At least 2 officers are required" },
          });
          return;
        }
        const approval = await createDisbursementApproval(body);
        json(res, 201, { data: approval, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          json(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } });
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        const status = message.includes("Invalid Stellar public key") ? 400 : 500;
        json(res, status, { data: null, error: { code: "DISBURSEMENT_CREATE_FAILED", message } });
      }
    }),

    route("GET", "/disbursements/approvals", async (_req, res) => {
      try {
        const approvals = listDisbursements();
        json(res, 200, { data: approvals, error: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        json(res, 500, { data: null, error: { code: "DISBURSEMENT_LIST_FAILED", message } });
      }
    }),

    route("GET", "/disbursements/approvals/:disbursementId", async (_req, res, params) => {
      try {
        const approval = getDisbursementState(params.disbursementId);
        if (!approval) {
          json(res, 404, { data: null, error: { code: "DISBURSEMENT_NOT_FOUND", message: `Disbursement ${params.disbursementId} not found` } });
          return;
        }
        json(res, 200, { data: approval, error: null });
      } catch (err) {
        if (err instanceof DisbursementNotFoundError) {
          json(res, 404, { data: null, error: { code: "DISBURSEMENT_NOT_FOUND", message: err.message } });
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        json(res, 500, { data: null, error: { code: "DISBURSEMENT_FETCH_FAILED", message } });
      }
    }),

    route("POST", "/disbursements/approvals/:disbursementId/sign", async (req, res, params) => {
      try {
        const body = await readJsonBody(req) as unknown as SubmitOfficerSignatureInput;
        if (!body.officer || !body.signature) {
          json(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: "officer and signature are required" } });
          return;
        }
        const input: SubmitOfficerSignatureInput = {
          disbursementId: params.disbursementId,
          officer: body.officer,
          signature: body.signature,
        };
        const approval = await collectOfficerSignature(input);
        json(res, 200, { data: approval, error: null });
      } catch (err) {
        if (err instanceof Error && err.message === "Invalid JSON body") {
          json(res, 400, { data: null, error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } });
          return;
        }
        if (err instanceof DisbursementNotFoundError) {
          json(res, 404, { data: null, error: { code: "DISBURSEMENT_NOT_FOUND", message: err.message } });
          return;
        }
        if (err instanceof OfficerNotAuthorizedError) {
          json(res, 403, { data: null, error: { code: "OFFICER_NOT_AUTHORIZED", message: err.message } });
          return;
        }
        if (err instanceof DuplicateSignatureError) {
          json(res, 409, { data: null, error: { code: "DUPLICATE_SIGNATURE", message: err.message } });
          return;
        }
        if (err instanceof InvalidSignatureError) {
          json(res, 400, { data: null, error: { code: "INVALID_SIGNATURE", message: err.message } });
          return;
        }
        if (err instanceof DisbursementClosedError) {
          json(res, 409, { data: null, error: { code: "DISBURSEMENT_CLOSED", message: err.message } });
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        json(res, 500, { data: null, error: { code: "SIGNATURE_COLLECTION_FAILED", message } });
      }
    }),

    route("POST", "/disbursements/approvals/:disbursementId/submit", async (_req, res, params) => {
      try {
        const approval = await submitDisbursementApproval(params.disbursementId);
        json(res, 200, { data: approval, error: null });
      } catch (err) {
        if (err instanceof DisbursementNotFoundError) {
          json(res, 404, { data: null, error: { code: "DISBURSEMENT_NOT_FOUND", message: err.message } });
          return;
        }
        if (err instanceof Error && err.message.includes("Quorum not met")) {
          json(res, 400, { data: null, error: { code: "QUORUM_NOT_MET", message: err.message } });
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        json(res, 500, { data: null, error: { code: "DISBURSEMENT_SUBMIT_FAILED", message } });
      }
    }),

    route("POST", "/disbursements/approvals/expire", async (_req, res) => {
      try {
        const expired = await expireStaleDisbursements();
        json(res, 200, { data: { expired }, error: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        json(res, 500, { data: null, error: { code: "DISBURSEMENT_EXPIRE_FAILED", message } });
      }
    }),

    // ─── Issue #379 — Automated Currency Conversion Rate Cache ─────────────
    // Fresh rates come from the Redis cache; when the oracle is unreachable
    // the cache serves the last known good rate (stale: true) instead of
    // erroring, per the Issue #379 fallback requirement.
    route("GET", "/exchange-rates/:base/:quote", async (_req, res, params) => {
      try {
        const rate = await getExchangeRate(params.base, params.quote);
        json(res, 200, { data: rate, error: null });
      } catch (err) {
        if (err instanceof ExchangeRateUnavailableError) {
          json(res, 503, {
            data: null,
            error: { code: "EXCHANGE_RATE_UNAVAILABLE", message: err.message },
          });
          return;
        }
        sendOperationError(res, "EXCHANGE_RATE_FETCH_FAILED", err);
      }
    }),

    // On-demand refresh — bypasses the cache read path and calls the oracle
    // directly (circuit-breaker protected). 502 when the oracle/circuit is down.
    route("POST", "/exchange-rates/:base/:quote/refresh", async (_req, res, params) => {
      try {
        const record = await refreshRate(params.base, params.quote);
        json(res, 200, { data: record, error: null });
      } catch (err) {
        if (err instanceof CircuitBreakerOpenError) {
          json(res, 503, {
            data: null,
            error: { code: "RATE_ORACLE_CIRCUIT_OPEN", message: err.message },
          });
          return;
        }
        sendOperationError(res, "EXCHANGE_RATE_REFRESH_FAILED", err);
      }
    }),

    // Circuit breaker stats + cache hit/miss/fallback metrics in one snapshot.
    route("GET", "/exchange-rates/health", async (_req, res) => {
      json(res, 200, { data: getExchangeRateHealth(), error: null });
    }),
  ];
}
