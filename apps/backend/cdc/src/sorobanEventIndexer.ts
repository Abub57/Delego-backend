/**
 * apps/backend/cdc/src/sorobanEventIndexer.ts
 *
 * Soroban RPC Event Ingestion Worker for Escrow State Tracking (Issue #598)
 *
 * Implements real-time event polling from Soroban RPC, decoding ScVal topics
 * and payload into typed Escrow events, and persisting ledger checkpoints
 * into indexer_checkpoints.
 */

import { rpc, xdr, scValToNative } from "@stellar/stellar-sdk";
import type { Pool } from "pg";

export interface SorobanEventFilter {
  startLedger: number;
  contractIds: string[];
  topics: string[][]; // XDR encoded topics
}

export interface ParsedEscrowEvent {
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  eventType: "EscrowCreated" | "EscrowFunded" | "EscrowReleased" | "EscrowRefunded" | "DisputeOpened";
  orderId: string;
  merchantAddress: string;
  buyerAddress: string;
  amountStroops: string;
}

export interface IndexerCheckpoint {
  contractId: string;
  lastLedger: number;
  updatedAt: Date;
}

export class SorobanEventIndexer {
  private rpcServer: rpc.Server;
  private dbPool?: Pool;
  private isRunning = false;
  private pollIntervalMs: number;
  private currentLedger = 0;

  constructor(options: {
    rpcUrl: string;
    dbPool?: Pool;
    pollIntervalMs?: number;
    startLedger?: number;
  }) {
    this.rpcServer = new rpc.Server(options.rpcUrl);
    this.dbPool = options.dbPool;
    this.pollIntervalMs = options.pollIntervalMs || 5000;
    this.currentLedger = options.startLedger || 0;
  }

  /**
   * Initializes checkpoint table if PostgreSQL is configured
   */
  async init(): Promise<void> {
    if (this.dbPool) {
      await this.dbPool.query(`
        CREATE TABLE IF NOT EXISTS indexer_checkpoints (
          contract_id VARCHAR(64) PRIMARY KEY,
          last_ledger BIGINT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    }
  }

  /**
   * Loads last recorded ledger sequence checkpoint
   */
  async getCheckpoint(contractId: string): Promise<number> {
    if (!this.dbPool) return this.currentLedger;
    const res = await this.dbPool.query(
      `SELECT last_ledger FROM indexer_checkpoints WHERE contract_id = $1`,
      [contractId]
    );
    if (res.rows.length > 0) {
      return parseInt(res.rows[0].last_ledger, 10);
    }
    return this.currentLedger;
  }

  /**
   * Persists latest processed ledger sequence checkpoint
   */
  async saveCheckpoint(contractId: string, ledger: number): Promise<void> {
    this.currentLedger = ledger;
    if (this.dbPool) {
      await this.dbPool.query(
        `INSERT INTO indexer_checkpoints (contract_id, last_ledger, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (contract_id)
         DO UPDATE SET last_ledger = EXCLUDED.last_ledger, updated_at = NOW()`,
        [contractId, ledger]
      );
    }
  }

  /**
   * Decodes Soroban RPC event into typed ParsedEscrowEvent
   */
  parseEvent(rawEvent: rpc.Api.GetEventsResponse["events"][0]): ParsedEscrowEvent | null {
    try {
      const topicVals = (rawEvent.topic || []).map((t) => {
        const val = xdr.ScVal.fromXDR(t, "base64");
        return scValToNative(val);
      });

      const eventType = String(topicVals[0] || "");
      const validTypes = ["EscrowCreated", "EscrowFunded", "EscrowReleased", "EscrowRefunded", "DisputeOpened"] as const;
      if (!validTypes.includes(eventType as any)) {
        return null;
      }

      let dataVal: any = {};
      if (rawEvent.value) {
        const parsedScVal = xdr.ScVal.fromXDR(rawEvent.value, "base64");
        dataVal = scValToNative(parsedScVal) || {};
      }

      return {
        ledger: rawEvent.ledger,
        ledgerClosedAt: rawEvent.ledgerClosedAt,
        txHash: rawEvent.txHash,
        eventType: eventType as ParsedEscrowEvent["eventType"],
        orderId: String(topicVals[1] || dataVal.orderId || ""),
        merchantAddress: String(dataVal.merchantAddress || dataVal.merchant || ""),
        buyerAddress: String(dataVal.buyerAddress || dataVal.buyer || ""),
        amountStroops: String(dataVal.amountStroops || dataVal.amount || "0"),
      };
    } catch {
      return null;
    }
  }

  /**
   * Polls a batch of events starting from startLedger
   */
  async pollEvents(filter: SorobanEventFilter): Promise<{ events: ParsedEscrowEvent[]; latestLedger: number }> {
    const start = filter.startLedger || (await this.getCheckpoint(filter.contractIds[0] || "default"));
    const response = await this.rpcServer.getEvents({
      startLedger: start,
      filters: filter.contractIds.map((id) => ({
        type: "contract",
        contractIds: [id],
      })),
    });

    const parsedEvents: ParsedEscrowEvent[] = [];
    let maxLedger = start;

    for (const evt of response.events || []) {
      if (evt.ledger > maxLedger) maxLedger = evt.ledger;
      const parsed = this.parseEvent(evt);
      if (parsed) parsedEvents.push(parsed);
    }

    if (filter.contractIds[0] && maxLedger > start) {
      await this.saveCheckpoint(filter.contractIds[0], maxLedger);
    }

    return { events: parsedEvents, latestLedger: maxLedger };
  }
}
