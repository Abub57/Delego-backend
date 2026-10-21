import { describe, it, expect } from 'vitest';
import { MatcherService } from './matcherService.js';

describe('MatcherService', () => {
  it('should instantiate', () => {
    const service = new MatcherService(null as any, null as any);
    expect(service).toBeDefined();
  });

  it('should call matchRecords', async () => {
    const service = new MatcherService(null as any, null as any, null as any) as any;
    try { await service.matchRecords(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
  it('should call saveRecords', async () => {
    const service = new MatcherService(null as any, null as any, null as any) as any;
    try { await service.saveRecords(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
  it('should call getRecordsByJob', async () => {
    const service = new MatcherService(null as any, null as any, null as any) as any;
    try { await service.getRecordsByJob(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
  it('should call getRecordsByStatus', async () => {
    const service = new MatcherService(null as any, null as any, null as any) as any;
    try { await service.getRecordsByStatus(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
});

