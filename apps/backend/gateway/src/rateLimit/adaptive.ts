import os from 'os';
import type { Request, Response, NextFunction } from 'express';

export interface LoadStatus {
  cpuPercent: number;
  memoryPercent: number;
  isOverloaded: boolean;
}

let currentStatus: LoadStatus = {
  cpuPercent: 0,
  memoryPercent: 0,
  isOverloaded: false,
};

let samplingInterval: ReturnType<typeof setInterval> | null = null;
let lastCpus = os.cpus();

function calculateCpuPercent(startCpus: os.CpuInfo[], endCpus: os.CpuInfo[]): number {
  let totalIdle = 0;
  let totalTick = 0;

  for (let i = 0; i < startCpus.length; i++) {
    const start = startCpus[i]?.times;
    const end = endCpus[i]?.times;
    
    if (!start || !end) continue;

    const idle = end.idle - start.idle;
    const total = 
      (end.user - start.user) +
      (end.nice - start.nice) +
      (end.sys - start.sys) +
      (end.irq - start.irq) +
      idle;

    totalIdle += idle;
    totalTick += total;
  }

  if (totalTick === 0) return 0;
  return 100 - (100 * totalIdle / totalTick);
}

export function startMetricsSampling(intervalMs = 5000) {
  if (samplingInterval) {
    clearInterval(samplingInterval);
  }

  lastCpus = os.cpus();

  samplingInterval = setInterval(() => {
    const currentCpus = os.cpus();
    const cpuPercent = calculateCpuPercent(lastCpus, currentCpus);
    lastCpus = currentCpus;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memoryPercent = ((totalMem - freeMem) / totalMem) * 100;

    const isOverloaded = cpuPercent > 80 || memoryPercent > 80;

    currentStatus = {
      cpuPercent,
      memoryPercent,
      isOverloaded,
    };
  }, intervalMs);
  
  samplingInterval.unref();
}

export function stopMetricsSampling() {
  if (samplingInterval) {
    clearInterval(samplingInterval);
    samplingInterval = null;
  }
}

export function getLoadStatus(): LoadStatus {
  return currentStatus;
}

export function adaptiveRateLimitingMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Determine if it is a low-priority background endpoint
    // We will assume any request with 'x-priority': 'low' or matching '/background/' is low priority
    // if the task isn't specific
    const isLowPriority = req.headers['x-priority'] === 'low' || req.path.includes('/background/');
    
    if (currentStatus.isOverloaded && isLowPriority) {
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'System is currently overloaded. Low priority requests are dropped.',
      });
      return;
    }
    
    next();
  };
}
