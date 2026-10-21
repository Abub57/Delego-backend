/**
 * Circuit Breaker Middleware for HTTP Request Pipeline
 *
 * This middleware integrates with the existing circuit breaker implementation
 * to provide graceful degradation when downstream services are unavailable.
 * It returns 503 Service Unavailable responses with Retry-After headers
 * when circuits are open.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { 
  getCircuitBreaker, 
  type DownstreamService,
  getAllCircuitBreakerStats
} from "../circuitBreaker.js";

// Simple logger for this middleware
function createSimpleLogger(name: string) {
  return {
    info: (message: string, metadata?: any) => 
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", service: name, message, ...metadata })),
    warn: (message: string, metadata?: any) => 
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "warn", service: name, message, ...metadata })),
    error: (message: string, metadata?: any) => 
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: name, message, ...metadata }))
  };
}

const log = createSimpleLogger("gateway:circuit-breaker-middleware");

/**
 * Maps request paths to downstream services for circuit breaker routing
 */
function getDownstreamServiceFromPath(path: string): DownstreamService | null {
  // Remove query parameters and normalize path
  const normalizedPath = path.split('?')[0].toLowerCase();
  
  // Map API paths to downstream services
  if (normalizedPath.includes('/orchestrator') || 
      normalizedPath.includes('/orders') || 
      normalizedPath.includes('/delegations')) {
    return 'orchestrator';
  }
  
  if (normalizedPath.includes('/wallet') || 
      normalizedPath.includes('/balance') || 
      normalizedPath.includes('/transactions')) {
    return 'wallet';
  }
  
  if (normalizedPath.includes('/payment') || 
      normalizedPath.includes('/billing') || 
      normalizedPath.includes('/invoice')) {
    return 'payments';
  }
  
  return null;
}

/**
 * Circuit breaker middleware that checks circuit state before allowing requests
 * to proceed to downstream services.
 */
export function circuitBreakerMiddleware() {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: any) => void
  ): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;
      
      // Skip circuit breaker for health checks and internal routes
      if (path === "/health" || path === "/metrics" || path.startsWith("/internal/")) {
        next();
        return;
      }
      
      // Determine which downstream service this request targets
      const downstreamService = getDownstreamServiceFromPath(path);
      
      if (!downstreamService) {
        // Request doesn't target a known downstream service, allow through
        next();
        return;
      }
      
      const circuitBreaker = getCircuitBreaker(downstreamService);
      const currentState = circuitBreaker.getState();
      
      if (currentState === "open") {
        // Circuit is open, reject request immediately
        const stats = circuitBreaker.getStats();
        const retryAfterSeconds = Math.ceil(30); // 30 second cooldown as per requirements
        
        log.warn("Request blocked by circuit breaker", {
          service: downstreamService,
          path,
          method: req.method,
          state: currentState,
          failureCount: stats.failureCount,
          totalRejections: stats.totalRejections + 1
        });
        
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Retry-After", retryAfterSeconds.toString());
        res.setHeader("X-Circuit-Breaker-Service", downstreamService);
        res.setHeader("X-Circuit-Breaker-State", currentState);
        
        const errorResponse = {
          error: "Service Unavailable",
          message: `The ${downstreamService} service is currently unavailable. Please try again later.`,
          service: downstreamService,
          retryAfter: retryAfterSeconds,
          timestamp: new Date().toISOString()
        };
        
        res.end(JSON.stringify(errorResponse));
        return;
      }
      
      // Circuit is closed or half-open, allow request to proceed
      if (currentState === "half_open") {
        log.info("Allowing test request through half-open circuit", {
          service: downstreamService,
          path,
          method: req.method
        });
      }
      
      next();
      
    } catch (error) {
      log.error("Circuit breaker middleware error", {
        error: error instanceof Error ? error.message : String(error),
        path: req.url,
        method: req.method
      });
      
      // Don't block requests due to middleware errors
      next();
    }
  };
}

/**
 * Health endpoint middleware that exposes circuit breaker status
 */
export function circuitBreakerHealthMiddleware() {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void): void => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    
    if (url.pathname === "/circuit-breakers" && req.method === "GET") {
      const stats = getAllCircuitBreakerStats();
      
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      
      const response = {
        timestamp: new Date().toISOString(),
        circuitBreakers: stats
      };
      
      res.end(JSON.stringify(response, null, 2));
      return;
    }
    
    next();
  };
}

/**
 * Utility function to manually trigger circuit breaker state changes
 * for testing purposes
 */
export function createCircuitBreakerTestMiddleware() {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void): void => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    
    if (url.pathname === "/internal/circuit-breakers" && req.method === "POST") {
      // Only allow in development/test environments
      if (process.env.NODE_ENV === "production") {
        res.statusCode = 404;
        res.end();
        return;
      }
      
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          const { service, action } = JSON.parse(body);
          
          if (!["orchestrator", "wallet", "payments"].includes(service)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid service" }));
            return;
          }
          
          const circuitBreaker = getCircuitBreaker(service as DownstreamService);
          
          if (action === "reset") {
            circuitBreaker.reset();
            log.info("Circuit breaker manually reset", { service });
          }
          
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ 
            service, 
            action, 
            state: circuitBreaker.getState(),
            stats: circuitBreaker.getStats()
          }));
          
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Invalid request body" }));
        }
      });
      
      return;
    }
    
    next();
  };
}