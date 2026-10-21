import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import { 
  startMetricsSampling, 
  stopMetricsSampling, 
  getLoadStatus,
  adaptiveRateLimitingMiddleware 
} from "./adaptive.js";
import type { Request, Response, NextFunction } from "express";

describe("Adaptive Rate Limiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopMetricsSampling();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("samples system metrics and correctly updates status", () => {
    // Mock os.cpus() and os.totalmem(), os.freemem()
    const cpusMock = vi.spyOn(os, "cpus");
    const totalmemMock = vi.spyOn(os, "totalmem").mockReturnValue(1000);
    const freememMock = vi.spyOn(os, "freemem").mockReturnValue(100); // 90% used

    const mockCpuInfo1 = [{
      model: "Intel", speed: 2000,
      times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 }
    }] as os.CpuInfo[];

    const mockCpuInfo2 = [{
      model: "Intel", speed: 2000,
      times: { user: 200, nice: 0, sys: 200, idle: 800, irq: 0 } // 200 total active ticks added, 0 idle ticks added -> 100% CPU
    }] as os.CpuInfo[];

    cpusMock.mockReturnValueOnce(mockCpuInfo1).mockReturnValue(mockCpuInfo2);

    startMetricsSampling(5000);
    
    // initially not overloaded (because values haven't updated)
    let status = getLoadStatus();
    expect(status.cpuPercent).toBe(0);

    // fast forward 5 seconds
    vi.advanceTimersByTime(5000);

    status = getLoadStatus();
    expect(status.memoryPercent).toBe(90);
    expect(status.cpuPercent).toBe(100);
    expect(status.isOverloaded).toBe(true);
  });

  it("middleware blocks low priority requests when overloaded", () => {
    // force overloaded
    const totalmemMock = vi.spyOn(os, "totalmem").mockReturnValue(1000);
    const freememMock = vi.spyOn(os, "freemem").mockReturnValue(100); // 90% used
    
    // Start it
    startMetricsSampling(5000);
    vi.advanceTimersByTime(5000); // trigger overload
    
    const req = {
      headers: { 'x-priority': 'low' },
      path: '/some-endpoint'
    } as unknown as Request;
    
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    
    const next = vi.fn() as NextFunction;
    
    const middleware = adaptiveRateLimitingMiddleware();
    middleware(req, res, next);
    
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Service Unavailable' }));
    expect(next).not.toHaveBeenCalled();
  });

  it("middleware allows high priority requests when overloaded", () => {
    const totalmemMock = vi.spyOn(os, "totalmem").mockReturnValue(1000);
    const freememMock = vi.spyOn(os, "freemem").mockReturnValue(100); // 90% used
    
    startMetricsSampling(5000);
    vi.advanceTimersByTime(5000);
    
    const req = {
      headers: {},
      path: '/important-endpoint'
    } as unknown as Request;
    
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    
    const next = vi.fn() as NextFunction;
    
    const middleware = adaptiveRateLimitingMiddleware();
    middleware(req, res, next);
    
    expect(next).toHaveBeenCalled();
  });

  it("middleware allows low priority requests when not overloaded", () => {
    const totalmemMock = vi.spyOn(os, "totalmem").mockReturnValue(1000);
    const freememMock = vi.spyOn(os, "freemem").mockReturnValue(900); // 10% used
    const cpusMock = vi.spyOn(os, "cpus").mockReturnValue([
      { model: "Intel", speed: 2000, times: { user: 100, nice: 0, sys: 100, idle: 8000, irq: 0 } }
    ] as os.CpuInfo[]);

    startMetricsSampling(5000);
    vi.advanceTimersByTime(5000);
    
    const req = {
      headers: { 'x-priority': 'low' },
      path: '/background/sync'
    } as unknown as Request;
    
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    
    const next = vi.fn() as NextFunction;
    
    const middleware = adaptiveRateLimitingMiddleware();
    middleware(req, res, next);
    
    expect(next).toHaveBeenCalled();
  });
});
