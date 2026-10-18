/**
 * #55 Checkout Cancellation Grace Period Timers
 * Uses BullMQ to schedule 30-minute checkout expiry and cancel incomplete orders.
 */
import { createLogger, tracedFetch } from "@delegolabs/utils";
import { Queue, Worker, type Job } from "bullmq";
import { transitionWorkflow } from "../purchase/index.js";

const log = createLogger("orchestrator:checkout", process.env.LOG_LEVEL ?? "info");

export interface CheckoutTimeoutJob {
  orderId: string;
  expiresAt: string;
  reason: "approval_timeout" | "funding_timeout" | "fulfillment_timeout";
}

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const QUEUE_NAME = "checkout-timeouts";

function redisConnection() {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return { url };
}

const isTest = process.env.NODE_ENV === "test";

const timeoutQueue = isTest
  ? null
  : new Queue<CheckoutTimeoutJob, void, string>(QUEUE_NAME, {
      connection: redisConnection() as any,
    });

// Worker processes timeout jobs
const _worker = isTest
  ? null
  : new Worker<CheckoutTimeoutJob, void, string>(
      QUEUE_NAME,
      async (job: Job<CheckoutTimeoutJob>) => {
        await handleTimeout(job.data.orderId);
      },
      { connection: redisConnection() as any }
    );

if (_worker) {
  _worker.on("failed", (job, err) => {
    log.error("Timeout job failed", { jobId: job?.id, error: err.message });
  });
}

/**
 * Schedules a 30-minute cancellation timer for the given order.
 */
export async function scheduleTimeout(
  orderId: string,
  reason: CheckoutTimeoutJob["reason"] = "approval_timeout"
): Promise<void> {
  if (isTest) {
    log.info("Mock scheduleTimeout (test mode)", { orderId, reason });
    return;
  }
  const expiresAt = new Date(Date.now() + TIMEOUT_MS).toISOString();

  await timeoutQueue!.add(
    orderId,
    { orderId, expiresAt, reason },
    {
      delay: TIMEOUT_MS,
      jobId: `timeout:${orderId}`,
      removeOnComplete: true,
      removeOnFail: false,
    }
  );

  log.info("Checkout timeout scheduled", { orderId, expiresAt, reason });
}

/**
 * Checks order status; triggers cancellation if still incomplete.
 */
export async function handleTimeout(orderId: string): Promise<void> {
  try {
    await transitionWorkflow(orderId, {
      type: "CANCEL",
      reason: "checkout_timeout",
    });
    log.info("Order cancelled due to timeout", { orderId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Invalid transition")) {
      log.info("Order already in terminal state, skipping cancellation", { orderId });
    } else {
      throw err;
    }
  }
}

/**
 * Removes a pending timeout job for a completed/cancelled order.
 */
export async function cancelTimeout(orderId: string): Promise<void> {
  if (isTest) {
    log.info("Mock cancelTimeout (test mode)", { orderId });
    return;
  }
  const job = await timeoutQueue!.getJob(`timeout:${orderId}`);
  if (job) {
    await job.remove();
    log.info("Checkout timeout cancelled", { orderId });
  }
}

/** Checkout workflow — payment confirmation via the saga coordinator */
import type { ApiResponse } from "@delegolabs/types";
import { SERVICE_AUTH_HEADER } from "@delegolabs/utils";
import { SagaCoordinator, type SagaStep } from "../../src/saga/index.js";
import type { SagaRecord, SagaStore } from "../../src/saga/index.js";
import type { DistributedLockManager } from "../../src/locks/manager.js";
import {
  getInventoryReservationService,
  type InventoryReservationItem,
} from "../../src/inventory/reservation.js";
import {
  createWorkflowCorrelationId,
  createWorkflowEventEnvelope,
  publishWorkflowEvent,
  clearPublishedWorkflowEvents,
  type WorkflowEventEnvelope,
} from "../../src/workflow-events.js";

export type CheckoutCancellationReason =
  | "user_rejected"
  | "approval_timeout"
  | "funding_failed"
  | "merchant_unavailable"
  | "system_error";

export type CheckoutState =
  | "initiated"
  | "pending_approval"
  | "approved"
  | "funding"
  | "completed"
  | "cancelled";

export interface CheckoutWorkflowEventPayload {
  fromState: CheckoutState;
  toState: CheckoutState;
  cancellationReason?: CheckoutCancellationReason;
  error?: string;
}

export type CheckoutWorkflowEvent = WorkflowEventEnvelope<CheckoutWorkflowEventPayload>;

export const emittedEvents: CheckoutWorkflowEvent[] = [];

export function clearEmittedEvents(): void {
  emittedEvents.length = 0;
  clearPublishedWorkflowEvents();
}

export function emitCheckoutEvent(event: CheckoutWorkflowEvent): void {
  emittedEvents.push(event);
  publishWorkflowEvent(event);
}

export class CheckoutWorkflow {
  public readonly orderId: string;
  public readonly correlationId: string;
  private _state: CheckoutState = "initiated";
  private _cancellationReason?: CheckoutCancellationReason;

  constructor(orderId: string, correlationId: string = createWorkflowCorrelationId()) {
    this.orderId = orderId;
    this.correlationId = correlationId;
    emitCheckoutEvent(
      createWorkflowEventEnvelope(this.correlationId, this.orderId, "checkout_initiated", {
        fromState: "initiated",
        toState: "initiated",
      })
    );
  }

  public get state(): CheckoutState {
    return this._state;
  }

  public get cancellationReason(): CheckoutCancellationReason | undefined {
    return this._cancellationReason;
  }

  public transitionTo(nextState: CheckoutState, reason?: CheckoutCancellationReason): void {
    const currentState = this._state;

    if (currentState === "completed" || currentState === "cancelled") {
      throw new Error(`Cannot transition from terminal state: ${currentState}`);
    }

    const allowedTransitions: Record<CheckoutState, CheckoutState[]> = {
      initiated: ["pending_approval", "cancelled"],
      pending_approval: ["approved", "cancelled"],
      approved: ["funding", "cancelled"],
      funding: ["completed", "cancelled"],
      completed: [],
      cancelled: [],
    };

    if (!allowedTransitions[currentState].includes(nextState)) {
      throw new Error(`Invalid state transition from ${currentState} to ${nextState}`);
    }

    if (nextState === "cancelled") {
      if (!reason) {
        throw new Error("Cancellation reason is required for transition to cancelled state");
      }
      const validReasons: CheckoutCancellationReason[] = [
        "user_rejected",
        "approval_timeout",
        "funding_failed",
        "merchant_unavailable",
        "system_error",
      ];
      if (!validReasons.includes(reason)) {
        throw new Error(`Invalid cancellation reason: ${reason}`);
      }
      this._cancellationReason = reason;
    }

    this._state = nextState;

    const eventType = `checkout_${nextState}`;
    emitCheckoutEvent(
      createWorkflowEventEnvelope(this.correlationId, this.orderId, eventType, {
        fromState: currentState,
        toState: nextState,
        ...(reason && { cancellationReason: reason }),
      })
    );
  }
}

export interface CheckoutWorkflowInput {
  orderId: string;
  sourceAddress: string;
  buyerAddress: string;
  sellerAddress: string;
  userId?: string;
  inventoryItems?: InventoryReservationItem[];
}

export interface CheckoutContext extends Record<string, unknown> {
  orderId: string;
  sourceAddress: string;
  buyerAddress: string;
  sellerAddress: string;
  userId: string;
  escrowId: string | null;
  confirmed: boolean;
}

/** Adds only the authenticated server-side user identity to validated checkout fields. */
export function createCheckoutWorkflowInput(
  input: Pick<CheckoutWorkflowInput, "orderId" | "sourceAddress" | "buyerAddress" | "sellerAddress">,
  authenticatedUserId: string,
): CheckoutWorkflowInput {
  return {
    orderId: input.orderId,
    sourceAddress: input.sourceAddress,
    buyerAddress: input.buyerAddress,
    sellerAddress: input.sellerAddress,
    userId: authenticatedUserId,
  };
}

function getPaymentsUrl(): string {
  return process.env.PAYMENTS_URL ?? "http://localhost:3014";
}

interface EscrowOperationResult {
  txHash: string;
  ledger: number;
  success: boolean;
  escrowId?: string;
}

const PAYMENTS_REQUEST_TIMEOUT_MS = Number(process.env.PAYMENTS_REQUEST_TIMEOUT_MS ?? 10_000);

async function callPaymentsService<T>(
  path: string,
  body: Record<string, unknown>,
  serviceAuth?: { userId: string },
): Promise<T> {
  const url = `${getPaymentsUrl()}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (serviceAuth) {
    const serviceToken = process.env.ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN;
    if (!serviceToken?.trim()) {
      throw new Error("ORCHESTRATOR_PAYMENTS_SERVICE_TOKEN is not configured");
    }
    headers[SERVICE_AUTH_HEADER] = serviceToken;
    headers["x-delego-user-id"] = serviceAuth.userId;
  }

  let response: Response;
  try {
    response = await tracedFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PAYMENTS_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reach payments service";
    throw new Error(`Payments service unavailable: ${message}`);
  }

  const json = (await response.json()) as ApiResponse<T>;
  if (!response.ok || json.error) {
    throw new Error(json.error?.message ?? `Payments service returned status ${response.status}`);
  }
  if (!json.data) {
    throw new Error("Payments service returned an empty response");
  }
  return json.data;
}

/**
 * Deposits the order total into escrow. Compensation refunds the same escrow ID, which is
 * idempotent on the contract side — refunding an already-refunded or never-funded escrow
 * is a no-op rather than a double-spend.
 */
const depositEscrowStep: SagaStep<CheckoutContext> = {
  name: "deposit-escrow",
  async execute(context) {
    const result = await callPaymentsService<EscrowOperationResult>("/escrow/deposit", {
      sourceAddress: context.sourceAddress,
      buyerAddress: context.buyerAddress,
      sellerAddress: context.sellerAddress,
      orderId: context.orderId,
    }, { userId: context.userId });
    log.info("Escrow deposit confirmed", { orderId: context.orderId, txHash: result.txHash });
    if (!result.escrowId) {
      // Compensation refunds /escrow/${context.escrowId}/refund — falling back to orderId here
      // would point a refund at the wrong resource and leave the real escrow uncompensated.
      throw new Error("Payments service did not return an escrowId for the deposit");
    }
    return { ...context, escrowId: result.escrowId };
  },
  async compensate(context, error) {
    if (!context.escrowId) return context;
    log.warn("Refunding escrow deposit after downstream failure", {
      orderId: context.orderId,
      escrowId: context.escrowId,
      reason: error.message,
    });
    await callPaymentsService<EscrowOperationResult>(`/escrow/${context.escrowId}/refund`, {
      sourceAddress: context.sourceAddress,
    });
    return { ...context, escrowId: null };
  },
};

/**
 * Marks the checkout as confirmed once escrow funds are secured. This is a context-only
 * transition today; once the gateway exposes an order-status endpoint, this step should
 * call it instead so order state stays in sync across services.
 */
const confirmCheckoutStep: SagaStep<CheckoutContext> = {
  name: "confirm-checkout",
  async execute(context) {
    return { ...context, confirmed: true };
  },
  async compensate(context) {
    return { ...context, confirmed: false };
  },
};

export function createCheckoutSagaCoordinator(
  store: SagaStore,
  locks?: DistributedLockManager,
): SagaCoordinator<CheckoutContext> {
  return new SagaCoordinator<CheckoutContext>({
    steps: [depositEscrowStep, confirmCheckoutStep],
    store,
    locks,
  });
}

// Issue #210 — Merchant Cancellation Event Handler

export interface MerchantCancellationEvent {
  orderId: string;
  merchantId: string;
  reasonCode: string;
  occurredAt: string;
}

export interface CanceledCheckout {
  orderId: string;
  status: "canceled";
  reason: string;
  canceledAt: string;
  refundNeeded: boolean;
}

export interface RefundNeededEvent {
  orderId: string;
  merchantId: string;
  triggeredAt: string;
}

export interface MerchantCancellationResult {
  checkout: CanceledCheckout;
  refundEvent: RefundNeededEvent | null;
}

/**
 * Handles a merchant cancellation and transitions the checkout workflow to canceled.
 * When escrow is already funded, a refund-needed event is returned for downstream publishing.
 */
export function handleMerchantCancellation(
  event: MerchantCancellationEvent,
  escrowFunded: boolean
): MerchantCancellationResult {
  const checkout: CanceledCheckout = {
    orderId: event.orderId,
    status: "canceled",
    reason: event.reasonCode,
    canceledAt: event.occurredAt,
    refundNeeded: escrowFunded,
  };

  const refundEvent: RefundNeededEvent | null = escrowFunded
    ? {
        orderId: event.orderId,
        merchantId: event.merchantId,
        triggeredAt: event.occurredAt,
      }
    : null;

  return { checkout, refundEvent };
}

export async function checkoutWorkflow(
  input: CheckoutWorkflowInput,
  coordinator: SagaCoordinator<CheckoutContext>,
  sagaId: string
): Promise<SagaRecord<CheckoutContext>> {
  // Issue #342: stamp each reservation with the order id (defaulting to this
  // workflow's orderId when the caller didn't set one) so the unique
  // (merchant_id, order_id, product_id) constraint catches duplicate
  // checkout retries for the same order.
  const inventoryItems = (input.inventoryItems ?? []).map((item) => ({
    ...item,
    orderId: item.orderId ?? input.orderId,
  }));
  const inventory = getInventoryReservationService();
  if (inventoryItems.length > 0) await inventory.reserve(inventoryItems);

  let result: SagaRecord<CheckoutContext>;
  try {
    result = await coordinator.run(
      sagaId,
      input.orderId,
      {
        orderId: input.orderId,
        sourceAddress: input.sourceAddress,
        buyerAddress: input.buyerAddress,
        sellerAddress: input.sellerAddress,
        userId: input.userId ?? "",
        escrowId: null,
        confirmed: false,
      },
      { workflowType: "checkout", correlationId: createWorkflowCorrelationId() }
    );
  } catch (error) {
    if (inventoryItems.length > 0) await inventory.release(inventoryItems);
    throw error;
  }
  if (result.status !== "completed" && inventoryItems.length > 0) {
    await inventory.release(inventoryItems);
  }
  return result;
}

