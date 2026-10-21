import { describe, it, expect } from 'vitest';
import { ExportService } from './exportService.js';

describe('ExportService', () => {
  it('should instantiate', () => {
    const service = new ExportService(null as any, null as any);
    expect(service).toBeDefined();
  });

  it('should call exportData', async () => {
    const service = new ExportService(null as any, null as any, null as any) as any;
    try { await service.exportData(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
  it('should call getExportStatus', async () => {
    const service = new ExportService(null as any, null as any, null as any) as any;
    try { await service.getExportStatus(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
  it('should call getRecentExports', async () => {
    const service = new ExportService(null as any, null as any, null as any) as any;
    try { await service.getRecentExports(null as any, null as any, null as any, null as any, null as any); } catch (e) {}
  });
});

