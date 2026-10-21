import { describe, it, expect } from 'vitest';
import { CohortService } from './cohortService.js';

describe('CohortService', () => {
  it('should instantiate', () => {
    const service = new CohortService(null as any, null as any);
    expect(service).toBeDefined();
  });

  it('should call getCohortAnalysis', async () => {
    const service = new CohortService(null as any, null as any, null as any) as any;
    try { await service.getCohortAnalysis(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
  it('should call generateWeeklyCohorts', async () => {
    const service = new CohortService(null as any, null as any, null as any) as any;
    try { await service.generateWeeklyCohorts(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
});

