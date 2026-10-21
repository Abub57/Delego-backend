import { Queue, Worker, QueueEvents, UnrecoverableError } from "bullmq";
import { Redis } from "ioredis";
// @ts-ignore
import MockRedis from "ioredis-mock";
import { 
  Keypair, 
  Horizon, 
  rpc, 
  TransactionBuilder, 
  Networks, 
  Operation, 
  nativeToScVal,
  Address,
  Account
} from "@stellar/stellar-sdk";
import type { TransactionRequest, TransactionResult } from "@delegolabs/types";
import { vaultService } from "../vault.js";
import { createLogger, withSpan } from "@delegolabs/utils";
import {
  classifySubmissionFailure,
  type SubmissionFailure,
} from "./submissionFailure.js";
import { SorobanTransactionSimulator, readSorobanRpcConfig } from "../sorobanSimulator.js";
import { getTransactionFee } from "../dynamicFee.js";
import {
  recordAuditEntry,
  recordLockAcquisition,
  recordLockRelease,
  recordContentionEvent,
  detectSequenceGap,
} from "./sequenceMonitoring.js";
import { addToDLQ } from "./transactionDLQ.js";
import { insertAuditLog } from "../transactions/auditLog.js";
import { createHorizonServer, isMockModeEnabled, type MockHorizonServer } from "../../stellar/mockHorizon.js";

export { classifySubmissionFailure, type SubmissionFailure } from "./submissionFailure.js";

const log = createLogger("wallet:queue", process.env.LOG_LEVEL ?? "info");

/**
 * BullMQ worker lock/retry configuration — Issue #340.
 *
 * `lockDuration` / `lockRenewTime` are passed straight to the BullMQ
 * `Worker`; `attempts` / `backoff` describe the job-level retry policy
 * already in effect below. Surfaced as a type so the deadlock-prevention
 * settings have one documented, testable shape instead of being scattered
 * magic numbers.
 */
export interface QueueRetryConfig {
  attempts: number;
  backoff: { type: "exponential"; delay: number };
  lockDuration: number;
  lockRenewTime: number;
}

export const DEFAULT_QUEUE_RETRY_CONFIG: QueueRetryConfig = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  // A job lock is held for 30s; renewed every 10s. If a worker can't renew
  // (e.g. its connection is mid-reconnect during a Sentinel failover), the
  // lock expires in bounded time instead of being held forever, so BullMQ's
  // stalled-job detection can reclaim it rather than deadlock.
  lockDuration: 30_000,
  lockRenewTime: 10_000,
};

/**
 * Parse `REDIS_SENTINELS` ("host:port,host:port,...") into the ioredis
 * `sentinels` option shape. Returns `null` when unset so callers fall back
 * to a plain single-node connection.
 */
function sentinelNodesFromEnv(): Array<{ host: string; port: number }> | null {
  const raw = process.env.REDIS_SENTINELS?.trim();
  if (!raw) return null;
  return raw.split(",").map((entry) => {
    const [host, portStr] = entry.trim().split(":");
    return { host, port: Number(portStr ?? 26379) };
  });
}

export interface XdrValidationResult {
  valid: boolean;
  sizeBytes: number;
  maxBytes: number;
  error?: string;
}

export function validateXdrSize(request: TransactionRequest): XdrValidationResult {
  const sizeBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  const raw = Number(process.env.MAX_XDR_BYTES ?? 65536);
  const maxBytes = isNaN(raw) || raw <= 0 ? 65536 : raw;
  const valid = sizeBytes <= maxBytes;
  return valid
    ? { valid: true, sizeBytes, maxBytes }
    : {
        valid: false,
        sizeBytes,
        maxBytes,
        error: `Payload too large: ${sizeBytes} bytes exceeds limit of ${maxBytes} bytes`,
      };
}

let redisClient: Redis;
let txQueue: Queue | null = null;
let txWorker: Worker | null = null;
let queueEvents: QueueEvents | null = null;

export interface SequenceReservation {
  account: string;
  firstSequence: string;
  lastSequence: string;
  size: number;
  leaseId: string;
  expiresAt: string;
}

export interface TransactionJobStatus {
  jobId: string;
  status: "queued" | "processing" | "submitted" | "failed";
  txHash?: string;
  error?: string;
}

export interface LedgerSubmissionCheck {
  txHash: string;
  status: "confirmed" | "missing" | "failed";
  ledger?: number;
  checkedAt: string;
}

function throwClassifiedSubmissionFailure(
  failure: SubmissionFailure,
  attempt: number,
  request?: TransactionRequest,
  jobId?: string
): never {
  log.error("Transaction error in worker", {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    txHash: failure.txHash,
  });

  // Add terminal failures to DLQ
  if (!failure.retryable && request && jobId) {
    addToDLQ(
      `dlq_${jobId}_${Date.now()}`,
      jobId,
      request,
      failure,
      attempt
    ).catch((err) => {
      log.error("Failed to add to DLQ", { error: err.message });
    });
  }

  if (failure.retryable) {
    log.warn(`Retryable submission failure. Attempt ${attempt}/5`, {
      code: failure.code,
    });
    throw new Error(failure.message);
  }

  log.error("Terminal submission failure, failing job without retry", {
    code: failure.code,
  });
  throw new UnrecoverableError(`${failure.code}: ${failure.message}`);
}

const QUEUE_NAME = "stellar-tx-queue";

function getStellarConfig() {
  // Return mock config early if mock mode is enabled
  if (isMockModeEnabled()) {
    return {
      horizonUrl: "mock://horizon",
      rpcUrl: "mock://soroban-rpc",
      networkPassphrase: Networks.TESTNET,
    };
  }

  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  let horizonUrl = "https://horizon-testnet.stellar.org";
  let rpcUrl = "https://soroban-testnet.stellar.org";
  let networkPassphrase = Networks.TESTNET;

  if (network === "mainnet") {
    horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org";
    rpcUrl = process.env.STELLAR_RPC_URL ?? "https://rpc.stellar.org";
    networkPassphrase = Networks.PUBLIC;
  } else if (network === "futurenet") {
    horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon-futurenet.stellar.org";
    rpcUrl = process.env.STELLAR_RPC_URL ?? "https://rpc-futurenet.stellar.org";
    networkPassphrase = Networks.FUTURENET;
  } else {
    horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
    rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
    networkPassphrase = Networks.TESTNET;
  }

  return { horizonUrl, rpcUrl, networkPassphrase };
}

const STELLAR_STRKEY_RE = /^[GC][A-Z2-7]{55}$/;

function argToScVal(arg: unknown, typeHint?: string): ReturnType<typeof nativeToScVal> {
  if (typeof arg === "string" && STELLAR_STRKEY_RE.test(arg)) {
    try {
      if (typeHint === "address") {
        return Address.fromString(arg).toScVal();
      }
      // Fall back to default encoding when strkey checksum is invalid.
    } catch {
      // Fall back to default encoding when strkey checksum is invalid.
    }
  }
  if (typeHint) {
    try {
      return nativeToScVal(arg, { type: typeHint as never });
    } catch {
      // fall back to untyped conversion when the hint is not applicable
    }
  }
  return nativeToScVal(arg);
}

// Check if we should use MockRedis (for testing or if Redis is not configured)
export function getRedisConnection(): Redis {
  if (redisClient) return redisClient;

  const isTest = process.env.NODE_ENV === "test";
  const redisUrl = process.env.REDIS_URL;
  const redisHost = process.env.REDIS_HOST ?? "localhost";
  const redisPort = Number(process.env.REDIS_PORT ?? 6379);

  if (isTest || (!redisUrl && redisHost === "localhost" && (process.env.MOCK_REDIS === "true" || process.env.CI === "true"))) {
    log.info("Using mock Redis connection");
    const MockRedisConstructor = MockRedis as any;
    redisClient = new MockRedisConstructor();
  } else {
    const sentinels = sentinelNodesFromEnv();

    if (sentinels) {
      // Issue #340: a Sentinel-aware connection re-discovers the promoted
      // master automatically when Sentinel fails over, instead of staying
      // pinned to the old (now demoted) master's host:port. That stale
      // pinning is what previously left BullMQ workers hanging indefinitely
      // while trying to renew job locks against a dead connection.
      const masterName = process.env.REDIS_SENTINEL_MASTER ?? "mymaster";
      log.info("Connecting to real Redis via Sentinel", { sentinels, masterName });

      redisClient = new Redis({
        sentinels,
        name: masterName,
        role: "master",
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        // Bounds how long any single command (including a lock-renewal
        // command issued mid-failover) can hang before failing fast.
        commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? 5000),
        sentinelRetryStrategy: (times: number) => Math.min(times * 100, 2000),
        retryStrategy: (times: number) => Math.min(times * 100, 2000),
      });

      redisClient.on("+switch-master", (...args: unknown[]) => {
        log.warn("Redis Sentinel promoted a new master — reconnected automatically", { args });
      });
    } else {
      log.info("Connecting to real Redis", { redisUrl, redisHost, redisPort });
      if (redisUrl) {
        redisClient = new Redis(redisUrl, { maxRetriesPerRequest: null });
      } else {
        redisClient = new Redis({
          host: redisHost,
          port: redisPort,
          maxRetriesPerRequest: null
        });
      }
    }

    redisClient.on("error", (err: any) => {
      log.error("Redis connection error", { error: err.message });
    });
  }

  return redisClient;
}

function generateLeaseId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}`;
}

async function getActiveReservations(
  account: string,
  redis: Redis
): Promise<SequenceReservation[]> {
  const key = `seq:reservations:${account}`;
  const reservationsJson = await redis.lrange(key, 0, -1);
  const now = Date.now();
  
  const activeReservations: SequenceReservation[] = [];
  const toDelete: string[] = [];
  
  for (const json of reservationsJson) {
    try {
      const reservation = JSON.parse(json) as SequenceReservation;
      if (parseInt(reservation.expiresAt) > now) {
        activeReservations.push(reservation);
      } else {
        toDelete.push(json);
      }
    } catch {
      toDelete.push(json);
    }
  }
  
  // Clean up expired or invalid reservations
  if (toDelete.length > 0) {
    for (const json of toDelete) {
      await redis.lrem(key, 0, json);
    }
  }
  
  return activeReservations;
}

export async function reserveSequenceBlock(
  address: string,
  size: number,
  redis: Redis,
  horizonServer: Pick<Horizon.Server, "loadAccount">
): Promise<SequenceReservation> {
  const accountKey = `seq:reservations:${address}`;
  const lockKey = `seq:lock:${address}`;
  const lockTimeout = 5000; // 5 seconds lock timeout
  
  // Acquire lock with retry
  let lockAcquired = false;
  const maxRetries = 20;
  const retryDelay = 50; // 50ms
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await redis.set(lockKey, "locked", "PX", lockTimeout, "NX");
    if (res) {
      lockAcquired = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
  
  if (!lockAcquired) {
    await recordContentionEvent(address, redis);
    throw new Error("Failed to acquire sequence reservation lock");
  }
  
  try {
    await recordLockAcquisition(address, "txQueue", redis);

    // Load account from Horizon to get the source account details
    const sourceAccount = await horizonServer.loadAccount(address);
    const ledgerSequence = BigInt(sourceAccount.sequenceNumber());
    
    // Get active reservations and find next available starting point
    const activeReservations = await getActiveReservations(address, redis);
    
    // Find the highest used sequence from active reservations
    let highestReservedSequence = ledgerSequence;
    for (const res of activeReservations) {
      const resLast = BigInt(res.lastSequence);
      if (resLast > highestReservedSequence) {
        highestReservedSequence = resLast;
      }
    }
    
    // Create new reservation
    const firstSequence = highestReservedSequence + 1n;
    const lastSequence = firstSequence + BigInt(size) - 1n;
    const leaseId = generateLeaseId();
    const now = Date.now();
    const ttl = 60 * 60 * 1000; // 1 hour lease
    const expiresAt = (now + ttl).toString();
    
    const reservation: SequenceReservation = {
      account: address,
      firstSequence: firstSequence.toString(),
      lastSequence: lastSequence.toString(),
      size,
      leaseId,
      expiresAt
    };
    
    // Store reservation
    await redis.rpush(accountKey, JSON.stringify(reservation));
    await redis.expire(accountKey, ttl / 1000);
    
    log.info("Reserved sequence block", {
      account: address,
      firstSequence: firstSequence.toString(),
      lastSequence: lastSequence.toString(),
      size,
      leaseId
    });
    
    await recordAuditEntry(address, "reserve", redis, leaseId, firstSequence.toString(),
      `Reserved ${size} sequences: ${firstSequence}-${lastSequence}`);

    return reservation;
  } finally {
    // Release lock
    await redis.del(lockKey);
    await recordLockRelease(address, redis);
  }
}

async function getNextSequenceFromReservation(
  address: string,
  redis: Redis
): Promise<{ sequence: string; reservation: SequenceReservation; releaseReservation: () => Promise<void> } | null> {
  const key = `seq:reservations:${address}`;
  const now = Date.now();
  
  const reservationsJson = await redis.lrange(key, 0, -1);
  
  for (const json of reservationsJson) {
    try {
      const reservation = JSON.parse(json) as SequenceReservation;
      
      // Skip expired reservations
      if (parseInt(reservation.expiresAt) <= now) {
        continue;
      }
      
      // Get current cursor for this reservation
      const cursorKey = `seq:res:${reservation.leaseId}:cursor`;
      let cursorStr = await redis.get(cursorKey);
      let cursor = cursorStr ? BigInt(cursorStr) : BigInt(reservation.firstSequence);
      
      const lastSeq = BigInt(reservation.lastSequence);
      
      if (cursor <= lastSeq) {
        // Increment cursor atomically
        const newCursor = cursor + 1n;
        await redis.set(cursorKey, newCursor.toString(), "PX", parseInt(reservation.expiresAt) - Date.now());
        
        await recordAuditEntry(address, "consume", redis, reservation.leaseId, cursor.toString(),
          `Consumed sequence ${cursor} from reservation ${reservation.leaseId}`);

        const releaseReservation = async () => {
          // Check if reservation is exhausted
          if (newCursor > lastSeq) {
            await redis.lrem(key, 0, json);
            await redis.del(cursorKey);
            await recordAuditEntry(address, "expire", redis, reservation.leaseId, undefined,
              `Reservation ${reservation.leaseId} exhausted`);
          }
        };
        
        return {
          sequence: cursor.toString(),
          reservation,
          releaseReservation
        };
      }
    } catch {
      continue;
    }
  }
  
  return null;
}

// Synchronize and manage sequence numbers thread-safely per source address in Redis
async function getNextSequenceNumber(
  horizonServer: Pick<Horizon.Server, "loadAccount">,
  sourceAddress: string,
  redis: Redis,
  attempt: number
): Promise<{ sequence: string; resetCache: () => Promise<void> }> {
  const cacheKey = `seq:${sourceAddress}`;
  const reservationKey = `seq:reservations:${sourceAddress}`;
  
  const resetCache = async () => {
    await redis.del(cacheKey);
    // Clear all reservations on reset
    await redis.del(reservationKey);
    // Clear all reservation cursors
    const cursorKeys = await redis.keys(`seq:res:*:cursor`);
    if (cursorKeys.length > 0) {
      await redis.del(...cursorKeys);
    }
    await recordAuditEntry(sourceAddress, "expire", redis, undefined, undefined,
      "Cache and reservations reset");
    log.info("Cleared cached sequence number and reservations from Redis", { sourceAddress });
  };

  // If this is a retry attempt, clear the cached sequence number from Redis to force a fresh reload from Horizon
  if (attempt > 1) {
    await resetCache();
  }

  // First try to get a sequence from an existing reservation
  let reservationResult = await getNextSequenceFromReservation(sourceAddress, redis);
  
  if (reservationResult) {
    log.info("Using sequence from existing reservation", {
      sourceAddress,
      sequence: reservationResult.sequence,
      leaseId: reservationResult.reservation.leaseId
    });
    
    // Detect gaps between current sequence and expected
    const expectedSeq = BigInt(reservationResult.reservation.firstSequence);
    const actualSeq = BigInt(reservationResult.sequence);
    if (actualSeq > expectedSeq + 1n) {
      await detectSequenceGap(
        sourceAddress,
        expectedSeq.toString(),
        actualSeq.toString(),
        redis
      );
    }
    
    return {
      sequence: reservationResult.sequence,
      resetCache: async () => {
        await reservationResult.releaseReservation();
        await resetCache();
      }
    };
  }

  // Load account from Horizon to get the source account details
  log.info("Loading account details from Horizon...", { sourceAddress });
  const sourceAccount = await horizonServer.loadAccount(sourceAddress);
  const ledgerSequence = BigInt(sourceAccount.sequenceNumber());

  // Check Redis for cached sequence number (fallback for backward compatibility)
  const cachedSeqStr = await redis.get(cacheKey);
  
  let nextSequence: bigint;
  if (cachedSeqStr) {
    const cachedSequence = BigInt(cachedSeqStr);
    // Use the maximum of ledger sequence and cached sequence
    if (cachedSequence >= ledgerSequence) {
      nextSequence = cachedSequence + 1n;
    } else {
      nextSequence = ledgerSequence + 1n;
    }
  } else {
    nextSequence = ledgerSequence + 1n;
  }

  // Save the new sequence number back to Redis with a TTL of 60 seconds (fallback)
  await redis.set(cacheKey, nextSequence.toString(), "EX", 60);
  log.info("Determined sequence number (fallback)", { 
    sourceAddress, 
    ledgerSequence: ledgerSequence.toString(), 
    cachedSequence: cachedSeqStr ?? "none",
    usingSequence: nextSequence.toString() 
  });

  // Return the sequence number minus 1 to build with since TransactionBuilder increments it
  const buildSequence = (nextSequence - 1n).toString();
  return { sequence: buildSequence, resetCache };
}

/**
 * True when `err` looks like a Soroban RPC gateway timeout (HTTP 504) or
 * service-unavailable (503) — the class of error Issue #336 reports being
 * treated as a permanent submission failure even though the transaction may
 * already have reached the network.
 */
function isRpcGatewayTimeout(err: unknown): boolean {
  const status = (err as { response?: { status?: number }; status?: number } | undefined)?.response
    ?.status ?? (err as { status?: number } | undefined)?.status;
  if (status === 504 || status === 503) return true;

  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /\b(504|503)\b/.test(message) || /gateway timeout|service unavailable/i.test(message);
}

/**
 * After a gateway timeout on submission, polls transaction status by hash
 * before giving up — the envelope may have reached consensus even though
 * the RPC call that submitted it never returned. Returns the confirmed
 * result when found, or `null` when the transaction genuinely isn't on
 * chain (safe to let the caller surface a retryable failure).
 */
async function reconcileTimedOutSubmission(
  rpcServer: rpc.Server,
  txHash: string
): Promise<TransactionResult | null> {
  const maxAttempts = process.env.NODE_ENV === "test" ? 2 : 6; // ~30s of polling in production
  const delayMs = process.env.NODE_ENV === "test" ? 10 : 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const status = await rpcServer.getTransaction(txHash);
      if (status.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const successTx = status as rpc.Api.GetSuccessfulTransactionResponse;
        log.info("Timed-out submission confirmed on-chain; treating as success (no resubmission)", { txHash });
        return { hash: txHash, ledger: successTx.ledger, success: true };
      }
      if (status.status === rpc.Api.GetTransactionStatus.FAILED) {
        log.warn("Timed-out submission resolved to FAILED on-chain", { txHash });
        return null;
      }
      // NOT_FOUND — keep polling; the ledger may not have closed yet.
    } catch (err: unknown) {
      log.warn("Status reconciliation lookup failed after gateway timeout; will retry", {
        txHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return null;
}

async function executeTxJob(
  request: TransactionRequest, 
  attempt: number, 
  connection: Redis
): Promise<TransactionResult> {
  const { horizonUrl, rpcUrl, networkPassphrase } = getStellarConfig();
  const horizonServer = createHorizonServer(horizonUrl);
  const rpcServer = new rpc.Server(rpcUrl);

  // 1. Fetch private key from Vault
  const secret = await vaultService.getKey(request.sourceAddress);
  const signerKeypair = Keypair.fromSecret(secret);

  // 2. Thread-safe sequence number retrieval
  const { sequence, resetCache } = await getNextSequenceNumber(
    horizonServer,
    request.sourceAddress,
    connection,
    attempt
  );

  // Create dummy Account object with current sequence number
  const account = new Account(request.sourceAddress, sequence);
  let txHash: string | undefined;

  try {
    // 3. Convert arguments to ScVals
    const scArgs = request.args.map((arg, index) =>
      argToScVal(arg, request.argTypes?.[index]),
    );

    // 4. Build draft transaction using the thread-safe sequence number
    let tx = new TransactionBuilder(account, {
      fee: await getTransactionFee(horizonUrl),
      networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: request.contractId,
          function: request.method,
          args: scArgs,
        })
      )
      .setTimeout(30)
      .build();

    // 5. Simulate to construct Soroban footprint details using SorobanTransactionSimulator
    const simulatorConfig = readSorobanRpcConfig();
    const simulator = new SorobanTransactionSimulator(simulatorConfig);
    
    log.info("Simulating transaction to estimate gas and footprint...", {
      rpcUrl: simulatorConfig.rpcUrl,
      timeoutMs: simulatorConfig.timeoutMs,
      maxRetries: simulatorConfig.maxRetries
    });
    
    const simRes = await simulator.simulateTransaction(tx);

    if (!rpc.Api.isSimulationSuccess(simRes)) {
      const failureReasons = simulator.detectFailureReasons(simRes);
      log.error("Transaction simulation failed", {
        reasons: failureReasons,
        error: simRes.error || "Unknown error"
      });
      throw new Error(`Transaction simulation failed: ${failureReasons.join(", ") || JSON.stringify(simRes)}`);
    }

    // Log simulation success details for debugging
    const feeEstimates = simulator.extractFeeEstimates(simRes);
    log.info("Transaction simulation succeeded", {
      minResourceFee: simRes.minResourceFee,
      cpuInstructions: feeEstimates.cpu,
      memoryBytes: feeEstimates.memory
    });

    // 6. Assemble transaction with footprints and sign
    tx = rpc.assembleTransaction(tx, simRes).build();
    tx.sign(signerKeypair);

    // Compute the hash before submission so it's available for status
    // reconciliation even when the RPC call itself throws (Issue #336) —
    // previously `txHash` only got set from `sendRes.hash` on a clean
    // response, so a gateway timeout left us with no hash to check status
    // against.
    txHash = tx.hash().toString("hex");

    // 7. Submit transaction to RPC server
    log.info("Submitting transaction to Stellar network...", { hash: txHash });

    let sendRes: Awaited<ReturnType<typeof rpcServer.sendTransaction>>;
    try {
      sendRes = await withSpan("stellar.sendTransaction", () => rpcServer.sendTransaction(tx), { "peer.service": "stellar-rpc" });
    } catch (sendErr: unknown) {
      if (isRpcGatewayTimeout(sendErr)) {
        // The RPC node (or an intermediary gateway) timed out before
        // confirming receipt. The envelope may still have reached the
        // network — assuming failure here would resubmit under a stale
        // sequence, colliding with the original transaction once it lands.
        // Reconcile via status lookup instead of treating this as a
        // permanent failure.
        log.warn("Soroban RPC gateway timeout on submit; reconciling via status lookup instead of failing immediately", {
          txHash,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
        const reconciled = await reconcileTimedOutSubmission(rpcServer, txHash);
        if (reconciled) {
          // Audit: record successful signing (gateway-timeout reconciliation path)
          if (request.walletId) {
            try {
              await insertAuditLog({ walletId: request.walletId, status: "SUCCESS", txHash });
            } catch (auditErr: any) {
              log.error("Failed to insert signing audit log (success, timeout reconciliation)", { error: auditErr.message });
            }
          } else {
            log.warn("walletId not available; skipping signing audit log (success, timeout reconciliation)");
          }
          return reconciled;
        }

        throw new Error(
          `Submission failed: RPC gateway timeout (504/503) and transaction not found on-chain: ${
            sendErr instanceof Error ? sendErr.message : String(sendErr)
          }`
        );
      }
      throw sendErr;
    }

    if (sendRes.status === "ERROR") {
      const errorMsg = JSON.stringify(sendRes);
      // If sequence number error, clear cache so we fetch fresh next time
      if (errorMsg.includes("tx_bad_seq") || errorMsg.includes("bad_seq")) {
        await resetCache();
      }
      throw new Error(`Submission failed: ${errorMsg}`);
    }

    // 8. Poll for transaction result
    txHash = sendRes.hash;
    log.info("Waiting for transaction confirmation...", { txHash });

    let retries = 12; // Poll for ~1 minute (5s intervals)

    while (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, process.env.NODE_ENV === "test" ? 10 : 5000));

      let txStatus: Awaited<ReturnType<typeof rpcServer.getTransaction>>;
      try {
        txStatus = await rpcServer.getTransaction(txHash);
      } catch (statusErr: unknown) {
        if (isRpcGatewayTimeout(statusErr)) {
          // A transient gateway blip while polling shouldn't abort the whole
          // job — just consume a retry slot and poll again.
          log.warn("Soroban RPC gateway timeout while polling transaction status; retrying poll", {
            txHash,
            retriesLeft: retries - 1,
          });
          retries--;
          continue;
        }
        throw statusErr;
      }

      if (txStatus.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const successTx = txStatus as rpc.Api.GetSuccessfulTransactionResponse;
        log.info("Transaction completed successfully", { txHash });

        // Record spend in Redis after successful confirmation
        if (request.userId && request.walletId && request.amountStroops) {
          try {
            const { recordSpend } = await import("../spendLimits.js");
            const amount = BigInt(request.amountStroops);
            if (amount > 0n) {
              await recordSpend(request.userId, request.walletId, amount);
            }
          } catch (err: any) {
            log.error("Failed to record spend in Redis", { error: err.message });
          }
        }

        // Audit: record successful signing
        if (request.walletId) {
          try {
            await insertAuditLog({ walletId: request.walletId, status: "SUCCESS", txHash });
          } catch (auditErr: any) {
            log.error("Failed to insert signing audit log (success)", { error: auditErr.message });
          }
        } else {
          log.warn("walletId not available; skipping signing audit log (success)");
        }

        return {
          hash: txHash,
          ledger: successTx.ledger,
          success: true
        };
      } else if (txStatus.status === rpc.Api.GetTransactionStatus.FAILED) {
        const failedTx = txStatus as rpc.Api.GetFailedTransactionResponse;
        const errXdrStr = typeof failedTx.resultXdr === "string" 
          ? failedTx.resultXdr 
          : failedTx.resultXdr?.toXDR().toString("base64") ?? "Unknown error XDR";
        
        log.error("Transaction execution failed", { txHash, error: errXdrStr });
        
        // Check if failure is transient or if it's a sequence error
        if (errXdrStr.includes("tx_bad_seq") || errXdrStr.includes("bad_seq")) {
          await resetCache();
        }
        throw new Error(`Transaction failed: ${errXdrStr}`);
      }
      
      retries--;
    }

    const isConfirmed = await verifyLedgerSubmission(txHash);
    if (isConfirmed) {
      log.info("Transaction confirmed on ledger despite polling timeout", { txHash });

      // Audit: record successful signing (fallback confirmation path)
      if (request.walletId) {
        try {
          await insertAuditLog({ walletId: request.walletId, status: "SUCCESS", txHash });
        } catch (auditErr: any) {
          log.error("Failed to insert signing audit log (success, fallback)", { error: auditErr.message });
        }
      } else {
        log.warn("walletId not available; skipping signing audit log (success, fallback)");
      }

      return { hash: txHash, ledger: 0, success: true };
    }
    throw new Error(`Transaction timeout or status untracked: ${sendRes.status}`);
  } catch (err: unknown) {
    const failure = classifySubmissionFailure(err, { txHash });

    // Audit terminal (non-retryable) failures only — transient retries are not final outcomes
    if (!failure.retryable) {
      if (request.walletId) {
        try {
          await insertAuditLog({ walletId: request.walletId, status: "FAILURE", txHash: null });
        } catch (auditErr: any) {
          log.error("Failed to insert signing audit log (failure)", { error: auditErr.message });
        }
      } else {
        log.warn("walletId not available; skipping signing audit log (failure)");
      }
    }

    throwClassifiedSubmissionFailure(failure, attempt, request, undefined);
  }
}

let testPromiseChain = Promise.resolve();

async function runTestJob(request: TransactionRequest, connection: Redis): Promise<TransactionResult> {
  const resultPromise = testPromiseChain.then(async () => {
    let attemptsMade = 0;
    const maxAttempts = 5;
    
    while (attemptsMade < maxAttempts) {
      try {
        const result = await executeTxJob(request, attemptsMade + 1, connection);
        return result;
      } catch (err: unknown) {
        attemptsMade++;
        if (err instanceof UnrecoverableError) {
          throw err;
        }

        const failure = classifySubmissionFailure(err);
        if (failure.retryable && attemptsMade < maxAttempts) {
          log.warn(`Test runner: Retryable submission failure, retrying... Attempt ${attemptsMade}/${maxAttempts}`, {
            code: failure.code,
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Job failed after max attempts");
  });

  // Append to the chain, swallowing errors so subsequent tests run
  testPromiseChain = resultPromise.then(() => {}).catch(() => {});

  return resultPromise;
}

async function verifyLedgerSubmission(hash: string): Promise<boolean> {
  const { horizonUrl } = getStellarConfig();
  const horizonServer = createHorizonServer(horizonUrl);

  try {
    await horizonServer.transactions().transaction(hash).call();
    return true;
  } catch (err: any) {
    // Handle both real Horizon errors and mock errors
    const isNotFound = err.response?.status === 404 || err.message?.includes("not found");
    if (isNotFound) {
      return false;
    }
    return false;
  }
}

export function initQueue() {
  const isTest = process.env.NODE_ENV === "test";
  if (isTest) {
    return { txQueue: null, txWorker: null, queueEvents: null };
  }

  if (txQueue) return { txQueue, txWorker, queueEvents };

  const connection = getRedisConnection();

  txQueue = new Queue(QUEUE_NAME, {
    connection: connection as any,
    defaultJobOptions: {
      attempts: DEFAULT_QUEUE_RETRY_CONFIG.attempts,
      backoff: DEFAULT_QUEUE_RETRY_CONFIG.backoff,
      removeOnComplete: true,
      removeOnFail: false,
    }
  });

  // Concurrency set to 1 ensures that jobs are executed in strict order
  txWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const attempt = job.attemptsMade + 1;
      log.info(`Processing transaction job ${job.id}`, { attempt, request: job.data });
      return executeTxJob(job.data, attempt, connection);
    },
    {
      connection: connection as any,
      concurrency: 1, // Strict sequential processing
      // Issue #340: explicit lock duration/renew time bound how long a job
      // lock can be held without a successful renewal. Combined with
      // stalled-job detection below, a worker whose connection hangs during
      // a Redis Sentinel failover loses its lock and has the job reclaimed
      // instead of deadlocking indefinitely.
      lockDuration: DEFAULT_QUEUE_RETRY_CONFIG.lockDuration,
      lockRenewTime: DEFAULT_QUEUE_RETRY_CONFIG.lockRenewTime,
      maxStalledCount: 2,
      stalledInterval: DEFAULT_QUEUE_RETRY_CONFIG.lockDuration,
    }
  );

  queueEvents = new QueueEvents(QUEUE_NAME, { connection: connection as any });

  return { txQueue, txWorker, queueEvents };
}

export async function addTransactionToQueue(request: TransactionRequest): Promise<TransactionResult> {
  // XDR payload size guard — must be the first check
  const xdrResult = validateXdrSize(request);
  if (!xdrResult.valid) {
    log.warn("XDR payload size exceeded", { sizeBytes: xdrResult.sizeBytes, maxBytes: xdrResult.maxBytes });
    throw new Error(xdrResult.error);
  }

  // Check spend limit first
  let userId = request.userId;
  let walletId = request.walletId;
  const delegationId = request.delegationId ?? null;
  const amountStroops = request.amountStroops ? BigInt(request.amountStroops) : 0n;

  if (!userId || !walletId) {
    try {
      const { Wallet } = await import("../models/Wallet.js");
      const wallet = await Wallet.findOne({
        where: { stellarAddress: request.sourceAddress }
      });
      if (wallet) {
        userId = userId || wallet.userId;
        walletId = walletId || wallet.id;
      }
    } catch (err: any) {
      log.warn("Could not load wallet from DB for limit check, continuing without limit checks", { error: err.message });
    }
  }

  if (userId && walletId) {
    try {
      const { checkSpendLimit } = await import("../spendLimits.js");
      const checkResult = await checkSpendLimit(userId, walletId, delegationId, amountStroops);
      if (!checkResult.allowed) {
        throw new Error(`Spending limit exceeded: ${checkResult.reason || "limit exceeded"}`);
      }
      request.userId = userId;
      request.walletId = walletId;
      request.delegationId = delegationId;
      request.amountStroops = amountStroops.toString();
    } catch (err: any) {
      if (err.message.includes("Spending limit exceeded")) {
        throw err;
      }
      log.warn("Could not check spend limit due to DB error, continuing", { error: err.message });
    }
  }

  const isTest = process.env.NODE_ENV === "test";
  const connection = getRedisConnection();

  if (isTest) {
    log.info("Running transaction in test mode (bypassing BullMQ)");
    return runTestJob(request, connection);
  }

  const { txQueue } = initQueue();
  if (!txQueue) {
    throw new Error("Transaction queue is not initialized");
  }

  // Create a unique job ID per source address to guarantee order if desired, or let BullMQ handle auto IDs
  const job = await txQueue.add("submit-tx", request);
  log.info(`Enqueued transaction job ${job.id}`, { request });

  // Wait for the job to complete and return the result
  const { queueEvents: qEvents } = initQueue();
  if (!qEvents) {
    throw new Error("QueueEvents is not initialized");
  }

  return new Promise<TransactionResult>((resolve, reject) => {
    const onCompleted = ({ jobId, returnvalue }: { jobId: string, returnvalue: string }) => {
      if (jobId === job.id) {
        cleanup();
        try {
          const result = JSON.parse(returnvalue) as TransactionResult;
          resolve(result);
        } catch (e) {
          // If returnvalue is already an object
          resolve(returnvalue as unknown as TransactionResult);
        }
      }
    };

    const onFailed = ({ jobId, failedReason }: { jobId: string, failedReason: string }) => {
      if (jobId === job.id) {
        cleanup();
        reject(new Error(failedReason || "Transaction job failed in worker"));
      }
    };

    const cleanup = () => {
      qEvents.off("completed", onCompleted);
      qEvents.off("failed", onFailed);
    };

    qEvents.on("completed", onCompleted);
    qEvents.on("failed", onFailed);
  });
}

export async function getJobStatus(jobId: string): Promise<TransactionJobStatus | null> {
  const { txQueue: queue } = initQueue();
  if (!queue) {
    return null;
  }

  const job = await queue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  let status: TransactionJobStatus["status"];

  if (state === "waiting" || state === "delayed" || state === "waiting-children") {
    status = "queued";
  } else if (state === "active") {
    status = "processing";
  } else if (state === "completed") {
    status = "submitted";
  } else if (state === "failed") {
    status = "failed";
  } else {
    // unknown or any future BullMQ state — treat as queued rather than failed
    status = "queued";
  }

  const result: TransactionJobStatus = { jobId, status };

  if (state === "completed" && job.returnvalue) {
    try {
      const rv =
        typeof job.returnvalue === "string"
          ? (JSON.parse(job.returnvalue) as { hash?: string })
          : (job.returnvalue as { hash?: string });
      if (rv.hash) result.txHash = rv.hash;
    } catch {
      // returnvalue not parseable — leave txHash unset
    }
  }

  if (state === "failed" && job.failedReason) {
    result.error = job.failedReason;
  }

  return result;
}

export async function closeQueue() {
  if (txWorker) {
    await txWorker.close();
    txWorker = null;
  }
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }
  if (txQueue) {
    await txQueue.close();
    txQueue = null;
  }
  if (redisClient) {
    await redisClient.quit();
    // @ts-ignore
    redisClient = null;
  }
}

export {
  submitTransactionBatch,
  estimateBatchGas,
  type BatchGasEstimate,
  type BatchSubmissionResult,
} from "../batchSubmitter.js";

