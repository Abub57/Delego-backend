import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_DLQ_RETRY_CONFIG,
  DlqManager,
  PgDlqIncidentStore,
  classifyDlqError,
  computeBackoffDelayMs,
  type DlqIncident,
  type DlqJobLike,
} from './dlqManager';

function errWith(props: Record<string, unknown>, message = 'boom'): Error {
  return Object.assign(new Error(message), props);
}

function setup(config = {}, random = () => 0.5) {
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const quarantineQueue = { add: vi.fn().mockResolvedValue(undefined) };
  const incidents: DlqIncident[] = [];
  const history = {
    record: vi.fn(async (i: DlqIncident) => {
      incidents.push(i);
    }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const manager = new DlqManager({
    queueName: 'emails',
    queue,
    quarantineQueue,
    history,
    config,
    logger,
    random,
  });
  return { manager, queue, quarantineQueue, history, incidents, logger };
}

const job = (data: Record<string, unknown> = { to: 'a@b.c' }, id = 'job-1'): DlqJobLike => ({
  id,
  name: 'send',
  data,
});

describe('classifyDlqError', () => {
  it.each([
    ['ECONNRESET code', errWith({ code: 'ECONNRESET' })],
    ['ETIMEDOUT code', errWith({ code: 'ETIMEDOUT' })],
    ['ENOTFOUND code', errWith({ code: 'ENOTFOUND' })],
    ['TimeoutError name', errWith({ name: 'TimeoutError' })],
    ['timeout in message', new Error('Request timed out after 5000ms')],
    ['HTTP 503', errWith({ status: 503 })],
    ['HTTP 429', errWith({ statusCode: 429 })],
    ['HTTP 408 via response', errWith({ response: { status: 408 } })],
  ])('treats %s as transient', (_label, err) => {
    expect(classifyDlqError(err)).toBe('transient');
  });

  it.each([
    ['ValidationError', errWith({ name: 'ValidationError' })],
    ['ZodError', errWith({ name: 'ZodError' })],
    ['UnauthorizedError', errWith({ name: 'UnauthorizedError' })],
    ['HTTP 401', errWith({ status: 401 })],
    ['HTTP 403', errWith({ status: 403 })],
    ['HTTP 422', errWith({ status: 422 })],
  ])('treats %s as fatal', (_label, err) => {
    expect(classifyDlqError(err)).toBe('fatal');
  });

  it('lets nonRetryableErrors override a transient signal, case-insensitively', () => {
    const err = errWith({ code: 'ETIMEDOUT' });
    expect(classifyDlqError(err, { nonRetryableErrors: ['etimedout'] })).toBe('fatal');
  });

  it('honours custom nonRetryableErrors matched by name', () => {
    const err = errWith({ name: 'PoisonPillError' });
    expect(classifyDlqError(err, { nonRetryableErrors: ['PoisonPillError'] })).toBe('fatal');
  });

  it('marks unknown errors and non-Error throwables as unclassified', () => {
    expect(classifyDlqError(new Error('something odd'))).toBe('unclassified');
    expect(classifyDlqError('string failure')).toBe('unclassified');
    expect(classifyDlqError(undefined)).toBe('unclassified');
  });
});

describe('computeBackoffDelayMs', () => {
  const cfg = { baseDelayMs: 1000, maxDelayMs: 10_000 };

  it('doubles the ceiling each retry', () => {
    // random=1 -> delay equals the ceiling
    expect([1, 2, 3, 4].map((n) => computeBackoffDelayMs(n, cfg, () => 1))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoffDelayMs(10, cfg, () => 1)).toBe(10_000);
  });

  it('applies equal jitter within [ceiling/2, ceiling]', () => {
    expect(computeBackoffDelayMs(3, cfg, () => 0)).toBe(2000);
    expect(computeBackoffDelayMs(3, cfg, () => 0.5)).toBe(3000);
    expect(computeBackoffDelayMs(3, cfg, () => 0.999999)).toBeLessThanOrEqual(4000);
  });

  it('does not overflow for very large retry counts', () => {
    expect(computeBackoffDelayMs(10_000, cfg, () => 1)).toBe(10_000);
  });
});

describe('DlqManager.handleFailedJob', () => {
  it('schedules a delayed retry for a transient failure and records it', async () => {
    const { manager, queue, quarantineQueue, incidents } = setup();

    const decision = await manager.handleFailedJob(job(), errWith({ code: 'ECONNRESET' }));

    expect(decision).toEqual({ action: 'retry', delayMs: 750, attempt: 1 });
    expect(queue.add).toHaveBeenCalledWith(
      'send',
      { to: 'a@b.c', _dlq: { originalJobId: 'job-1', retryCount: 1 } },
      { delay: 750, jobId: 'job-1:dlq-retry-1' },
    );
    expect(quarantineQueue.add).not.toHaveBeenCalled();
    expect(incidents).toEqual([
      expect.objectContaining({
        queueName: 'emails',
        jobId: 'job-1',
        attempt: 1,
        outcome: 'retry_scheduled',
        errorClass: 'transient',
        retryDelayMs: 750,
        quarantineReason: null,
      }),
    ]);
  });

  it('quarantines a fatal validation error immediately with no retry', async () => {
    const { manager, queue, quarantineQueue, incidents } = setup();

    const decision = await manager.handleFailedJob(
      job(),
      errWith({ name: 'ValidationError' }, 'bad schema'),
    );

    expect(decision).toEqual({ action: 'quarantine', reason: 'fatal_error', attempt: 1 });
    expect(queue.add).not.toHaveBeenCalled();
    expect(quarantineQueue.add).toHaveBeenCalledTimes(1);
    expect(quarantineQueue.add.mock.calls[0][1]).toMatchObject({
      originalQueue: 'emails',
      originalJobId: 'job-1',
      reason: 'fatal_error',
      error: { name: 'ValidationError', message: 'bad schema' },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      outcome: 'quarantined',
      errorClass: 'fatal',
      quarantineReason: 'fatal_error',
      retryDelayMs: null,
    });
  });

  it('quarantines an auth error (HTTP 401) immediately', async () => {
    const { manager, queue, quarantineQueue } = setup();
    const decision = await manager.handleFailedJob(job(), errWith({ status: 401 }));
    expect(decision).toMatchObject({ action: 'quarantine', reason: 'fatal_error' });
    expect(queue.add).not.toHaveBeenCalled();
    expect(quarantineQueue.add).toHaveBeenCalledTimes(1);
  });

  it('quarantines an unclassified error rather than replaying it', async () => {
    const { manager, queue } = setup();
    const decision = await manager.handleFailedJob(job(), new Error('something odd'));
    expect(decision).toMatchObject({ action: 'quarantine', reason: 'unclassified_error' });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('retries a transient failure up to 5 times, then permanently quarantines', async () => {
    const { manager, queue, quarantineQueue, incidents } = setup();
    const err = errWith({ code: 'ETIMEDOUT' });

    // Simulate BullMQ: each re-added job fails again with the data we enqueued.
    let current = job();
    const decisions = [];
    for (let i = 0; i < 6; i++) {
      const d = await manager.handleFailedJob(current, err);
      decisions.push(d.action);
      if (d.action === 'retry') {
        const [name, data] = queue.add.mock.calls[queue.add.mock.calls.length - 1];
        current = { id: `job-1:dlq-retry-${d.attempt}`, name, data };
      }
    }

    expect(decisions).toEqual(['retry', 'retry', 'retry', 'retry', 'retry', 'quarantine']);
    expect(queue.add).toHaveBeenCalledTimes(5);
    expect(quarantineQueue.add).toHaveBeenCalledTimes(1);
    expect(incidents.map((i) => i.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(incidents.map((i) => i.jobId)).toEqual(Array(6).fill('job-1'));
    expect(incidents[5]).toMatchObject({
      outcome: 'quarantined',
      errorClass: 'transient',
      quarantineReason: 'retries_exhausted',
    });
  });

  it('uses increasing backoff delays across retries', async () => {
    const { manager, queue } = setup({ baseDelayMs: 100, maxDelayMs: 100_000 }, () => 1);
    const err = errWith({ code: 'ECONNREFUSED' });
    let current = job();
    for (let i = 0; i < 4; i++) {
      const d = await manager.handleFailedJob(current, err);
      if (d.action !== 'retry') throw new Error('expected retry');
      const [name, data] = queue.add.mock.calls[i];
      current = { id: 'x', name, data };
    }
    const delays = queue.add.mock.calls.map((c) => c[2].delay);
    expect(delays).toEqual([100, 200, 400, 800]);
  });

  it('respects a custom maxAttempts', async () => {
    const { manager, queue } = setup({ maxAttempts: 1 });
    const err = errWith({ code: 'ECONNRESET' });

    const first = await manager.handleFailedJob(job(), err);
    expect(first.action).toBe('retry');
    const [name, data] = queue.add.mock.calls[0];
    const second = await manager.handleFailedJob({ id: 'r', name, data }, err);
    expect(second).toMatchObject({ action: 'quarantine', reason: 'retries_exhausted' });
  });

  it('keeps the original job id across retries', async () => {
    const { manager, incidents } = setup();
    const retried = job({ _dlq: { originalJobId: 'orig-9', retryCount: 2 } }, 'orig-9:dlq-retry-2');
    await manager.handleFailedJob(retried, errWith({ status: 502 }));
    expect(incidents[0]).toMatchObject({ jobId: 'orig-9', attempt: 3 });
  });

  it('still retries/quarantines when writing history fails', async () => {
    const { manager, queue, history, logger } = setup();
    history.record.mockRejectedValueOnce(new Error('db down'));

    const decision = await manager.handleFailedJob(job(), errWith({ code: 'ECONNRESET' }));

    expect(decision.action).toBe('retry');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to write dlq_incident_history',
      expect.objectContaining({ jobId: 'job-1', error: 'db down' }),
    );
  });

  it('propagates enqueue failures and records nothing for the failed retry', async () => {
    const { manager, queue, incidents } = setup();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      manager.handleFailedJob(job(), errWith({ code: 'ECONNRESET' })),
    ).rejects.toThrow('redis down');
    expect(incidents).toHaveLength(0);
  });

  it('uses defaults of 5 retries and a non-empty nonRetryableErrors list', () => {
    expect(DEFAULT_DLQ_RETRY_CONFIG.maxAttempts).toBe(5);
    expect(DEFAULT_DLQ_RETRY_CONFIG.nonRetryableErrors.length).toBeGreaterThan(0);
  });
});

describe('DlqManager.attachTo', () => {
  it('handles worker failed events and ignores undefined jobs', async () => {
    const { manager, queue } = setup();
    let listener: ((j: DlqJobLike | undefined, e: Error) => void) | undefined;
    manager.attachTo({
      on: (_evt, cb) => {
        listener = cb;
      },
    });

    listener!(undefined, new Error('x'));
    listener!(job(), errWith({ code: 'ECONNRESET' }));
    await new Promise((r) => setImmediate(r));

    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('logs instead of throwing when handling a failure itself fails', async () => {
    const { manager, queue, logger } = setup();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    let listener: ((j: DlqJobLike | undefined, e: Error) => void) | undefined;
    manager.attachTo({
      on: (_evt, cb) => {
        listener = cb;
      },
    });

    listener!(job(), errWith({ code: 'ECONNRESET' }));
    await new Promise((r) => setImmediate(r));

    expect(logger.error).toHaveBeenCalledWith(
      'DLQ manager failed to handle job failure',
      expect.objectContaining({ error: 'redis down' }),
    );
  });
});

describe('PgDlqIncidentStore', () => {
  it('inserts an incident into dlq_incident_history with positional params', async () => {
    const db = { query: vi.fn().mockResolvedValue({}) };
    await new PgDlqIncidentStore(db).record({
      queueName: 'emails',
      jobId: 'job-1',
      jobName: 'send',
      attempt: 2,
      outcome: 'retry_scheduled',
      errorClass: 'transient',
      errorName: 'Error',
      errorMessage: 'boom',
      retryDelayMs: 1500,
      quarantineReason: null,
    });

    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO dlq_incident_history');
    expect(values).toEqual([
      'emails',
      'job-1',
      'send',
      2,
      'retry_scheduled',
      'transient',
      'Error',
      'boom',
      1500,
      null,
    ]);
  });
});
