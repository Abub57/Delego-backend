/**
 * BullMQ Dead Letter Queue manager — Issue #588
 *
 * Failed jobs used to sit in BullMQ's `failed` state with no automated
 * escalation. `DlqManager` inspects each failure and either:
 *
 *  - re-enqueues it with exponential backoff + jitter when the error is
 *    transient (network / timeout / 408 / 429 / 5xx), up to
 *    `DlqRetryConfig.maxAttempts` retries; or
 *  - quarantines it immediately when the error is fatal (schema / auth /
 *    other 4xx, or listed in `nonRetryableErrors`), when the error cannot be
 *    classified, or once the retry budget is exhausted.
 *
 * Every decision is written to `dlq_incident_history`.
 *
 * The manager depends only on the structural `ReplayQueue` and
 * `DlqIncidentStore` interfaces, so a BullMQ `Queue` and a `pg` Pool/Client
 * can be passed straight in.
 */

export interface DlqRetryConfig {
  /** Maximum number of retries before a transient failure is quarantined. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Error names or codes (case-insensitive) that are quarantined immediately. */
  nonRetryableErrors: string[];
}

export const DEFAULT_DLQ_RETRY_CONFIG: DlqRetryConfig = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  nonRetryableErrors: [
    'ValidationError',
    'ZodError',
    'SchemaError',
    'AuthenticationError',
    'AuthorizationError',
    'UnauthorizedError',
    'ForbiddenError',
  ],
};

export type DlqErrorClass = 'transient' | 'fatal' | 'unclassified';
export type DlqQuarantineReason = 'fatal_error' | 'retries_exhausted' | 'unclassified_error';

export interface DlqJobLike {
  id?: string;
  name: string;
  data: Record<string, unknown>;
}

/** Subset of a BullMQ `Queue` the manager needs. */
export interface ReplayQueue {
  add(name: string, data: unknown, opts?: { delay?: number; jobId?: string }): Promise<unknown>;
}

export interface DlqIncident {
  queueName: string;
  jobId: string;
  jobName: string;
  attempt: number;
  outcome: 'retry_scheduled' | 'quarantined';
  errorClass: DlqErrorClass;
  errorName: string | null;
  errorMessage: string;
  retryDelayMs: number | null;
  quarantineReason: DlqQuarantineReason | null;
}

export interface DlqIncidentStore {
  record(incident: DlqIncident): Promise<void>;
}

/** Subset of a `pg` Pool/Client. */
export interface SqlExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface DlqLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export type DlqDecision =
  | { action: 'retry'; delayMs: number; attempt: number }
  | { action: 'quarantine'; reason: DlqQuarantineReason; attempt: number };

/** Lineage metadata carried in `job.data._dlq` across re-enqueued retries. */
interface DlqMeta {
  originalJobId: string;
  retryCount: number;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function errorFields(error: unknown): {
  name: string;
  code: string;
  status: number | undefined;
  message: string;
} {
  if (typeof error !== 'object' || error === null) {
    return { name: '', code: '', status: undefined, message: String(error) };
  }
  const e = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  const rawStatus = e.status ?? e.statusCode ?? e.response?.status;
  return {
    name: typeof e.name === 'string' ? e.name : '',
    code: typeof e.code === 'string' ? e.code : '',
    status: typeof rawStatus === 'number' ? rawStatus : undefined,
    message: typeof e.message === 'string' ? e.message : String(error),
  };
}

/**
 * Classify a job failure. `nonRetryableErrors` always wins; anything that is
 * neither recognisably transient nor fatal is `unclassified` and quarantined,
 * since blindly replaying an unknown failure risks duplicate side effects.
 */
export function classifyDlqError(
  error: unknown,
  config: Pick<DlqRetryConfig, 'nonRetryableErrors'> = DEFAULT_DLQ_RETRY_CONFIG,
): DlqErrorClass {
  const { name, code, status, message } = errorFields(error);
  const nonRetryable = new Set(config.nonRetryableErrors.map((n) => n.toLowerCase()));

  if (
    (name && nonRetryable.has(name.toLowerCase())) ||
    (code && nonRetryable.has(code.toLowerCase()))
  ) {
    return 'fatal';
  }

  if (status !== undefined) {
    if (status === 408 || status === 429 || status >= 500) return 'transient';
    if (status >= 400) return 'fatal';
  }

  if (TRANSIENT_CODES.has(code.toUpperCase())) return 'transient';
  if (name === 'TimeoutError' || /time(d)?[ -]?out/i.test(message)) return 'transient';

  return 'unclassified';
}

/**
 * Exponential backoff with equal jitter: the ceiling is
 * `min(maxDelayMs, baseDelayMs * 2^(retry - 1))` and the delay is drawn
 * uniformly from `[ceiling / 2, ceiling]`, so concurrent failures spread out
 * without ever collapsing to ~0. `retry` is 1-based.
 */
export function computeBackoffDelayMs(
  retry: number,
  config: Pick<DlqRetryConfig, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(retry - 1, 0), 30);
  const ceiling = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** exponent);
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

export class PgDlqIncidentStore implements DlqIncidentStore {
  constructor(private readonly db: SqlExecutor) {}

  async record(i: DlqIncident): Promise<void> {
    await this.db.query(
      `INSERT INTO dlq_incident_history
         (queue_name, job_id, job_name, attempt, outcome, error_class,
          error_name, error_message, retry_delay_ms, quarantine_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        i.queueName,
        i.jobId,
        i.jobName,
        i.attempt,
        i.outcome,
        i.errorClass,
        i.errorName,
        i.errorMessage,
        i.retryDelayMs,
        i.quarantineReason,
      ],
    );
  }
}

export interface DlqManagerOptions {
  /** Name of the source queue; stored in history and quarantine records. */
  queueName: string;
  /** Source queue that retried jobs are re-added to. */
  queue: ReplayQueue;
  /** Queue that receives permanently quarantined jobs. */
  quarantineQueue: ReplayQueue;
  history: DlqIncidentStore;
  config?: Partial<DlqRetryConfig>;
  logger?: DlqLogger;
  /** Injectable for deterministic jitter in tests. */
  random?: () => number;
}

const NOOP_LOGGER: DlqLogger = { info() {}, warn() {}, error() {} };

export class DlqManager {
  private readonly config: DlqRetryConfig;
  private readonly log: DlqLogger;
  private readonly random: () => number;

  constructor(private readonly opts: DlqManagerOptions) {
    this.config = { ...DEFAULT_DLQ_RETRY_CONFIG, ...opts.config };
    this.log = opts.logger ?? NOOP_LOGGER;
    this.random = opts.random ?? Math.random;
  }

  /** Subscribe to a BullMQ `Worker`'s `failed` event. */
  attachTo(worker: {
    on(event: 'failed', cb: (job: DlqJobLike | undefined, err: Error) => void): unknown;
  }): void {
    worker.on('failed', (job, err) => {
      if (!job) return;
      this.handleFailedJob(job, err).catch((e) =>
        this.log.error('DLQ manager failed to handle job failure', {
          queueName: this.opts.queueName,
          jobId: job.id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    });
  }

  async handleFailedJob(job: DlqJobLike, error: unknown): Promise<DlqDecision> {
    const meta = this.readMeta(job);
    const attempt = meta.retryCount + 1;
    const errorClass = classifyDlqError(error, this.config);
    const { name, message } = errorFields(error);

    if (errorClass === 'transient' && meta.retryCount < this.config.maxAttempts) {
      const delayMs = computeBackoffDelayMs(attempt, this.config, this.random);
      const nextMeta: DlqMeta = { ...meta, retryCount: attempt };
      await this.opts.queue.add(
        job.name,
        { ...job.data, _dlq: nextMeta },
        { delay: delayMs, jobId: `${meta.originalJobId}:dlq-retry-${attempt}` },
      );
      await this.recordIncident({
        queueName: this.opts.queueName,
        jobId: meta.originalJobId,
        jobName: job.name,
        attempt,
        outcome: 'retry_scheduled',
        errorClass,
        errorName: name || null,
        errorMessage: message,
        retryDelayMs: delayMs,
        quarantineReason: null,
      });
      this.log.warn('DLQ retry scheduled', {
        queueName: this.opts.queueName,
        jobId: meta.originalJobId,
        attempt,
        delayMs,
      });
      return { action: 'retry', delayMs, attempt };
    }

    const reason: DlqQuarantineReason =
      errorClass === 'fatal'
        ? 'fatal_error'
        : errorClass === 'transient'
          ? 'retries_exhausted'
          : 'unclassified_error';

    await this.opts.quarantineQueue.add(
      job.name,
      {
        originalQueue: this.opts.queueName,
        originalJobId: meta.originalJobId,
        data: job.data,
        reason,
        attempts: attempt,
        error: {
          name: name || null,
          message,
          stack: error instanceof Error ? (error.stack ?? null) : null,
        },
        quarantinedAt: new Date().toISOString(),
      },
      { jobId: `${meta.originalJobId}:quarantine` },
    );
    await this.recordIncident({
      queueName: this.opts.queueName,
      jobId: meta.originalJobId,
      jobName: job.name,
      attempt,
      outcome: 'quarantined',
      errorClass,
      errorName: name || null,
      errorMessage: message,
      retryDelayMs: null,
      quarantineReason: reason,
    });
    this.log.error('DLQ job quarantined', {
      queueName: this.opts.queueName,
      jobId: meta.originalJobId,
      attempt,
      reason,
    });
    return { action: 'quarantine', reason, attempt };
  }

  private readMeta(job: DlqJobLike): DlqMeta {
    const raw = job.data?._dlq as Partial<DlqMeta> | undefined;
    return {
      originalJobId: raw?.originalJobId ?? String(job.id ?? 'unknown'),
      retryCount: typeof raw?.retryCount === 'number' ? raw.retryCount : 0,
    };
  }

  /** Audit logging must never block replay or quarantine of the job itself. */
  private async recordIncident(incident: DlqIncident): Promise<void> {
    try {
      await this.opts.history.record(incident);
    } catch (e) {
      this.log.error('Failed to write dlq_incident_history', {
        queueName: incident.queueName,
        jobId: incident.jobId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
