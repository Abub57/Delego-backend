export const TTL_EXTENSION_THRESHOLD_LEDGERS = 5_000;

export interface ContractTtlStatus {
  contractAddress: string;
  storageKey: string;
  liveUntilLedger: number;
  currentLedger: number;
  ledgersRemaining: number;
  requiresExtension: boolean;
}

export interface ExtendFootprintTtlJob {
  contractAddress: string;
  storageKey: string;
  currentLedger: number;
  liveUntilLedger: number;
  ledgersRemaining: number;
  ledgersToExtend: number;
  rentFee: number;
  operation: "extend_footprint_ttl";
  source: "ttlMonitor";
}

export interface TtlMonitorOptions {
  rpcUrl?: string;
  currentLedger?: number;
  enqueue?: (job: ExtendFootprintTtlJob) => Promise<unknown> | unknown;
  fetchImpl?: FetchLike;
}

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<FetchLikeResponse>;

interface SorobanLedgerEntry {
  key?: string;
  xdr?: string;
  liveUntilLedgerSeq?: number | string;
  liveUntilLedger?: number | string;
  live_until_ledger_seq?: number | string;
}

function toNumber(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeContractTtlStatus(
  contractAddress: string,
  storageKey: string,
  currentLedger: number,
  entry: SorobanLedgerEntry = {}
): ContractTtlStatus {
  const liveUntilLedger =
    toNumber(entry.liveUntilLedgerSeq) ??
    toNumber(entry.liveUntilLedger) ??
    toNumber(entry.live_until_ledger_seq) ??
    0;

  const ledgersRemaining = Math.max(0, liveUntilLedger - currentLedger);

  return {
    contractAddress,
    storageKey,
    liveUntilLedger,
    currentLedger,
    ledgersRemaining,
    requiresExtension: ledgersRemaining < TTL_EXTENSION_THRESHOLD_LEDGERS,
  };
}

export function estimateRentFee(ledgersRemaining: number): number {
  const feePerLedger = Number(process.env.SOROBAN_TTL_EXTENSION_FEE_PER_LEDGER ?? 10_000);
  const urgencyBoost = Math.max(1, TTL_EXTENSION_THRESHOLD_LEDGERS - ledgersRemaining);
  return Math.max(1, Math.ceil(urgencyBoost * feePerLedger));
}

export function buildExtendFootprintTtlJob(
  status: ContractTtlStatus,
  feeOverride?: number
): ExtendFootprintTtlJob {
  const ledgersToExtend = Math.max(
    1,
    TTL_EXTENSION_THRESHOLD_LEDGERS - status.ledgersRemaining + 1
  );

  return {
    contractAddress: status.contractAddress,
    storageKey: status.storageKey,
    currentLedger: status.currentLedger,
    liveUntilLedger: status.liveUntilLedger,
    ledgersRemaining: status.ledgersRemaining,
    ledgersToExtend,
    rentFee: feeOverride ?? estimateRentFee(status.ledgersRemaining),
    operation: "extend_footprint_ttl",
    source: "ttlMonitor",
  };
}

export async function fetchContractTtlStatus(
  contractAddress: string,
  storageKeys: string[],
  options: TtlMonitorOptions = {}
): Promise<ContractTtlStatus[]> {
  if (storageKeys.length === 0) return [];

  const rpcUrl = options.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const currentLedger = options.currentLedger ?? Number(process.env.SOROBAN_CURRENT_LEDGER ?? 0);
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLedgerEntries",
      params: { keys: storageKeys },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Soroban RPC error ${response.status} while checking TTL for ${contractAddress}`
    );
  }

  const json = (await response.json()) as {
    result?: { entries?: SorobanLedgerEntry[] };
    error?: { message?: string };
  };

  if (json.error) {
    throw new Error(json.error.message ?? `Soroban RPC error for ${contractAddress}`);
  }

  const results = json.result?.entries ?? [];

  return storageKeys.map((storageKey) => {
    const entry = results.find((candidate) => candidate.key === storageKey) ?? {};
    return normalizeContractTtlStatus(contractAddress, storageKey, currentLedger, entry);
  });
}

export async function monitorExpiringFootprints(
  contractAddress: string,
  storageKeys: string[],
  options: TtlMonitorOptions = {}
): Promise<ContractTtlStatus[]> {
  const statuses = await fetchContractTtlStatus(contractAddress, storageKeys, options);
  const expiring = statuses.filter((status) => status.requiresExtension);

  if (options.enqueue) {
    for (const status of expiring) {
      await Promise.resolve(options.enqueue(buildExtendFootprintTtlJob(status)));
    }
  }

  return expiring;
}

async function runCli(): Promise<void> {
  const contractAddress = process.env.SOROBAN_CONTRACT_ID ?? process.env.CONTRACT_ADDRESS ?? "";
  const storageKeys = (process.env.SOROBAN_STORAGE_KEYS ?? process.env.TTL_STORAGE_KEYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!contractAddress || storageKeys.length === 0) {
    throw new Error(
      "Set SOROBAN_CONTRACT_ID and SOROBAN_STORAGE_KEYS (comma-separated) to monitor TTL.")
  }

  const results = await monitorExpiringFootprints(contractAddress, storageKeys, {
    enqueue: async (job: ExtendFootprintTtlJob) => {
      console.log(JSON.stringify({ type: "extend_footprint_ttl_enqueued", job }, null, 2));
      return { jobId: `${job.contractAddress}:${job.storageKey}` };
    },
  });

  console.log(JSON.stringify({ contractAddress, results }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith("ttlMonitor.ts")) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
