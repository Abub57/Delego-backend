# Structured Logging with Pino

## Overview

The Delego Gateway implements JSON-structured logging using [Pino](https://getpino.io/), a high-performance Node.js logger. All logs are emitted as newline-delimited JSON (NDJSON), enabling seamless integration with log aggregation services like Datadog, ELK Stack, CloudWatch, and Splunk.

## Features

✅ **JSON-Structured Output** - All logs are valid JSON with consistent schema  
✅ **Request ID Correlation** - Every request gets a unique ID propagated through all logs  
✅ **Child Loggers** - Module-specific loggers with additional context  
✅ **Configurable Log Levels** - Control verbosity via `LOG_LEVEL` environment variable  
✅ **Performance** - Pino is one of the fastest Node.js loggers available  
✅ **Production-Ready** - Pretty-printing in development, NDJSON in production  

---

## Quick Start

### Basic Logging

```typescript
import { logger } from "./logger.js";

// Log at different levels
logger.info("Application started");
logger.warn("Configuration missing", { key: "API_KEY" });
logger.error("Database connection failed", { error: err.message });
logger.debug("Processing request", { userId: "123" });
```

### Request Context Logging

```typescript
// In route handlers, use req.log to include request ID automatically
export function createUserHandler(req: IncomingMessage, res: ServerResponse) {
  req.log.info("Creating new user", { email: user.email });
  
  try {
    const user = await createUser(data);
    req.log.info("User created successfully", { userId: user.id });
    return user;
  } catch (error) {
    req.log.error("User creation failed", { error: error.message });
    throw error;
  }
}
```

### Child Loggers for Modules

```typescript
import { createChildLogger } from "./logger.js";

const log = createChildLogger({ module: "auth", component: "jwt" });

log.info("Generating JWT token", { userId: "123" });
log.error("Token validation failed", { reason: "expired" });
```

---

## Log Format

### Standard Log Entry

```json
{
  "level": 30,
  "time": "2026-09-28T12:34:56.789Z",
  "pid": 12345,
  "hostname": "gateway-01",
  "service": "gateway",
  "env": "production",
  "msg": "User login successful",
  "userId": "user-123",
  "duration": 245
}
```

### Log Entry with Request Context

```json
{
  "level": 30,
  "time": "2026-09-28T12:34:56.789Z",
  "pid": 12345,
  "hostname": "gateway-01",
  "service": "gateway",
  "env": "production",
  "reqId": "550e8400-e29b-41d4-a716-446655440000",
  "request": {
    "method": "POST",
    "url": "/api/v1/delegations"
  },
  "msg": "Creating delegation",
  "walletId": "wallet-456"
}
```

### Error Log Entry

```json
{
  "level": 50,
  "time": "2026-09-28T12:34:56.789Z",
  "pid": 12345,
  "hostname": "gateway-01",
  "service": "gateway",
  "env": "production",
  "reqId": "550e8400-e29b-41d4-a716-446655440000",
  "msg": "Database query failed",
  "error": {
    "type": "Error",
    "message": "Connection timeout",
    "stack": "Error: Connection timeout\n    at Database.query (/app/db.ts:45:11)"
  },
  "query": "SELECT * FROM users"
}
```

---

## Configuration

### Environment Variables

```bash
# Set log level (default: info)
LOG_LEVEL=debug

# Available levels (from most to least verbose):
# - trace
# - debug
# - info (default)
# - warn
# - error
# - fatal

# Set environment (affects formatting)
NODE_ENV=production  # NDJSON output
NODE_ENV=development # Pretty-printed output with colors
```

### Log Levels

| Level | Numeric Value | Use Case |
|-------|--------------|----------|
| `trace` | 10 | Extremely detailed debugging information |
| `debug` | 20 | Debugging information for developers |
| `info` | 30 | General informational messages |
| `warn` | 40 | Warning messages for potential issues |
| `error` | 50 | Error messages for failures |
| `fatal` | 60 | Fatal errors requiring immediate attention |

---

## Request ID Correlation

### How It Works

1. **Incoming Request**: Middleware extracts `x-request-id` from headers
2. **Generate if Missing**: If no header exists, generates UUID v4
3. **Attach to Response**: Sets `x-request-id` response header for client tracing
4. **Create Child Logger**: Attaches logger with request ID to `req.log`
5. **Automatic Propagation**: All logs from `req.log` include the request ID

### Example Flow

```
Client Request
    ↓
[x-request-id: abc-123] OR [Generate: abc-123]
    ↓
Middleware attaches req.log with reqId
    ↓
Route Handler uses req.log
    ↓
All logs include { reqId: "abc-123" }
    ↓
Response includes [x-request-id: abc-123] header
```

### Client Usage

```bash
# Client sends request with correlation ID
curl -H "x-request-id: my-trace-123" \
     https://api.delego.dev/api/v1/users

# Gateway logs all operations with reqId: "my-trace-123"

# Response includes header:
# x-request-id: my-trace-123
```

---

## Integration

### Middleware Setup

The logging middleware is configured in `src/index.ts`:

```typescript
import { requestLoggingMiddleware } from "./logger.js";

startHttpServer({
  middleware: [
    // Must be first to capture all requests
    requestLoggingMiddleware(),
    // ... other middleware
  ],
  routes: registerRoutes(),
});
```

### Automatic Request/Response Logging

The middleware automatically logs:

```json
// Incoming request
{
  "level": 30,
  "reqId": "550e8400-e29b-41d4-a716-446655440000",
  "request": {
    "method": "GET",
    "url": "/api/v1/delegations",
    "headers": {
      "host": "api.delego.dev",
      "user-agent": "curl/7.88.1"
    }
  },
  "msg": "Incoming GET /api/v1/delegations"
}

// Completed response
{
  "level": 30,
  "reqId": "550e8400-e29b-41d4-a716-446655440000",
  "response": {
    "statusCode": 200
  },
  "duration": 127,
  "msg": "Completed GET /api/v1/delegations - 200"
}
```

### Health Check Exclusion

Health check endpoints are excluded from auto-logging to reduce noise:

- `/health`
- `/healthz`
- `/ready`
- `/health/*`

---

## Usage Patterns

### 1. Application-Level Logging

```typescript
import { logger } from "./logger.js";

// Startup logs
logger.info("Gateway starting", { port: 3000, env: "production" });

// Configuration logs
logger.warn("Using default configuration", { key: "JWT_SECRET" });

// Shutdown logs
logger.info("Graceful shutdown initiated");
```

### 2. Request-Scoped Logging

```typescript
export async function getDelegationHandler(
  req: IncomingMessage,
  res: ServerResponse
) {
  const { id } = req.params;
  
  req.log.info("Fetching delegation", { delegationId: id });
  
  try {
    const delegation = await Delegation.findByPk(id);
    
    if (!delegation) {
      req.log.warn("Delegation not found", { delegationId: id });
      return notFound(res, "Delegation not found");
    }
    
    req.log.info("Delegation retrieved", {
      delegationId: id,
      status: delegation.status,
    });
    
    return success(res, delegation);
  } catch (error) {
    req.log.error("Failed to fetch delegation", {
      delegationId: id,
      error: error.message,
    });
    return internalError(res, "Failed to fetch delegation");
  }
}
```

### 3. Module-Specific Logging

```typescript
// auth/service.ts
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "auth" });

export async function validateToken(token: string) {
  log.debug("Validating JWT token", { tokenLength: token.length });
  
  try {
    const decoded = jwt.verify(token, secret);
    log.info("Token validated", { userId: decoded.userId });
    return decoded;
  } catch (error) {
    log.error("Token validation failed", {
      error: error.message,
      tokenLength: token.length,
    });
    throw error;
  }
}
```

### 4. Error Logging

```typescript
try {
  await processPayment(paymentData);
} catch (error) {
  // Log error with full context
  req.log.error("Payment processing failed", {
    error: error.message,
    stack: error.stack,
    paymentId: paymentData.id,
    amount: paymentData.amount,
    currency: paymentData.currency,
  });
  
  // Pino automatically serializes Error objects
  req.log.error("Payment error", { err: error });
}
```

### 5. Performance Logging

```typescript
const start = Date.now();

const result = await expensiveOperation();

req.log.info("Operation completed", {
  operation: "expensiveOperation",
  duration: Date.now() - start,
  resultSize: result.length,
});
```

### 6. Structured Metadata

```typescript
// Good: Structured metadata
req.log.info("User updated", {
  userId: user.id,
  email: user.email,
  fieldsChanged: ["email", "displayName"],
  updatedBy: req.user.id,
});

// Bad: Unstructured string concatenation
req.log.info(`User ${user.id} updated by ${req.user.id}`);
```

---

## Log Aggregation Integration

### Datadog

```json
// Logs are automatically parsed
{
  "service": "gateway",
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "level": "info",
  "message": "User created",
  "userId": "123"
}
```

### ELK Stack (Elasticsearch, Logstash, Kibana)

```conf
# Logstash configuration
input {
  file {
    path => "/var/log/gateway/*.log"
    codec => json
  }
}

filter {
  json {
    source => "message"
  }
}

output {
  elasticsearch {
    hosts => ["localhost:9200"]
    index => "gateway-logs-%{+YYYY.MM.dd}"
  }
}
```

### AWS CloudWatch

```typescript
// CloudWatch Logs automatically parses JSON
// Query example:
// fields @timestamp, msg, reqId, userId
// | filter service = "gateway"
// | filter level >= 40
// | sort @timestamp desc
```

### Splunk

```conf
# props.conf
[gateway-logs]
INDEXED_EXTRACTIONS = json
KV_MODE = json
TIME_PREFIX = "time":"
TIME_FORMAT = %Y-%m-%dT%H:%M:%S.%3NZ
```

---

## Testing

### Running Tests

```bash
# Run all gateway tests
pnpm test --filter @delegolabs/gateway

# Run only logger tests
pnpm test --filter @delegolabs/gateway logger

# Watch mode
pnpm test --filter @delegolabs/gateway logger --watch
```

### Test Coverage

The test suite covers:

✅ JSON-structured output validation  
✅ Request ID extraction and generation  
✅ Request ID correlation across logs  
✅ Response header propagation  
✅ Child logger context inheritance  
✅ Log level configuration  
✅ Error object serialization  
✅ Async operation request ID persistence  

---

## Best Practices

### ✅ Do

```typescript
// Use structured metadata
req.log.info("User login", { userId: "123", method: "oauth" });

// Include contextual information
req.log.error("Payment failed", {
  error: error.message,
  paymentId: payment.id,
  amount: payment.amount,
  retryCount: 3,
});

// Use appropriate log levels
req.log.debug("Cache hit", { key: cacheKey });
req.log.info("Order placed", { orderId: order.id });
req.log.warn("Rate limit approaching", { remaining: 5 });
req.log.error("Database connection failed", { err: error });

// Log business events
req.log.info("Delegation created", {
  delegationId: delegation.id,
  userId: req.user.id,
  walletId: delegation.walletId,
});
```

### ❌ Don't

```typescript
// Don't use string concatenation
req.log.info(`User ${userId} logged in at ${timestamp}`);

// Don't log sensitive data (passwords, tokens, credit cards)
req.log.info("User authenticated", { password: user.password }); // ❌

// Don't use console.log
console.log("User created:", user); // ❌

// Don't mix log levels inappropriately
req.log.error("User logged in"); // ❌ (should be info)
req.log.info("Database crashed"); // ❌ (should be error)
```

---

## Performance Considerations

### Pino Performance Benefits

- **Asynchronous Logging**: Logs are written asynchronously, minimizing impact on request latency
- **Fast JSON Serialization**: Uses optimized JSON.stringify
- **Minimal Overhead**: ~1-2ms per log statement
- **No String Interpolation**: Structured logging avoids expensive string operations

### Development vs Production

```typescript
// Development: Pretty-printed logs with colors
{
  level: 30,
  time: 2026-09-28T12:34:56.789Z,
  service: gateway,
  msg: User created
  userId: 123
}

// Production: NDJSON (one line per log)
{"level":30,"time":"2026-09-28T12:34:56.789Z","service":"gateway","msg":"User created","userId":"123"}
```

---

## Migration Guide

### Replacing console.log

```typescript
// Before
console.log("User created:", userId);

// After
logger.info("User created", { userId });
```

### Replacing console.error

```typescript
// Before
console.error("Payment failed:", error);

// After
logger.error("Payment failed", { err: error });
```

### Replacing console.warn

```typescript
// Before
console.warn("Rate limit approaching for user", userId);

// After
logger.warn("Rate limit approaching", { userId });
```

---

## Troubleshooting

### Issue: Logs not appearing

**Solution**: Check log level configuration
```bash
LOG_LEVEL=debug npm run dev
```

### Issue: Request ID not in logs

**Solution**: Ensure middleware is first in the stack
```typescript
middleware: [
  requestLoggingMiddleware(), // Must be first
  // ... other middleware
]
```

### Issue: Logs not parsing in aggregator

**Solution**: Verify JSON output
```bash
# Check log format
npm run dev | head -1 | jq .
```

### Issue: Too many logs

**Solution**: Adjust log level
```bash
LOG_LEVEL=warn npm run dev
```

---

## API Reference

### logger

Root logger instance for application-level logging.

```typescript
import { logger } from "./logger.js";

logger.trace(msg, meta?);
logger.debug(msg, meta?);
logger.info(msg, meta?);
logger.warn(msg, meta?);
logger.error(msg, meta?);
logger.fatal(msg, meta?);
```

### requestLoggingMiddleware()

Middleware that adds request logging with correlation IDs.

```typescript
import { requestLoggingMiddleware } from "./logger.js";

const middleware = requestLoggingMiddleware();
```

### createChildLogger(context)

Creates a child logger with additional context.

```typescript
import { createChildLogger } from "./logger.js";

const authLogger = createChildLogger({ module: "auth" });
```

### isLogLevelEnabled(level)

Checks if a log level is enabled.

```typescript
import { isLogLevelEnabled } from "./logger.js";

if (isLogLevelEnabled("debug")) {
  // Expensive debug operation
}
```

### LOG_LEVELS

Numeric log level constants.

```typescript
import { LOG_LEVELS } from "./logger.js";

console.log(LOG_LEVELS.info); // 30
```

---

## Further Reading

- [Pino Documentation](https://getpino.io/)
- [Structured Logging Best Practices](https://www.innoq.com/en/blog/structured-logging/)
- [Distributed Tracing](https://opentelemetry.io/docs/concepts/observability-primer/#distributed-tracing)
- [Log Levels Guide](https://stackoverflow.com/questions/2031163/when-to-use-the-different-log-levels)
