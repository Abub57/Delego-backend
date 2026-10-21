/**
 * Stellar Merkle Root Publisher for Issue #358
 *
 * Periodically publishes Merkle roots of the audit chain to the
 * Stellar ledger as memo data, providing an immutable external
 * anchor for the audit trail.
 */
import {
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  Horizon,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";
import type { AuditLogChainEntry, MerklePublisherConfig, MerkleRootResult } from "@delegolabs/types";
import { computeMerkleRoot } from "./auditChain.js";

const log = createLogger("audit:stellar", process.env.LOG_LEVEL ?? "info");

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_HORIZON_URL = "https://horizon.testnet.stellar.org";

/**
 * Publisher that computes Merkle roots of the audit chain and
 * publishes them to the Stellar ledger as memo text.
 */
export class StellarMerklePublisher {
  private config: MerklePublisherConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private horizon: Horizon.Server;
  private keypair: Keypair;
  private isPublishing: boolean = false;
  private entries: AuditLogChainEntry[] = [];

  constructor(config: MerklePublisherConfig) {
    this.config = {
      intervalMs: DEFAULT_INTERVAL_MS,
      horizonUrl: DEFAULT_HORIZON_URL,
      ...config,
    };
    this.horizon = new Horizon.Server(this.config.horizonUrl ?? DEFAULT_HORIZON_URL);
    this.keypair = Keypair.fromSecret(this.config.stellarSecretKey ?? "");
  }

  /** Set the audit chain entries to publish. */
  setEntries(entries: AuditLogChainEntry[]): void {
    this.entries = entries;
  }

  /** Start the periodic Merkle root publishing. */
  start(): void {
    if (this.timer !== null) {
      log.warn("StellarMerklePublisher already running");
      return;
    }

    this.timer = setInterval(() => {
      void this.publishRoot();
    }, this.config.intervalMs);

    log.info("StellarMerklePublisher started", {
      intervalMs: this.config.intervalMs,
      horizonUrl: this.config.horizonUrl,
    });
  }

  /** Stop the periodic publishing. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("StellarMerklePublisher stopped");
    }
  }

  /**
   * Compute the Merkle root of the given audit chain entries and
   * publish it to the Stellar ledger.
   */
  async publishRoot(entries?: AuditLogChainEntry[]): Promise<MerkleRootResult | null> {
    const chainEntries = entries ?? this.entries;
    if (chainEntries.length === 0) {
      log.info("No audit entries to publish");
      return null;
    }

    const merkleResult = computeMerkleRoot(chainEntries);

    if (this.isPublishing) {
      log.warn("Previous publish still in progress, skipping");
      return merkleResult;
    }

    this.isPublishing = true;
    try {
      await this.submitToStellar(merkleResult);
      return merkleResult;
    } finally {
      this.isPublishing = false;
    }
  }

  /** Submit the Merkle root as a memo to the Stellar network. */
  private async submitToStellar(merkleResult: MerkleRootResult): Promise<void> {
    try {
      const accountId = this.keypair.publicKey();
      const memoText = `merkle-root:${merkleResult.root}:${merkleResult.leafCount}`;

      const transaction = new TransactionBuilder(
        await this.horizon.loadAccount(accountId),
        {
          fee: "100",
          networkPassphrase: Networks.TESTNET,
        }
      )
        .addOperation(
          Operation.payment({
            destination: this.config.stellarPublicKey,
            asset: Asset.native(),
            amount: "0.0000001",
          })
        )
        .addMemo(Memo.text(memoText))
        .setTimeout(30)
        .build();

      transaction.sign(this.keypair);

      await this.horizon.submitTransaction(transaction);
      log.info("Merkle root published to Stellar", {
        root: merkleResult.root,
        leafCount: merkleResult.leafCount,
        memo: memoText,
      });
    } catch (err) {
      log.error("Failed to publish Merkle root to Stellar", {
        error: (err as Error).message,
        root: merkleResult.root,
      });
      throw err;
    }
  }

  /** Get the current publishing interval. */
  getInterval(): number {
    return this.config.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /** Check if the publisher is currently active. */
  isActive(): boolean {
    return this.timer !== null;
  }
}

/** Create a StellarMerklePublisher from environment variables. */
export function createStellarPublisherFromEnv(): StellarMerklePublisher {
  const publisher = new StellarMerklePublisher({
    stellarSecretKey: process.env.STELLAR_AUDIT_SECRET_KEY ?? "",
    stellarPublicKey: process.env.STELLAR_AUDIT_PUBLIC_KEY ?? "",
    horizonUrl: process.env.STELLAR_HORIZON_URL,
    intervalMs: parseInt(process.env.STELLAR_AUDIT_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS)),
  });

  return publisher;
}
