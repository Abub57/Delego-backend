import {
  Transaction,
  // @ts-ignore
  xdr,
  rpc as SorobanRpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  getCachedSimulation,
  setCachedSimulation,
  setInFlightSimulation,
} from "./simulationCache.js";
import { ServiceMetricsRegistry } from "@delegolabs/utils";

type SimulateTransactionResponse = SorobanRpc.Api.SimulateTransactionResponse;

export interface SorobanRpcConfig {
  rpcUrl: string;
  timeoutMs: number;
  maxRetries: number;
  metricsRegistry?: ServiceMetricsRegistry;
}

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : fallback;
}

export function readSorobanRpcConfig(): SorobanRpcConfig {
  const rawUrl = process.env.SOROBAN_RPC_URL;
  const rpcUrl = rawUrl && rawUrl.trim() !== "" ? rawUrl.trim() : "https://soroban-testnet.stellar.org";
  return {
    rpcUrl,
    timeoutMs: parsePositiveInt(process.env.SOROBAN_RPC_TIMEOUT_MS, DEFAULT_RPC_TIMEOUT_MS),
    maxRetries: parsePositiveInt(process.env.SOROBAN_RPC_MAX_RETRIES, DEFAULT_MAX_RETRIES),
  };
}

/**
 * Issue #346 — structured diagnostic info extracted from a failed Soroban
 * simulation, so clients get the actual CPU/RAM budget figures and raw
 * diagnostic events instead of an opaque, unparsed RPC error string.
 */
export interface SorobanSimulationDiagnostic {
  cpuInstructions: number;
  ramBytes: number;
  minResourceFee: string;
  events: Array<{ topics: string[]; data: string }>;
  errorDetail?: string;
}

export type SorobanSimulationErrorCode = "RESOURCE_LIMIT_EXCEEDED" | "SIMULATION_ERROR";

export interface SimulationResult {
  success: boolean;
  minResourceFee?: string;
  footprint?: string;
  error?: string;
  errorCode?: SorobanSimulationErrorCode;
  diagnostic?: SorobanSimulationDiagnostic;
}

// Soroban's host doesn't return CPU/memory budget exhaustion as structured
// JSON — it's embedded in the free-form simulation error string, e.g.
// "HostError: Error(Budget, ExceededLimit)". Matching on that (plus the
// more generic "resource limit exceeded" phrasing some RPC versions use)
// is how we tell a budget exhaustion apart from any other simulation
// failure (bad auth, missing contract, etc).
const RESOURCE_LIMIT_PATTERN = /Budget,\s*ExceededLimit|resource limit exceeded|exceeded.*(?:cpu|instructions?|memory)\s*(?:budget|limit)/i;

/**
 * Best-effort extraction of the CPU instruction / memory-byte figures the
 * host embeds inline in the error message. The RPC does not expose these
 * as separate response fields on error (only `minResourceFee` is
 * structured, and only on success), so we pull the numbers out by pattern
 * rather than assume a JSON shape that doesn't exist on the wire.
 */
function extractBudgetFigures(message: string): { cpuInstructions: number; ramBytes: number } {
  const cpuMatch = message.match(/(?:cpu|instructions?)\D{0,20}?(\d+)/i);
  const memMatch = message.match(/(?:mem(?:ory)?|ram|bytes?)\D{0,20}?(\d+)/i);
  return {
    cpuInstructions: cpuMatch ? Number(cpuMatch[1]) : 0,
    ramBytes: memMatch ? Number(memMatch[1]) : 0,
  };
}

/**
 * Converts the XDR diagnostic events on a simulation response into plain,
 * JSON-serializable topics/data so API clients don't need to touch XDR
 * themselves. Defensive against any single malformed event — one bad
 * event degrades to a placeholder string rather than dropping the whole
 * diagnostic payload (and masking the real error, which is the bug this
 * issue is about).
 */
function extractDiagnosticEvents(
  events: xdr.DiagnosticEvent[] | undefined,
): Array<{ topics: string[]; data: string }> {
  if (!events || events.length === 0) return [];

  return events.map((diagnosticEvent) => {
    try {
      const body = diagnosticEvent.event().body().v0();
      const topics = body.topics().map((topic) => {
        try {
          return JSON.stringify(scValToNative(topic));
        } catch {
          return "<unparsable topic>";
        }
      });
      let data: string;
      try {
        data = JSON.stringify(scValToNative(body.data()));
      } catch {
        data = "<unparsable data>";
      }
      return { topics, data };
    } catch {
      return { topics: [], data: "<unparsable diagnostic event>" };
    }
  });
}

export function mapSimulationResult(
  response: SimulateTransactionResponse
): SimulationResult {
  if (SorobanRpc.Api.isSimulationSuccess(response)) {
    const result: SimulationResult = { success: true };

    if (response.minResourceFee !== undefined) {
      result.minResourceFee = String(response.minResourceFee);
    }

    if (response.transactionData) {
      try {
        const txData = response.transactionData as any;
        if (typeof txData.build === "function") {
          result.footprint = txData.build().toXDR().toString("base64");
        } else if (typeof txData.toXDR === "function") {
          result.footprint = txData.toXDR().toString("base64");
        } else if (typeof txData === "string") {
          result.footprint = txData;
        }
      } catch {
        // footprint extraction failed — leave unset
      }
    }

    return result;
  }

  if (SorobanRpc.Api.isSimulationError(response)) {
    const isResourceExhaustion = RESOURCE_LIMIT_PATTERN.test(response.error);
    const { cpuInstructions, ramBytes } = extractBudgetFigures(response.error);

    const diagnostic: SorobanSimulationDiagnostic = {
      cpuInstructions,
      ramBytes,
      // The RPC only reports a computed minResourceFee on success; there is
      // none to report for a failed simulation.
      minResourceFee: "0",
      events: extractDiagnosticEvents(response.events),
      errorDetail: response.error,
    };

    const humanReadableError = isResourceExhaustion
      ? `Simulation exceeded the Soroban resource budget` +
        (cpuInstructions ? ` (CPU instructions: ${cpuInstructions})` : "") +
        (ramBytes ? ` (memory: ${ramBytes} bytes)` : "") +
        `. Reduce contract complexity, split the invocation into smaller steps, or request a higher resource limit. Raw diagnostic: ${response.error}`
      : response.error;

    return {
      success: false,
      error: humanReadableError,
      errorCode: isResourceExhaustion ? "RESOURCE_LIMIT_EXCEEDED" : "SIMULATION_ERROR",
      diagnostic,
    };
  }

  return {
    success: false,
    error: "Simulation returned an unexpected response",
    errorCode: "SIMULATION_ERROR",
  };
}

export class SorobanTransactionSimulator {
  private rpcServer: SorobanRpc.Server;
  public readonly config: SorobanRpcConfig;

  constructor(config: SorobanRpcConfig) {
    this.config = config;
    this.rpcServer = new SorobanRpc.Server(config.rpcUrl, {
      timeout: config.timeoutMs,
    });
  }

  public async simulateTransaction(
    transaction: Transaction
  ): Promise<SimulateTransactionResponse> {
    // Extract contract/method info from transaction for cache key
    const ops = transaction.operations ?? [];
    let contractId = "";
    let method = "";
    let args: unknown[] = [];

    if (ops.length > 0 && "function" in ops[0]) {
      const op = ops[0] as any;
      contractId = op.contract ?? "";
      method = op.function ?? op.name ?? "";
      args = op.args ?? [];
    }

    // Check cache first (unless bypassed)
    if (process.env.SIM_CACHE_BYPASS !== "true") {
      const cached = await getCachedSimulation(contractId, method, args);
      if (cached) {
        return cached.result as SimulateTransactionResponse;
      }
    }

    // Set up deduplication for concurrent identical requests
    const simulatePromise = this.doSimulateWithRetry(transaction);

    if (process.env.SIM_CACHE_BYPASS !== "true" && contractId && method) {
      setInFlightSimulation(contractId, method, args, simulatePromise);
    }

    const result = await simulatePromise;

    // Cache successful results
    if (process.env.SIM_CACHE_BYPASS !== "true" && contractId && method) {
      if (SorobanRpc.Api.isSimulationSuccess(result)) {
        setCachedSimulation(contractId, method, args, result).catch(() => {});
      }
    }

    return result;
  }

  private async doSimulateWithRetry(
    transaction: Transaction
  ): Promise<SimulateTransactionResponse> {
    let lastError: unknown;
    const maxAttempts = 1 + this.config.maxRetries;
    const startTime = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const simulation = await this.rpcServer.simulateTransaction(transaction);
        const durationMs = Date.now() - startTime;
        
        const ops = transaction.operations ?? [];
        let contractId = "unknown";
        let method = "unknown";
        if (ops.length > 0 && "function" in ops[0]) {
          const op = ops[0] as any;
          contractId = op.contract ?? "unknown";
          method = op.function ?? op.name ?? "unknown";
        }
        
        if (this.config.metricsRegistry) {
          this.config.metricsRegistry.recordContractLatency({
            contract: contractId,
            functionName: method,
            durationMs,
            success: SorobanRpc.Api.isSimulationSuccess(simulation)
          });
        }
        
        return simulation;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          console.warn(`Simulation attempt ${attempt}/${maxAttempts} failed, retrying...`, error);
        } else {
          console.error(`Simulation failed after ${maxAttempts} attempts:`, error);
        }
      }
    }

    throw lastError;
  }

  public extractFeeEstimates(
    simulationResponse: SimulateTransactionResponse
  ): any {
    if (SorobanRpc.Api.isSimulationSuccess(simulationResponse) && simulationResponse.transactionData) {
      const txData = simulationResponse.transactionData as any;
      const sorobanTransactionData = typeof txData.build === "function" ? txData.build() : txData;
      const resources = sorobanTransactionData.resources ? sorobanTransactionData.resources() : undefined;
      return {
        cpu: resources?.instructions ? resources.instructions().toString() : "0",
        memory: resources?.writeBytes ? resources.writeBytes().toString() : "0",
      };
    }
    return {};
  }

  // Placeholder for failure detection
  public detectFailureReasons(
    simulationResponse: SimulateTransactionResponse
  ): string[] {
    if (SorobanRpc.Api.isSimulationError(simulationResponse)) {
      return [simulationResponse.error];
    }
    return [];
  }
}
