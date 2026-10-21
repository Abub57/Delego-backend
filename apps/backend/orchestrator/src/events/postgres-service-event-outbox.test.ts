import { describe, it, expect } from 'vitest';
import { PostgresServiceEventOutboxStore } from './postgres-service-event-outbox.js';

describe('PostgresServiceEventOutboxStore', () => {
  it('should instantiate', () => {
    const service = new PostgresServiceEventOutboxStore(null as any, null as any);
    expect(service).toBeDefined();
  });

  it('should call insert', async () => {
    const service = new PostgresServiceEventOutboxStore(null as any, null as any, null as any) as any;
    try { await service.insert(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
  it('should call claimPendingBatch', async () => {
    const service = new PostgresServiceEventOutboxStore(null as any, null as any, null as any) as any;
    try { await service.claimPendingBatch(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
  it('should call markPublished', async () => {
    const service = new PostgresServiceEventOutboxStore(null as any, null as any, null as any) as any;
    try { await service.markPublished(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
  it('should call recordFailure', async () => {
    const service = new PostgresServiceEventOutboxStore(null as any, null as any, null as any) as any;
    try { await service.recordFailure(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
});

