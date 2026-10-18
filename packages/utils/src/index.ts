export {
  createLogger,
  getLogContext,
  runWithLogContext,
  type Logger,
  type LogContext,
} from "./logger.js";
export { CORRELATION_ID_HEADER, correlationMiddleware, fetchWithCorrelation } from "./correlation.js";
export { stroopsToDisplay, displayToStroops } from "./currency.js";
export { addDecimalStrings, sumDecimalStrings } from "./decimalMath.js";
export {
  generateId,
  isValidStellarPublicKey,
  validatePublicKey,
  validatePublicKeyMiddleware,
  type PublicKeyValidationResult,
  type RequestHandler,
} from "./id.js";
export {
  startHttpServer,
  route,
  json,
  readBodyWithLimit,
  PayloadTooLargeError,
  DEFAULT_BODY_SIZE_LIMIT_BYTES,
  type Route,
  type RouteHandler,
  type HttpServerOptions,
} from "./http.js";
export {
  parseBigIntString,
  type BigIntStringParseResult,
  type ParseBigIntStringOptions,
} from "./parseBigIntString.js";
export {
  parseIsoDate,
  type IsoDateParseResult,
  type ParseIsoDateOptions,
} from "./parseIsoDate.js";
export * from "./pactBroker.js";
export * from "./k6Performance.js";
export * from "./chaosEngine.js";
export * from "./cicdManager.js";
export {
  aggregateStatus,
  createHealthRoutes,
  HealthRegistry,
  httpHealthCheck,
  renderDashboard,
  renderMetrics,
  type CheckResult,
  type DependencyConfig,
  type DependencyType,
  type HealthCheck,
  type HealthCheckConfig,
  type HealthCheckFn,
  type HealthMetrics,
  type HealthRouteOptions,
  type HealthStatus,
  type RegisterOptions,
  type ServiceHealth,
} from "./health/index.js";

// SLO Dashboard
export * from "./slo/index.js";

// Compression
export * from "./compression/index.js";

// Synthetic Monitoring
export * from "./synthetic/index.js";

export * from "./pentest.js";
export * from "./coverageGate.js";
export * from "./integrationFixtures.js";
export * from "./e2eRunner.js";
export {
  bucketFor,
  evaluateFlag,
  FeatureFlagStore,
  type FeatureFlag,
  type FlagValueType,
  type TargetingRule,
  type TargetingOperator,
  type FlagEvaluation,
  type EvaluationReason,
  type FlagAuditEntry,
} from "./featureFlags.js";
export {
  computeQueryDepth,
  computeQueryCost,
  checkQueryComplexity,
  paginatedFieldCost,
  DEFAULT_FIELD_COST,
  type QueryNode,
  type FieldCostEstimator,
  type QueryComplexityConfig,
  type QueryComplexityResult,
} from "./graphqlComplexity.js";
export { BatchLoader, type BatchFn } from "./batchLoader.js";
export {
  corsMiddleware,
  securityHeadersMiddleware,
  type CorsOptions,
  type CorsRejectionLog,
  type SecurityHeadersOptions,
} from "./security.js";
export {
  RedisPubSubManager,
  getRedisPubSubManager,
  resetRedisPubSubManager,
} from "./redis/index.js";
export type {
  PubSubChannel,
  PubSubMessage,
  PubSubSubscription,
  PubSubMetrics,
  PubSubHealth,
  PubSubConfig,
  DeadLetterMessage,
  MessageHandler,
  Serializer,
  SerializationFormat,
} from "./redis/types.js";

export {
  RedisStreamManager,
  createStreamManager,
} from "./redis/index.js";
export { safeParseStreamPayload } from "./redis/streams.js";
export type {
  StreamConfig,
  StreamEvent,
  ConsumerGroupState,
  StreamProcessingResult,
  StreamMessage,
  ParsedStreamMessage,
  StreamMessageEnvelope,
  ParseResult,
} from "./redis/streams.js";

export * from "./database/queryPerformance.js";
export * from "./database/tenantPoolManager.js";
export * from "./redis/clusterClient.js";
export {
  TaggedCache,
  type TaggedCacheEntry,
  type TaggedCacheRedisClient,
  type RedisPipeline,
  type SetOptions as TaggedCacheSetOptions,
  type InvalidationResult,
} from "./cache/taggedCache.js";
export {
  SlidingWindowRateLimiter,
  type RateLimitRedisClient,
  type RateLimitRule,
  type RateLimitTier,
  type RateLimitCheck,
  type RateLimitResult,
} from "./rateLimit/slidingWindowRateLimiter.js";
export {
  RedisSessionStore,
  type SessionRedisClient,
  type Session,
  type SessionConfig,
  type CreateSessionInput,
} from "./session/redisSessionStore.js";
export {
  ServiceMetricsRegistry,
  type Counter,
  type Gauge,
  type Histogram,
  type MetricSeries,
  type HistogramSeries,
  type RedMetrics,
  type AlertRule,
} from "./metrics/serviceMetrics.js";
export {
  escapeHtml,
  isPathTraversalSafe,
  validateSection,
  validateRequest,
  type FieldType,
  type ValidationRule,
  type ValidationSchema,
  type ValidationError,
  type ValidationResult,
} from "./inputValidation.js";
export {
  detectSuspiciousPatterns,
  buildSecurityEvents,
  validateFileUpload,
  type SecurityEventType,
  type SecurityEventSeverity,
  type SecurityEvent,
  type ValidationErrorList,
} from "./securityEventDetection.js";
export { requireAuth } from "./auth.js";
export { requireServiceAuth, SERVICE_AUTH_HEADER, type ServiceAuthOptions } from "./serviceAuth.js";
export {
  generateApiKey,
  verifyApiKey,
  rotateApiKey,
  computeRotationRevocationAt,
  isExpired,
  isIpAllowed,
  hasScope,
  authorizeApiKeyRequest,
  checkForCompromise,
  type ApiKeyStatus,
  type ApiKey,
  type ApiKeyConfig,
  type ApiKeyUsage,
  type GeneratedApiKey,
  type ApiKeyAuthDenialReason,
  type ApiKeyAuthResult,
  type CompromiseCheckInput,
  type CompromiseCheckResult,
} from "./apiKeyManagement.js";
export {
  sampleTrace,
  buildSpanAttributes,
  buildHttpSpanAttributes,
  buildDbSpanAttributes,
  buildErrorSpanAttributes,
  computeTraceMetrics,
  type SamplerType,
  type TraceExporterType,
  type Propagator,
  type TraceConfig,
  type SpanAttributes,
  type TraceMetrics,
  type SampleContext,
} from "./tracing.js";
export {
  formatLogEntry,
  serializeLogEntry,
  matchesLogQuery,
  validateRetentionPolicies,
  isLogPipelineHealthy,
  type LogLevel,
  type LogEntry,
  type LogQuery,
  type StorageClass,
  type LogRetentionPolicy,
  type LogMetrics,
  type RetentionValidationResult,
} from "./logAggregation.js";
export {
  compressLogChunk,
  decompressLogChunk,
  verifyLogChunkCompression,
  buildLogChunkArchival,
  isZstdCompressionSupported,
  LogChunkCompressionError,
  UnsupportedLogChunkCompressionError,
  DEFAULT_LOG_CHUNK_COMPRESSION_ALGORITHM,
  type LogChunkCompressionAlgorithm,
  type LogChunkCompressionOptions,
  type CompressedLogChunk,
  type LogChunkArchival,
  type LogChunkArchivalContext,
  type LogChunkCompressionVerification,
} from "./logChunkCompression.js";
export {
  runLogChunkBenchmark,
  printLogChunkBenchmark,
  type LogChunkBenchmarkOptions,
  type LogChunkBenchmarkEntry,
  type LogChunkBenchmarkResult,
} from "./logChunkCompressionBenchmark.js";
export * from "./softDelete/index.js";
export * from "./audit/index.js";
export * from "./encryption/index.js";
export * from "./carrier/index.js";
export * from "./containerDigest.js";
export * from "./telemetry/index.js";
export * from "./magicBytes.js";
