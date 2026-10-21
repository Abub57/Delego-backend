import type { PermissionGrant } from "@delegolabs/types";
import { createLogger, isValidStellarPublicKey } from "@delegolabs/utils";
import {
  Account,
  Address,
  Horizon,
  Networks,
  Operation,
  rpc,
  scValToNative,
  nativeToScVal,
  TransactionBuilder,
  Transaction,
  // @ts-ignore
  xdr,
} from "@stellar/stellar-sdk";
import {
  SorobanTransactionSimulator,
  readSorobanRpcConfig,
  type SorobanRpcConfig,
} from "../src/sorobanSimulator.js";
import {
  getKeySigner,
  recordSigningKeyVersion,
  getActiveKeyVersion,
  type KeySigner,
} from "../src/vault.js";
import { checkSpendLimit } from "../src/spendLimits.js";
import { getTransactionFee } from "../src/dynamicFee.js";

const log = createLogger("wallet:permissions", process.env.LOG_LEVEL ?? "info");

// ---------------------------------------------------------------------------
// Typed Domain Errors
// ---------------------------------------------------------------------------

export class PermissionError extends Error {
  constructor(
    message: string,
    public readonly code: string = "PERMISSION_ERROR",
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class PermissionNotFoundError extends PermissionError {
  constructor(message = "Permission grant not found") {
    super(message, "PERMISSION_NOT_FOUND", 404);
  }
}

export class PermissionExpiredError extends PermissionError {
  constructor(message = "Permission grant has expired") {
    super(message, "PERMISSION_EXPIRED", 400);
  }
}

export class LimitExceededError extends PermissionError {
  constructor(message = "Spend limit exceeded") {
    super(message, "LIMIT_EXCEEDED", 400);
  }
}

export class DuplicatePermissionError extends PermissionError {
  constructor(message = "Permission grant already exists") {
    super(message, "DUPLICATE_PERMISSION", 409);
  }
}

export class SimulationFailedError extends PermissionError {
  constructor(message = "Transaction simulation failed") {
    super(message, "SIMULATION_FAILED", 400);
  }
}

export class InvalidPermissionInputError extends PermissionError {
  constructor(message = "Invalid permission input") {
    super(message, "INVALID_PERMISSION_INPUT", 400);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseExpiryToSeconds(
  expiresAt: string | null | undefined
): bigint {
  if (!expiresAt) return 0n;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidPermissionInputError(
      `Invalid expiresAt ISO date string: ${expiresAt}`
    );
  }
  return BigInt(Math.floor(date.getTime() / 1000));
}

export function formatExpiryToIso(
  expiry: bigint | number | string | null | undefined
): string | null {
  if (!expiry || expiry === 0n || expiry === 0 || expiry === "0") return null;
  const sec = Number(expiry);
  if (sec <= 0 || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString();
}

function parsePermissionGrant(
  contractId: string,
  raw: unknown,
  fallbackSpender?: string
): PermissionGrant | null {
  if (!raw) return null;
  const data = (raw instanceof Map ? Object.fromEntries(raw) : raw) as Record<
    string,
    unknown
  >;
  const spender = String(
    data.spender ?? data.delegate ?? fallbackSpender ?? ""
  );
  if (!spender) return null;

  const rawLimit = data.limit ?? data.total_limit ?? data.per_tx_limit;
  if (rawLimit === undefined || rawLimit === null) return null;
  const limit = BigInt(rawLimit as bigint | number | string);

  const rawExpiry = (data.expiresAt ??
    data.expires_at ??
    data.expiry ??
    data.expires_at_ledger) as bigint | number | string | null | undefined;
  const expiresAt = formatExpiryToIso(rawExpiry);

  return {
    contractId,
    spender,
    limit,
    expiresAt,
  };
}

function extractSimulationRetval(simRes: unknown): xdr.ScVal | null {
  if (!simRes || typeof simRes !== "object") return null;
  const sim = simRes as Record<string, any>;
  if (sim.result?.retval) return sim.result.retval;
  if (Array.isArray(sim.results) && sim.results[0]?.retval) {
    return sim.results[0].retval;
  }
  if (sim.retval) return sim.retval;
  return null;
}

function assembleSimulationTransaction(
  tx: Transaction,
  simRes: unknown
): Transaction {
  try {
    return rpc.assembleTransaction(tx, simRes as any).build();
  } catch (err) {
    throw new SimulationFailedError(
      `Failed to assemble transaction from simulation: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

function resolveStellarConfig(overrides?: Partial<PermissionsServiceDeps>): {
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
} {
  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  let horizonUrl = "https://horizon-testnet.stellar.org";
  let rpcUrl = "https://soroban-testnet.stellar.org";
  let networkPassphrase: string = Networks.TESTNET;

  if (network === "mainnet" || network === "public") {
    horizonUrl = process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org";
    rpcUrl = process.env.STELLAR_RPC_URL ?? "https://rpc.stellar.org";
    networkPassphrase = Networks.PUBLIC;
  } else if (network === "futurenet") {
    horizonUrl =
      process.env.STELLAR_HORIZON_URL ?? "https://horizon-futurenet.stellar.org";
    rpcUrl =
      process.env.STELLAR_RPC_URL ?? "https://rpc-futurenet.stellar.org";
    networkPassphrase = Networks.FUTURENET;
  } else {
    horizonUrl =
      process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
    rpcUrl =
      process.env.STELLAR_RPC_URL ??
      process.env.SOROBAN_RPC_URL ??
      "https://soroban-testnet.stellar.org";
    networkPassphrase = Networks.TESTNET;
  }

  if (overrides?.horizonUrl) horizonUrl = overrides.horizonUrl;
  if (overrides?.rpcUrl) rpcUrl = overrides.rpcUrl;
  if (overrides?.networkPassphrase) networkPassphrase = overrides.networkPassphrase;

  return { horizonUrl, rpcUrl, networkPassphrase };
}

// ---------------------------------------------------------------------------
// Types & Service Interface
// ---------------------------------------------------------------------------

export interface PermissionGrantInput extends PermissionGrant {
  owner?: string;
}

export interface SpendPolicyContext {
  userId?: string;
  walletId?: string;
  delegationId?: string | null;
}

export interface PermissionsServiceDeps {
  rpcUrl?: string;
  horizonUrl?: string;
  networkPassphrase?: string;
  defaultContractId?: string;
  defaultOwner?: string;
  rpcServer?: Pick<
    rpc.Server,
    "simulateTransaction" | "sendTransaction" | "getTransaction"
  >;
  horizonServer?: Pick<Horizon.Server, "loadAccount">;
  simulator?: Pick<
    SorobanTransactionSimulator,
    "simulateTransaction" | "detectFailureReasons"
  >;
  keySigner?: Pick<KeySigner, "sign" | "getPublicKey">;
  checkSpendLimit?: typeof checkSpendLimit;
}

export interface PermissionsService {
  /** Owner signs a grant invocation; returns tx hash */
  grant(grant: PermissionGrant & { owner?: string }, owner?: string): Promise<string>;
  /** Owner revokes a spender's permission */
  revoke(contractId: string, spender: string, owner?: string): Promise<void>;
  /** Owner revokes multiple spenders through sequence-safe contract submissions */
  revokeBatch(contractId: string, spenders: string[], owner?: string): Promise<void>;
  /** All active grants for an owner, read from contract storage */
  list(owner: string, contractId?: string): Promise<PermissionGrant[]>;
  /** Single grant lookup; null when none exists */
  get(
    contractId: string,
    owner: string,
    spender: string
  ): Promise<PermissionGrant | null>;
  /** True only if amount fits remaining limit and grant is unexpired */
  checkSpend(
    contractId: string,
    owner: string,
    spender: string,
    amount: bigint,
    policyContext?: SpendPolicyContext
  ): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createPermissionsService(
  deps: PermissionsServiceDeps = {}
): PermissionsService {
  const config = resolveStellarConfig(deps);
  const rpcServer =
    deps.rpcServer ?? new rpc.Server(config.rpcUrl, { timeout: 30_000 });
  const horizonServer =
    deps.horizonServer ?? new Horizon.Server(config.horizonUrl);

  const simulatorConfig: SorobanRpcConfig = {
    ...readSorobanRpcConfig(),
    rpcUrl: config.rpcUrl,
  };
  const simulator =
    deps.simulator ?? new SorobanTransactionSimulator(simulatorConfig);
  const keySigner = deps.keySigner ?? getKeySigner();

  function resolveOwner(explicitOwner?: string, grantOwner?: string): string {
    const candidate =
      grantOwner ??
      explicitOwner ??
      deps.defaultOwner ??
      process.env.PERMISSIONS_OWNER_ADDRESS ??
      process.env.WALLET_SOURCE_ADDRESS;

    if (!candidate || candidate.trim() === "") {
      throw new InvalidPermissionInputError(
        "Owner address is required to execute permissions operations"
      );
    }
    const trimmed = candidate.trim();
    if (!isValidStellarPublicKey(trimmed)) {
      throw new InvalidPermissionInputError(
        `Invalid Stellar public key for owner: ${trimmed}`
      );
    }
    return trimmed;
  }

  function resolveContractId(contractId?: string): string {
    const resolved =
      contractId ??
      deps.defaultContractId ??
      process.env.SOROBAN_PERMISSIONS_CONTRACT_ID ??
      process.env.PERMISSIONS_CONTRACT_ID;

    if (!resolved || resolved.trim() === "") {
      throw new InvalidPermissionInputError(
        "Contract ID is required for permissions operation"
      );
    }
    return resolved.trim();
  }

  function validateSpender(spender: string): string {
    if (!spender || spender.trim() === "") {
      throw new InvalidPermissionInputError("Spender address is required");
    }
    const trimmed = spender.trim();
    if (!isValidStellarPublicKey(trimmed)) {
      throw new InvalidPermissionInputError(
        `Invalid Stellar public key for spender: ${trimmed}`
      );
    }
    return trimmed;
  }

  async function loadSequenceNumber(address: string): Promise<string> {
    try {
      const account = await horizonServer.loadAccount(address);
      return account.sequenceNumber();
    } catch (err) {
      if (process.env.NODE_ENV === "test") return "1";
      log.error("Failed to load account sequence", {
        address,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new PermissionError(
        `Unable to load account sequence for ${address}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "SEQUENCE_LOAD_FAILED",
        502
      );
    }
  }

  async function pollTransactionConfirmation(txHash: string): Promise<void> {
    const maxAttempts = process.env.NODE_ENV === "test" ? 2 : 12;
    const intervalMs = process.env.NODE_ENV === "test" ? 10 : 5_000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      try {
        const txStatus = await rpcServer.getTransaction(txHash);
        if (txStatus.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          return;
        }
        if (txStatus.status === rpc.Api.GetTransactionStatus.FAILED) {
          const failed = txStatus as rpc.Api.GetFailedTransactionResponse;
          const errStr =
            typeof failed.resultXdr === "string"
              ? failed.resultXdr
              : failed.resultXdr?.toXDR().toString("base64") ?? "Unknown error";
          throw new PermissionError(
            `Transaction execution failed on-chain: ${errStr}`
          );
        }
      } catch (err: unknown) {
        if (err instanceof PermissionError) throw err;
        // Non-fatal transient poll error, keep checking until timeout
      }
    }

    throw new PermissionError(
      `Transaction ${txHash} was not confirmed within the polling window`,
      "TRANSACTION_UNCONFIRMED",
      504
    );
  }

  return {
    async grant(
      grantInput: PermissionGrant & { owner?: string },
      explicitOwner?: string
    ): Promise<string> {
      const owner = resolveOwner(explicitOwner, grantInput.owner);
      const contractId = resolveContractId(grantInput.contractId);
      const spender = validateSpender(grantInput.spender);

      if (grantInput.limit === undefined || grantInput.limit === null) {
        throw new InvalidPermissionInputError("Permission limit is required");
      }
      const limit = BigInt(grantInput.limit);
      if (limit < 0n) {
        throw new InvalidPermissionInputError(
          "Permission limit cannot be negative"
        );
      }

      const expirySeconds = parseExpiryToSeconds(grantInput.expiresAt);

      // Idempotency: Check if duplicate grant already exists
      const existing = await this.get(contractId, owner, spender);
      if (existing) {
        const isSameLimit = existing.limit === limit;
        const isSameExpiry =
          parseExpiryToSeconds(existing.expiresAt) === expirySeconds;
        if (isSameLimit && isSameExpiry) {
          throw new DuplicatePermissionError(
            `Permission grant already exists for spender ${spender} on contract ${contractId}`
          );
        }
      }

      log.info("Preparing on-chain permission grant", {
        contractId,
        owner,
        spender,
        limit: limit.toString(),
        expiresAt: grantInput.expiresAt,
      });

      const sequence = await loadSequenceNumber(owner);
      const account = new Account(owner, sequence);

      const op = Operation.invokeContractFunction({
        contract: contractId,
        function: "grant_permission",
        args: [
          Address.fromString(owner).toScVal(),
          Address.fromString(spender).toScVal(),
          nativeToScVal(limit, { type: "i128" }),
          nativeToScVal(expirySeconds, { type: "u64" }),
        ],
      });

      let tx = new TransactionBuilder(account, {
        fee: await getTransactionFee(config.horizonUrl),
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      // 1. Simulate invocation before submission
      log.info("Simulating permission grant invocation", { contractId, owner });
      const simRes = await simulator.simulateTransaction(tx);

      if (!rpc.Api.isSimulationSuccess(simRes)) {
        const reasons = simulator.detectFailureReasons(simRes);
        const errorMsg =
          reasons.join(", ") || simRes.error || "Simulation rejected";
        log.error("Permission grant simulation failed", { error: errorMsg });
        throw new SimulationFailedError(
          `Permission grant simulation failed: ${errorMsg}`
        );
      }

      // 2. Persist signing key version metadata
      const activeKeyVersion = getActiveKeyVersion();
      await recordSigningKeyVersion({
        walletId: owner,
        keyVersion: activeKeyVersion,
      });

      // 3. Assemble and sign transaction via vault-managed key signer
      tx = assembleSimulationTransaction(tx as Transaction, simRes);
      const sigBuffer = await keySigner.sign(tx.hash(), owner);
      (tx as Transaction).addSignature(owner, sigBuffer.toString("base64"));

      // 4. Submit transaction to RPC
      log.info("Submitting permission grant transaction", {
        hash: tx.hash().toString("hex"),
      });
      const sendRes = await rpcServer.sendTransaction(tx);

      if (sendRes.status === "ERROR") {
        throw new PermissionError(
          `Failed to submit permission grant: ${JSON.stringify(sendRes)}`
        );
      }

      const txHash = sendRes.hash;
      await pollTransactionConfirmation(txHash);

      log.info("Permission granted successfully on-chain", {
        txHash,
        contractId,
        owner,
        spender,
      });
      return txHash;
    },

    async revoke(
      contractIdInput: string,
      spenderInput: string,
      explicitOwner?: string
    ): Promise<void> {
      const owner = resolveOwner(explicitOwner);
      const contractId = resolveContractId(contractIdInput);
      const spender = validateSpender(spenderInput);

      // Idempotency: Check if permission exists
      const existing = await this.get(contractId, owner, spender);
      if (!existing) {
        log.info("Permission already revoked or does not exist — no-op", {
          contractId,
          owner,
          spender,
        });
        return;
      }

      log.info("Preparing on-chain permission revocation", {
        contractId,
        owner,
        spender,
      });

      const sequence = await loadSequenceNumber(owner);
      const account = new Account(owner, sequence);

      const op = Operation.invokeContractFunction({
        contract: contractId,
        function: "revoke_permission",
        args: [
          Address.fromString(owner).toScVal(),
          Address.fromString(spender).toScVal(),
        ],
      });

      let tx = new TransactionBuilder(account, {
        fee: await getTransactionFee(config.horizonUrl),
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(30)
        .build();

      // 1. Simulate invocation before submission
      log.info("Simulating permission revoke invocation", {
        contractId,
        owner,
      });
      const simRes = await simulator.simulateTransaction(tx);

      if (!rpc.Api.isSimulationSuccess(simRes)) {
        const reasons = simulator.detectFailureReasons(simRes);
        const errorMsg =
          reasons.join(", ") || simRes.error || "Simulation rejected";
        log.error("Permission revoke simulation failed", { error: errorMsg });
        throw new SimulationFailedError(
          `Permission revoke simulation failed: ${errorMsg}`
        );
      }

      // 2. Persist signing key version metadata
      const activeKeyVersion = getActiveKeyVersion();
      await recordSigningKeyVersion({
        walletId: owner,
        keyVersion: activeKeyVersion,
      });

      // 3. Assemble and sign transaction via vault-managed key signer
      tx = assembleSimulationTransaction(tx as Transaction, simRes);
      const sigBuffer = await keySigner.sign(tx.hash(), owner);
      (tx as Transaction).addSignature(owner, sigBuffer.toString("base64"));

      // 4. Submit transaction to RPC
      log.info("Submitting permission revoke transaction", {
        hash: tx.hash().toString("hex"),
      });
      const sendRes = await rpcServer.sendTransaction(tx);

      if (sendRes.status === "ERROR") {
        throw new PermissionError(
          `Failed to submit permission revoke: ${JSON.stringify(sendRes)}`
        );
      }

      await pollTransactionConfirmation(sendRes.hash);
      log.info("Permission revoked successfully on-chain", {
        txHash: sendRes.hash,
        contractId,
        owner,
        spender,
      });
    },

    async revokeBatch(
      contractIdInput: string,
      spenderInputs: string[],
      explicitOwner?: string,
    ): Promise<void> {
      if (spenderInputs.length === 0) return;
      const owner = resolveOwner(explicitOwner);
      const contractId = resolveContractId(contractIdInput);
      const spenders = [...new Set(spenderInputs.map(validateSpender))];
      for (const spender of spenders) {
        await this.revoke(contractId, spender, owner);
      }
    },

    async get(
      contractIdInput: string,
      ownerInput: string,
      spenderInput: string
    ): Promise<PermissionGrant | null> {
      const owner = resolveOwner(ownerInput);
      const contractId = resolveContractId(contractIdInput);
      const spender = validateSpender(spenderInput);

      const account = new Account(owner, "0");
      const tx = new TransactionBuilder(account, {
        fee: await getTransactionFee(config.horizonUrl),
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: contractId,
            function: "get_permission",
            args: [
              Address.fromString(owner).toScVal(),
              Address.fromString(spender).toScVal(),
            ],
          })
        )
        .setTimeout(30)
        .build();

      try {
        const simRes = await rpcServer.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(simRes) || (simRes as any).error) {
          return null;
        }

        const rawRetval = extractSimulationRetval(simRes);
        if (!rawRetval) {
          return null;
        }

        const nativeVal = scValToNative(rawRetval);
        if (
          !nativeVal ||
          (typeof nativeVal === "object" && Object.keys(nativeVal).length === 0)
        ) {
          return null;
        }

        return parsePermissionGrant(contractId, nativeVal, spender);
      } catch (err: unknown) {
        log.warn("Failed to query permission state from contract", {
          error: err instanceof Error ? err.message : String(err),
          contractId,
          owner,
          spender,
        });
        return null;
      }
    },

    async list(
      ownerInput: string,
      contractIdInput?: string
    ): Promise<PermissionGrant[]> {
      const owner = resolveOwner(ownerInput);
      let contractId: string;
      try {
        contractId = resolveContractId(contractIdInput);
      } catch {
        return [];
      }

      const account = new Account(owner, "0");
      const tx = new TransactionBuilder(account, {
        fee: await getTransactionFee(config.horizonUrl),
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: contractId,
            function: "list_permissions",
            args: [Address.fromString(owner).toScVal()],
          })
        )
        .setTimeout(30)
        .build();

      try {
        const simRes = await rpcServer.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(simRes) || (simRes as any).error) {
          return [];
        }

        const rawRetval = extractSimulationRetval(simRes);
        if (!rawRetval) return [];

        const nativeVal = scValToNative(rawRetval);
        if (!nativeVal) return [];

        const items = Array.isArray(nativeVal)
          ? nativeVal
          : nativeVal instanceof Set
            ? Array.from(nativeVal)
            : [nativeVal];

        const grants: PermissionGrant[] = [];
        for (const item of items) {
          const parsed = parsePermissionGrant(contractId, item);
          if (parsed) grants.push(parsed);
        }

        return grants;
      } catch (err: unknown) {
        log.warn("Failed to list active permissions from contract", {
          error: err instanceof Error ? err.message : String(err),
          contractId,
          owner,
        });
        return [];
      }
    },

    async checkSpend(
      contractIdInput: string,
      ownerInput: string,
      spenderInput: string,
      amount: bigint,
      policyContext?: SpendPolicyContext
    ): Promise<boolean> {
      const owner = resolveOwner(ownerInput);
      const contractId = resolveContractId(contractIdInput);
      const spender = validateSpender(spenderInput);

      if (amount === undefined || amount === null) {
        throw new InvalidPermissionInputError("Spend amount is required");
      }
      const amountBigInt = BigInt(amount);
      if (amountBigInt <= 0n) {
        throw new LimitExceededError("Spend amount must be greater than zero");
      }

      // 1. Check on-chain grant
      const grant = await this.get(contractId, owner, spender);
      if (!grant) {
        throw new PermissionNotFoundError(
          `Permission grant not found for spender ${spender} on owner ${owner}`
        );
      }

      // 2. Check expiry
      if (grant.expiresAt) {
        const expiryTime = new Date(grant.expiresAt).getTime();
        if (Number.isFinite(expiryTime) && expiryTime <= Date.now()) {
          throw new PermissionExpiredError(
            `Permission grant for spender ${spender} expired at ${grant.expiresAt}`
          );
        }
      }

      // 3. Check on-chain limit
      if (amountBigInt > grant.limit) {
        throw new LimitExceededError(
          `Spend amount ${amountBigInt.toString()} stroops exceeds permission limit of ${grant.limit.toString()} stroops`
        );
      }

      // 4. Off-chain defense-in-depth policy checks
      let userId = policyContext?.userId;
      let walletId = policyContext?.walletId;
      const delegationId = policyContext?.delegationId ?? null;

      if (!userId || !walletId) {
        if (process.env.NODE_ENV !== "test" || process.env.DATABASE_URL) {
          try {
            const { Wallet } = await import("../src/models/Wallet.js");
            const wallet = await Wallet.findOne({ where: { stellarAddress: owner } });
            if (wallet) {
              userId = userId || wallet.userId;
              walletId = walletId || wallet.id;
            }
          } catch {
            // Model/DB lookup not available in lightweight contexts
          }
        }
      }

      if (userId && walletId) {
        try {
          const spendLimitFn = deps.checkSpendLimit ?? checkSpendLimit;
          const offChain = await spendLimitFn(
            userId,
            walletId,
            delegationId,
            amountBigInt
          );
          if (!offChain.allowed) {
            throw new LimitExceededError(
              `Off-chain spending limit policy rejected: ${offChain.reason ?? "limit exceeded"}`
            );
          }
        } catch (err: unknown) {
          if (err instanceof LimitExceededError) throw err;
          log.error("Off-chain policy check failed", {
            error: err instanceof Error ? err.message : String(err),
            userId,
            walletId,
          });
          throw new PermissionError(
            `Unable to evaluate off-chain spending policy: ${
              err instanceof Error ? err.message : String(err)
            }`,
            "POLICY_CHECK_UNAVAILABLE",
            503
          );
        }
      }

      return true;
    },
  };
}

let defaultPermissionsServiceInstance: PermissionsService | null = null;

function getDefaultPermissionsService(): PermissionsService {
  if (!defaultPermissionsServiceInstance) {
    defaultPermissionsServiceInstance = createPermissionsService();
  }
  return defaultPermissionsServiceInstance;
}

export const permissionsService: PermissionsService = {
  grant(...args) {
    return getDefaultPermissionsService().grant(...args);
  },
  revoke(...args) {
    return getDefaultPermissionsService().revoke(...args);
  },
  revokeBatch(...args) {
    return getDefaultPermissionsService().revokeBatch(...args);
  },
  list(...args) {
    return getDefaultPermissionsService().list(...args);
  },
  get(...args) {
    return getDefaultPermissionsService().get(...args);
  },
  checkSpend(...args) {
    return getDefaultPermissionsService().checkSpend(...args);
  },
};

