import { createLogger, generateId, type Logger } from "@delegolabs/utils";
import {
  SagaConcurrencyError,
  type CompletedStep,
  type SagaEvent,
  type SagaRecord,
  type SagaRecoveryDetail,
  type SagaRecoveryResult,
  type SagaStep,
  type SagaStore,
  type SagaWorkflowType,
} from "./types.js";
import type { DistributedLockManager } from "../locks/manager.js";
import { lockKeyForStep, lockKeyForWorkflow } from "../locks/keys.js";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
/** Saga-level deadline — a running/compensating saga older than this is auto-compensated on recovery. */
const DEFAULT_SAGA_TIMEOUT_MS = 5 * 60_000;

export interface SagaCoordinatorOptions<TContext> {
  /** Saga steps in the order they should execute. Compensations run in reverse order. */
  steps: Array<SagaStep<TContext>>;
  store: SagaStore;
  log?: Logger;
  /** How long a step claim is honored before another runner may safely reclaim it. */
  claimLeaseMs?: number;
  /** Saga-level deadline used to detect sagas that must be auto-recovered/compensated. */
  sagaTimeoutMs?: number;
  /** Optional Redis lock manager for multi-instance coordination. */
  locks?: DistributedLockManager;
}

export interface RunOptions {
  workflowType?: SagaWorkflowType;
  /** Distributed-tracing correlation id. Generated when not supplied. */
  correlationId?: string;
}

/**
 * Runs an ordered set of saga steps against a durable store, compensating completed
 * steps in reverse order if any step fails. Safe to call run()/resume() repeatedly for
 * the same sagaId — already-completed steps are skipped, which makes retries idempotent
 * and lets execution resume cleanly after an orchestrator crash.
 */
export class SagaCoordinator<TContext extends object> {
  private readonly steps: Map<string, SagaStep<TContext>>;
  private readonly stepOrder: string[];
  private readonly store: SagaStore;
  private readonly log: Logger;
  private readonly claimLeaseMs: number;
  private readonly sagaTimeoutMs: number;
  private readonly locks?: DistributedLockManager;

  constructor(options: SagaCoordinatorOptions<TContext>) {
    if (options.steps.length === 0) {
      throw new Error("SagaCoordinator requires at least one step");
    }
    const seen = new Set<string>();
    for (const step of options.steps) {
      if (seen.has(step.name)) {
        throw new Error(`Duplicate saga step name: ${step.name}`);
      }
      seen.add(step.name);
    }
    this.steps = new Map(options.steps.map((step) => [step.name, step]));
    this.stepOrder = options.steps.map((step) => step.name);
    this.store = options.store;
    this.log = options.log ?? createLogger("orchestrator:saga");
    const claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs <= 0) {
      throw new Error("claimLeaseMs must be a positive safe integer");
    }
    this.claimLeaseMs = claimLeaseMs;
    this.sagaTimeoutMs = options.sagaTimeoutMs ?? DEFAULT_SAGA_TIMEOUT_MS;
    this.locks = options.locks;
  }

  /** Starts a new saga, or resumes it if sagaId was already started (idempotent). */
  async run(
    sagaId: string,
    orderId: string,
    initialContext: TContext,
    options: RunOptions = {}
  ): Promise<SagaRecord<TContext>> {
    const now = new Date();
    const correlationId = options.correlationId ?? generateId();
    const created = await this.store.create({
      sagaId,
      orderId,
      workflowType: options.workflowType ?? "checkout",
      status: "running",
      currentStep: this.stepOrder[0] ?? null,
      completedSteps: [],
      context: initialContext as Record<string, unknown>,
      version: 0,
      correlationId,
      error: null,
      expiresAt: this.sagaTimeoutMs > 0 ? new Date(now.getTime() + this.sagaTimeoutMs) : null,
      claimExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const record = created as SagaRecord<TContext>;
    await this.recordEvent(record, "saga_started", null, "running", { orderId });
    // create() can return a previously completed/failed record — treat both as
    // terminal so a retried run() never restarts a saga that already finished.
    if (record.status === "completed" || record.status === "compensated" || record.status === "failed") {
      return record;
    }
    return this.withWorkflowLock(record.sagaId, () => this.advance(record as SagaRecord<TContext>));
  }

  /** Continues a previously started saga from its persisted state — used for crash recovery and manual retries. */
  async resume(sagaId: string): Promise<SagaRecord<TContext>> {
    const record = await this.store.get(sagaId);
    if (!record) {
      throw new Error(`Saga not found: ${sagaId}`);
    }
    if (record.status === "completed" || record.status === "compensated" || record.status === "failed") {
      return record as SagaRecord<TContext>;
    }
    return this.withWorkflowLock(record.sagaId, () => this.advance(record as SagaRecord<TContext>));
  }

  /**
   * Resumes every saga left in "running" or "compensating" (and compensates any that have
   * timed out) — call once at startup. Returns a structured result describing what recovery did
   * so the service can report it without blocking new requests.
   */
  async recoverAll(): Promise<SagaRecoveryResult> {
    const incomplete = await this.store.listIncomplete();
    const details: SagaRecoveryDetail[] = [];
    let recovered = 0;
    let failed = 0;

    for (const record of incomplete) {
      const result = await this.recoverOne(record.sagaId);
      if (result) {
        details.push(result);
        if (result.action === "marked_failed") failed++;
        else recovered++;
      }
    }

    return { recovered, failed, details };
  }

  private async recoverOne(sagaId: string): Promise<SagaRecoveryDetail | null> {
    try {
      const fetched = await this.store.get(sagaId);
      if (!fetched) return null;
      const latest = fetched as SagaRecord<TContext>;

      // Saga-level timeout: a running/compensating saga past its deadline is auto-compensated.
      if (latest.expiresAt && latest.expiresAt.getTime() <= Date.now()) {
        this.log.warn("Saga exceeded its deadline — auto-compensating on recovery", {
          sagaId,
          expiresAt: latest.expiresAt.toISOString(),
        });
        await this.recordEvent(latest, "saga_timed_out", latest.status, "timed_out", {});
        const timedOut = await this.save({
          ...latest,
          status: "timed_out",
          error: latest.error ?? "Saga exceeded its deadline",
          claimExpiresAt: null,
          updatedAt: new Date(),
        });
        try {
          const compensated = await this.compensate(timedOut, new Error("Saga exceeded its deadline"));
          return {
            sagaId,
            action: compensated.status === "compensated" ? "compensated" : "marked_failed",
            reason: "Saga exceeded its timeout deadline and was auto-compensated",
          };
        } catch {
          return { sagaId, action: "marked_failed", reason: "Saga timed out and compensation failed" };
        }
      }

      const result = await this.resume(sagaId);
      this.scheduleRetryIfLeased(result);
      if ((result.status === "running" || result.status === "compensating") && !result.claimExpiresAt) {
        const fresh = await this.store.get(sagaId);
        if (fresh) this.scheduleRetryIfLeased(fresh as SagaRecord<TContext>);
      }
      return { sagaId, action: "resumed", reason: `Recovered in status ${result.status}` };
    } catch (err) {
      this.log.error("Saga recovery failed", {
        sagaId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { sagaId, action: "marked_failed", reason: err instanceof Error ? err.message : "Recovery failed" };
    }
  }

  /**
   * If resume() backed off because the step's lease (held by a runner that may since have
   * crashed) hasn't expired yet, schedule a single retry for just after it does — otherwise a
   * pre-crash lease leaves the saga stuck until an operator calls /resume manually.
   */
  private scheduleRetryIfLeased(record: SagaRecord<TContext>): void {
    if (record.status !== "running" && record.status !== "compensating") return;
    if (!record.claimExpiresAt) return;

    const delayMs = record.claimExpiresAt.getTime() - Date.now();
    if (delayMs <= 0) return;

    setTimeout(() => {
      void this.recoverOne(record.sagaId);
    }, delayMs + 50);
  }

  /**
   * Background sweeper that detects and auto-recovers timed-out sagas while the service is
   * running, so a crash that leaves a saga mid-flight is healed within `intervalMs` rather than
   * only on the next restart. Returns a handle whose stop() clears the timer.
   */
  startTimeoutSweeper(intervalMs: number = this.sagaTimeoutMs): { stop: () => void } {
    const timer = setInterval(async () => {
      try {
        const timedOut = await this.store.listTimedOut();
        for (const record of timedOut) {
          await this.recoverOne(record.sagaId);
        }
      } catch (err) {
        this.log.error("Saga timeout sweep failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, intervalMs);
    // Don't keep the process alive solely for the sweeper.
    if (typeof timer.unref === "function") timer.unref();
    return {
      stop: () => clearInterval(timer),
    };
  }

  private async withWorkflowLock(
    sagaId: string,
    fn: () => Promise<SagaRecord<TContext>>,
  ): Promise<SagaRecord<TContext>> {
    if (!this.locks) return fn();
    const key = lockKeyForWorkflow(sagaId);
    const result = await this.locks.acquire(key, {
      ttlMs: this.claimLeaseMs,
      autoRenew: true,
      waitTimeoutMs: 0,
      metadata: { sagaId, level: "workflow" },
    });
    if (!result.acquired) {
      this.log.warn("Workflow lock held by another instance, backing off", {
        sagaId,
        holder: result.lock?.owner,
      });
      const current = await this.store.get(sagaId);
      if (!current) throw new Error(`Saga not found: ${sagaId}`);
      return current as SagaRecord<TContext>;
    }
    try {
      return await fn();
    } finally {
      await this.locks.release(key);
    }
  }

  private async advance(record: SagaRecord<TContext>): Promise<SagaRecord<TContext>> {
    if (record.status === "compensating" || record.status === "timed_out") {
      return this.compensate(record, new Error(record.error ?? "Saga failed"));
    }

    let current = record;
    const completedNames = new Set(current.completedSteps.map((step) => step.stepName));
    const remaining = this.stepOrder.filter((name) => !completedNames.has(name));

    for (const stepName of remaining) {
      const step = this.steps.get(stepName);
      if (!step) {
        throw new Error(`Unknown saga step: ${stepName}`);
      }

      const claimed = await this.claimStep(current, stepName);
      if (!claimed) return current;
      current = claimed;

      let context: TContext;
      try {
        context = await this.executeWithRetry(step, current.context);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.log.error("Saga step failed, starting compensation", {
          sagaId: current.sagaId,
          step: stepName,
          error: error.message,
        });
        await this.releaseStepLock(current.sagaId, stepName);
        current = await this.save({
          ...current,
          status: "compensating",
          error: error.message,
          claimExpiresAt: null,
          updatedAt: new Date(),
        });
        await this.recordEvent(current, "step_failed", "running", "compensating", { step: stepName, error: error.message });
        return this.compensate(current, error);
      }

      if (this.locks?.wasStolen(lockKeyForStep(current.sagaId, stepName))) {
        this.log.warn("Step lock stolen during action — not persisting completion", {
          sagaId: current.sagaId,
          step: stepName,
        });
        return current;
      }

      const completedStep: CompletedStep = {
        stepName,
        status: "completed",
        output: context as Record<string, unknown>,
        completedAt: new Date().toISOString(),
        compensationAction: step.name,
      };

      // A failure here is a persistence problem, not a step failure — the action already
      // succeeded, so this must bubble up for recovery/retry rather than trigger compensation.
      current = await this.save({
        ...current,
        context,
        completedSteps: [...current.completedSteps, completedStep],
        currentStep: this.stepOrder[this.stepOrder.indexOf(stepName) + 1] ?? null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      });
      await this.releaseStepLock(current.sagaId, stepName);
      await this.recordEvent(current, "step_completed", "running", "running", { step: stepName });
    }

    const completed = await this.save({
      ...current,
      status: "completed",
      currentStep: null,
      claimExpiresAt: null,
      updatedAt: new Date(),
    });
    await this.recordEvent(completed, "saga_completed", "running", "completed", {});
    return completed;
  }

  /**
   * Executes a step, honoring its optional retry policy. A failure whose message matches one of
   * `retryableErrors` is retried with `backoffMs` delays up to `maxAttempts` times; any other
   * failure (or exhaustion of attempts) propagates so compensation can begin.
   */
  private async executeWithRetry(step: SagaStep<TContext>, context: TContext): Promise<TContext> {
    const policy = step.retryPolicy;
    const maxAttempts = policy?.maxAttempts ?? 1;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const executeFn = step.execute ?? (step as any).action;
        return await executeFn.call(step, context);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;
        const retryable = policy?.retryableErrors.some((pattern) => error.message.includes(pattern)) ?? false;
        if (!retryable || attempt === maxAttempts) break;
        this.log.warn("Saga step failed, retrying", {
          step: step.name,
          attempt,
          error: error.message,
        });
        await new Promise((resolve) => setTimeout(resolve, policy?.backoffMs ?? 0));
      }
    }

    throw lastError ?? new Error(`Saga step ${step.name} failed`);
  }

  private async compensate(record: SagaRecord<TContext>, _error: Error): Promise<SagaRecord<TContext>> {
    let current = record;
    const toCompensate = [...current.completedSteps].reverse();

    for (const completedStep of toCompensate) {
      const step = this.steps.get(completedStep.stepName);
      if (!step) {
        const missingStep = new Error(`Unknown saga step during compensation: ${completedStep.stepName}`);
        await this.save({ ...current, error: missingStep.message, updatedAt: new Date() });
        throw missingStep;
      }

      const claimed = await this.claimStep(current, completedStep.stepName);
      if (!claimed) return current;
      current = claimed;

      try {
        const context = step.compensate
          ? await step.compensate.call(step, current.context, completedStep.output)
          : await (step as any).compensation.call(step, current.context, _error);
        if (this.locks?.wasStolen(lockKeyForStep(current.sagaId, completedStep.stepName))) {
          this.log.warn("Step lock stolen during compensation — not persisting rollback", {
            sagaId: current.sagaId,
            step: completedStep.stepName,
          });
          return current;
        }
        const updatedStep: CompletedStep = {
          ...completedStep,
          status: "compensated",
        };
        current = await this.save({
          ...current,
          context,
          completedSteps: current.completedSteps.map((stepEntry) =>
            stepEntry.stepName === completedStep.stepName ? updatedStep : stepEntry
          ),
          claimExpiresAt: null,
          updatedAt: new Date(),
        });
        await this.releaseStepLock(current.sagaId, completedStep.stepName);
        await this.recordEvent(current, "step_compensated", "compensating", "compensating", {
          step: completedStep.stepName,
        });
      } catch (compErr) {
        const compensationError = compErr instanceof Error ? compErr : new Error(String(compErr));
        this.log.error("Compensation step failed — saga left in compensating state for retry", {
          sagaId: current.sagaId,
          step: completedStep.stepName,
          error: compensationError.message,
        });
        await this.releaseStepLock(current.sagaId, completedStep.stepName);
        // Release the lease so a subsequent resume()/recoverAll() doesn't have to wait out a
        // lease held by a runner that has already given up on this step.
        await this.save({ ...current, claimExpiresAt: null, updatedAt: new Date() });
        throw compensationError;
      }
    }

    const compensated = await this.save({
      ...current,
      status: "compensated",
      currentStep: null,
      claimExpiresAt: null,
      updatedAt: new Date(),
    });
    await this.recordEvent(compensated, "saga_compensated", "compensating", "compensated", {});
    return compensated;
  }

  /**
   * Durably claims a step before its action/compensation runs, so the persisted record always
   * reflects in-progress work before any side effect fires. The version check alone only stops
   * two runners from claiming the *same* version simultaneously — it doesn't stop a second runner
   * from reading the already-claimed record and re-claiming the same step at the next version. The
   * lease (`claimExpiresAt`) closes that gap: a step already claimed by a live lease is refused.
   * Redis step locks add a cross-instance mutex around the same claim.
   */
  private async claimStep(record: SagaRecord<TContext>, stepName: string): Promise<SagaRecord<TContext> | null> {
    if (
      record.currentStep === stepName &&
      record.claimExpiresAt &&
      record.claimExpiresAt.getTime() > Date.now()
    ) {
      this.log.warn("Step already claimed by another runner under an active lease, backing off", {
        sagaId: record.sagaId,
        step: stepName,
      });
      return null;
    }

    const stepKey = lockKeyForStep(record.sagaId, stepName);
    if (this.locks) {
      const redisClaim = await this.locks.acquire(stepKey, {
        ttlMs: this.claimLeaseMs,
        autoRenew: true,
        waitTimeoutMs: 0,
        metadata: { sagaId: record.sagaId, step: stepName, level: "step" },
      });
      if (!redisClaim.acquired) {
        this.log.warn("Step lock held by another instance, backing off", {
          sagaId: record.sagaId,
          step: stepName,
          holder: redisClaim.lock?.owner,
        });
        return null;
      }
    }

    try {
      return await this.save({
        ...record,
        currentStep: stepName,
        claimExpiresAt: new Date(Date.now() + this.claimLeaseMs),
        updatedAt: new Date(),
      });
    } catch (err) {
      await this.releaseStepLock(record.sagaId, stepName);
      if (err instanceof SagaConcurrencyError) {
        this.log.warn("Saga step already claimed by another runner, backing off", {
          sagaId: record.sagaId,
          step: stepName,
        });
        return null;
      }
      throw err;
    }
  }

  private async releaseStepLock(sagaId: string, stepName: string): Promise<void> {
    if (!this.locks) return;
    await this.locks.release(lockKeyForStep(sagaId, stepName));
  }

  private async recordEvent(
    record: SagaRecord<TContext>,
    eventType: string,
    fromStatus: SagaRecord["status"] | null,
    toStatus: SagaRecord["status"] | null,
    payload: Record<string, unknown>
  ): Promise<void> {
    const event: SagaEvent = {
      sagaId: record.sagaId,
      correlationId: record.correlationId,
      eventType,
      fromStatus,
      toStatus,
      payload,
      createdAt: new Date(),
    };
    await this.store.appendEvent(event);
  }

  /** Saves a record of this coordinator's TContext — store.save() is typed generically. */
  private save(record: SagaRecord<TContext>): Promise<SagaRecord<TContext>> {
    return this.store.save(record as SagaRecord) as Promise<SagaRecord<TContext>>;
  }
}
