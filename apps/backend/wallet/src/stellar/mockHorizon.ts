/**
 * Mock Horizon Client for testing without network dependencies.
 *
 * Provides stubbed account sequences, ledger responses, and simulated transaction submits.
 * Activated when NODE_ENV === 'test' or MOCK_HORIZON === 'true'.
 */

import type { Horizon } from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("wallet:stellar:mockHorizon", process.env.LOG_LEVEL ?? "info");

// In-memory state for mock accounts
interface MockAccountState {
  sequence: bigint;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
  }>;
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
  };
}

interface MockTransactionResult {
  hash: string;
  successful: boolean;
  ledger: number;
  result_xdr?: string;
  envelope_xdr?: string;
}

interface MockPaymentsResult {
  records: Array<{
    transaction_hash: string;
    type: string;
  }>;
}

// Global state (in-memory for test isolation)
const mockAccounts = new Map<string, MockAccountState>();
const mockTransactions = new Map<string, MockTransactionResult>();
const mockPendingTransactions = new Set<string>();

// Default test account state
const DEFAULT_SEQUENCE = 100000000000000000n;
const DEFAULT_LEDGER = 12345678;

/**
 * Reset all mock state - call between tests for isolation.
 */
export function resetMockHorizon(): void {
  mockAccounts.clear();
  mockTransactions.clear();
  mockPendingTransactions.clear();
  log.info("Mock Horizon state reset");
}

/**
 * Configure a mock account with custom state.
 */
export function setMockAccount(address: string, state: Partial<MockAccountState>): void {
  const normalized = address.toUpperCase();
  const existing = mockAccounts.get(normalized) || {
    sequence: DEFAULT_SEQUENCE,
    balances: [{ asset_type: "native", balance: "1000.0000000" }],
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
  };
  mockAccounts.set(normalized, { ...existing, ...state });
  log.debug("Mock account configured", { address: normalized, sequence: existing.sequence.toString() });
}

/**
 * Get or create mock account state.
 */
function getOrCreateAccount(address: string): MockAccountState {
  const normalized = address.toUpperCase();
  if (!mockAccounts.has(normalized)) {
    mockAccounts.set(normalized, {
      sequence: DEFAULT_SEQUENCE,
      balances: [{ asset_type: "native", balance: "1000.0000000" }],
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    });
  }
  return mockAccounts.get(normalized)!;
}

/**
 * Generate a mock transaction hash.
 */
function generateMockHash(): string {
  return "mock_tx_" + Date.now().toString(36) + "_" + Math.random().toString(36).substr(2, 16);
}

/**
 * Mock implementation of Horizon.Server for testing.
 * Implements the subset of methods used by the wallet codebase.
 */
export class MockHorizonServer implements Pick<Horizon.Server, "loadAccount" | "submitTransaction" | "transactions" | "payments" | "feeStats" | "paths" | "assets" | "accounts"> {
  private readonly baseUrl: string;

  constructor(horizonUrl: string = "mock://horizon") {
    this.baseUrl = horizonUrl;
    log.info("MockHorizonServer created", { horizonUrl: this.baseUrl });
  }

  /**
   * Load account details including sequence number and balances.
   * This is the primary method used by the transaction queue for sequence management.
   */
  async loadAccount(address: string): Promise<Horizon.AccountResponse> {
    const normalized = address.toUpperCase();
    const state = getOrCreateAccount(normalized);

    log.debug("Mock loadAccount", { address: normalized, sequence: state.sequence.toString() });

    // Return a response object matching Horizon.AccountResponse structure
    return {
      id: normalized,
      account_id: normalized,
      sequence: state.sequence.toString(),
      subentry_count: 0,
      inflation_destination: null,
      last_modified_ledger: DEFAULT_LEDGER,
      thresholds: state.thresholds,
      flags: state.flags,
      balances: state.balances.map((b) => ({
        balance: b.balance,
        limit: b.asset_type === "native" ? undefined : "922337203685.4775807",
        buying_liabilities: "0.0000000",
        selling_liabilities: "0.0000000",
        asset_type: b.asset_type,
        asset_code: b.asset_code,
        asset_issuer: b.asset_issuer,
        is_authorized: true,
        is_authorized_to_maintain_liabilities: true,
        is_clawback_enabled: false,
      })) as any,
      signers: [
        {
          weight: 1,
          key: normalized,
          type: "ed25519_public_key",
        },
      ],
      data: {},
      paging_token: "",
    } as Horizon.AccountResponse;
  }

  /**
   * Submit a transaction - returns a mock successful result.
   */
  async submitTransaction(tx: Horizon.BaseBuilder | string): Promise<Horizon.SubmitTransactionResponse> {
    const hash = generateMockHash();
    const ledger = DEFAULT_LEDGER + mockTransactions.size + 1;

    // If tx is a TransactionBuilder, we can extract the source account and increment sequence
    let sourceAccount: string | undefined;
    if (typeof tx !== "string" && "source" in tx) {
      // @ts-ignore - accessing internal property
      sourceAccount = tx.source?.accountId?.() || tx.source?.account_id?.();
    }

    if (sourceAccount) {
      const state = getOrCreateAccount(sourceAccount);
      state.sequence += 1n;
      log.debug("Mock submitTransaction - incremented sequence", {
        sourceAccount,
        newSequence: state.sequence.toString(),
      });
    }

    const result: Horizon.SubmitTransactionResponse = {
      hash,
      ledger,
      envelope_xdr: typeof tx === "string" ? tx : "mock_envelope_xdr",
      result_xdr: "mock_result_xdr",
      result_meta_xdr: "mock_result_meta_xdr",
      fee_meta_xdr: "mock_fee_meta_xdr",
      successful: true,
    };

    mockTransactions.set(hash, { hash, successful: true, ledger });
    log.info("Mock submitTransaction", { hash, ledger });

    return result;
  }

  /**
   * Mock transactions() call chain for transaction status lookup.
   */
  transactions(): {
    transaction: (hash: string) => {
      call: () => Promise<Horizon.TransactionResponse>;
    };
  } {
    return {
      transaction: (hash: string) => ({
        call: async (): Promise<Horizon.TransactionResponse> => {
          const mockTx = mockTransactions.get(hash);
          if (mockTx) {
            return {
              hash: mockTx.hash,
              ledger: mockTx.ledger,
              successful: mockTx.successful,
              created_at: new Date().toISOString(),
              source_account: "mock_source",
              fee_charged: 100,
              max_fee: 100,
              operation_count: 1,
              envelope_xdr: mockTx.envelope_xdr || "mock_envelope",
              result_xdr: mockTx.result_xdr || "mock_result",
              result_meta_xdr: "mock_meta",
              fee_meta_xdr: "mock_fee_meta",
              memo_type: "none",
              memo: null,
              signatures: [],
              valid_after: null,
              valid_before: null,
              paging_token: "",
            } as Horizon.TransactionResponse;
          }

          // Return 404-like response for unknown transactions
          throw new Horizon.NotFoundError(`Transaction ${hash} not found`);
        },
      }),
    };
  }

  /**
   * Mock payments() call chain for pending transaction checks.
   */
  payments(): {
    forAccount: (address: string) => {
      limit: (n: number) => {
        order: (dir: string) => {
          call: () => Promise<MockPaymentsResult>;
        };
      };
    };
  } {
    return {
      forAccount: (address: string) => ({
        limit: (n: number) => ({
          order: (dir: string) => ({
            call: async (): Promise<MockPaymentsResult> => {
              const normalized = address.toUpperCase();
              const hasPending = mockPendingTransactions.has(normalized);
              if (hasPending) {
                return {
                  records: [{ transaction_hash: "pending_tx_1", type: "payment" }],
                };
              }
              return { records: [] };
            },
          }),
        }),
      }),
    };
  }

  /**
   * Mock feeStats() call for dynamic fee estimation.
   */
  async feeStats(): Promise<{
    last_ledger: number;
    last_ledger_base_fee: number;
    ledger_capacity_usage: number;
    max_fee: { "10": number; "20": number; "30": number; "40": number; "50": number; "60": number; "70": number; "80": number; "90": number; "95": number; "99": number };
    fee_charged: { "10": number; "20": number; "30": number; "40": number; "50": number; "60": number; "70": number; "80": number; "90": number; "95": number; "99": number };
    tx_count: number;
  }> {
    return {
      last_ledger: DEFAULT_LEDGER,
      last_ledger_base_fee: 100,
      ledger_capacity_usage: 0.1,
      max_fee: { "10": 100, "20": 100, "30": 100, "40": 100, "50": 100, "60": 100, "70": 100, "80": 100, "90": 100, "95": 100, "99": 100 },
      fee_charged: { "10": 100, "20": 100, "30": 100, "40": 100, "50": 100, "60": 100, "70": 100, "80": 100, "90": 100, "95": 100, "99": 100 },
      tx_count: 100,
    };
  }

  /**
   * Mock paths() call for strict-receive paths (used by path payment engine).
   */
  paths(): {
    strictReceive: (sourceAssets: string[], destinationAsset: any, destinationAmount: string) => {
      call: () => Promise<{
        _embedded: { records: Horizon.PathRecord[] };
      }>;
    };
  } {
    return {
      strictReceive: (sourceAssets: string[], destinationAsset: any, destinationAmount: string) => ({
        call: async () => ({
          _embedded: { records: [] },
        }),
      }),
    };
  }

  /**
   * Mock assets() call for asset discovery (used by asset discovery module).
   */
  assets(): {
    forCode: (code: string) => {
      forIssuer: (issuer: string) => {
        limit: (n: number) => {
          call: () => Promise<{
            _embedded: { records: Array<{
              asset_type: string;
              asset_code?: string;
              asset_issuer?: string;
              amount: string;
              num_accounts: number;
              flags: { auth_required: boolean; auth_revocable: boolean; auth_immutable: boolean };
            }> };
          }>;
        };
      };
    };
  } {
    return {
      forCode: (code: string) => ({
        forIssuer: (issuer: string) => ({
          limit: (n: number) => ({
            call: async () => ({
              _embedded: {
                records: [
                  {
                    asset_type: "credit_alphanum4",
                    asset_code: code,
                    asset_issuer: issuer,
                    amount: "1000000.0000000",
                    num_accounts: 10,
                    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
                  },
                ],
              },
            }),
          }),
        }),
      }),
    };
  }

  /**
   * Mock accounts() call for account lookup (used by metadata resolution).
   */
  accounts(): {
    accountId: (address: string) => {
      call: () => Promise<{
        home_domain?: string;
        id: string;
        account_id: string;
        sequence: string;
        subentry_count: number;
        thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
        flags: { auth_required: boolean; auth_revocable: boolean; auth_immutable: boolean };
        balances: Array<{ asset_type: string; balance: string; limit?: string }>;
        signers: Array<{ weight: number; key: string; type: string }>;
        data: Record<string, string>;
        paging_token: string;
      }>;
    };
  } {
    return {
      accountId: (address: string) => ({
        call: async () => {
          const normalized = address.toUpperCase();
          const state = getOrCreateAccount(normalized);
          return {
            home_domain: "example.com",
            id: normalized,
            account_id: normalized,
            sequence: state.sequence.toString(),
            subentry_count: 0,
            thresholds: state.thresholds,
            flags: state.flags,
            balances: state.balances.map((b) => ({
              asset_type: b.asset_type,
              balance: b.balance,
              limit: b.asset_type === "native" ? undefined : "922337203685.4775807",
            })),
            signers: [
              {
                weight: 1,
                key: normalized,
                type: "ed25519_public_key",
              },
            ],
            data: {},
            paging_token: "",
          };
        },
      }),
    };
  }
}

/**
 * Factory function to create either a real or mock Horizon server based on environment.
 * This allows seamless switching between real and mock implementations.
 */
export function createHorizonServer(horizonUrl: string): Horizon.Server | MockHorizonServer {
  const isTest = process.env.NODE_ENV === "test";
  const useMock = process.env.MOCK_HORIZON === "true" || isTest;

  if (useMock) {
    log.info("Using MockHorizonServer for testing", { horizonUrl });
    return new MockHorizonServer(horizonUrl);
  }

  log.info("Using real Horizon.Server", { horizonUrl });
  const { Server } = require("@stellar/stellar-sdk");
  return new Server(horizonUrl);
}

/**
 * Type guard to check if a server is a mock instance.
 */
export function isMockHorizonServer(server: Horizon.Server | MockHorizonServer): server is MockHorizonServer {
  return server instanceof MockHorizonServer;
}

/**
 * Helper to set a pending transaction for testing pending transaction checks.
 */
export function setMockPendingTransaction(address: string, hasPending: boolean = true): void {
  const normalized = address.toUpperCase();
  if (hasPending) {
    mockPendingTransactions.add(normalized);
  } else {
    mockPendingTransactions.delete(normalized);
  }
}

/**
 * Export the StellarRpcClientConfig interface from the issue for reference.
 */
export interface StellarRpcClientConfig {
  horizonUrl: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  mockMode: boolean;
  timeoutMs: number;
}

/**
 * Get the default mock configuration for tests.
 */
export function getMockStellarConfig(): StellarRpcClientConfig {
  return {
    horizonUrl: "mock://horizon",
    sorobanRpcUrl: "mock://soroban-rpc",
    networkPassphrase: "Test SDF Network ; September 2015",
    mockMode: true,
    timeoutMs: 5000,
  };
}