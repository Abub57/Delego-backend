import type { IncomingMessage } from "node:http";
import {
  route,
  json,
  isValidStellarPublicKey,
  validatePublicKeyMiddleware,
  createHealthRoutes,
  readBodyWithLimit,
  PayloadTooLargeError,
  requireServiceAuth,
  type Route,
} from "@delegolabs/utils";
import { Wallet } from "./models/Wallet.js";
import { createWalletHealthRegistry } from "./health.js";
import { accountService } from "../stellar/account.js";
import { mergeAccount, previewMerge } from "../stellar/recovery.js";
import { transactionService } from "../transactions/index.js";
import { vaultService } from "./vault.js";
import type { StellarNetwork } from "@delegolabs/types";
import {
  Asset,
  Networks,
  Horizon,
  TransactionBuilder,
  Transaction,
} from "@stellar/stellar-sdk";
import { getRedisConnection, getJobStatus } from "./queue/txQueue.js";
import { createLogger } from "@delegolabs/utils";
import {
  SorobanTransactionSimulator,
  mapSimulationResult,
  readSorobanRpcConfig,
} from "./sorobanSimulator.js";
import { registerMultiSigRoutes } from "./multisig/routes.js";
import { registerRecoveryRoutes } from "./recovery/routes.js";
import { registerBatchingRoutes } from "./batching/routes.js";
import { registerSequenceAdminRoutes } from "./batching/sequenceAdminRoutes.js";
import { registerSimulationCacheAdminRoutes } from "./batching/simulationCacheAdminRoutes.js";
import { registerDLQAdminRoutes } from "./batching/dlqAdminRoutes.js";
import { registerAssetRoutes } from "./assets/routes.js";
import { registerFaucetRoutes } from "./faucet/routes.js";
import { registerFeeEstimatorRoutes } from "./feeEstimator/routes.js";
import { registerMerchantDomainRoutes } from "./merchantDomain/routes.js";
import { registerPathQuoteRoutes } from "./pathPayments/quoteProxy/routes.js";
import { createHorizonServer, isMockModeEnabled } from "../stellar/mockHorizon.js";

const log = createLogger("wallet:routes", process.env.LOG_LEVEL ?? "info");

const walletHealthRegistry = createWalletHealthRegistry();
const requirePaymentsServiceAuth = requireServiceAuth({
  envVar: "PAYMENTS_WALLET_SERVICE_TOKEN",
});

interface TokenBalance {
  assetCode: string;
  assetIssuer: string;
  balance: string; // in stroops
  balanceFormatted: string; // with decimal places
  contractId: string | null; // Soroban token contract ID if SAC
}

interface BalanceResponse {
  address: string;
  network: "testnet" | "mainnet";
  nativeBalance: string; // XLM in stroops
  nativeBalanceFormatted: string; // XLM with 7 decimal places
  tokenBalances: TokenBalance[];
  lastUpdated: string; // ISO 8601
}

interface TransactionEntry {
  id: string;
  hash: string;
  ledger: number;
  type: "payment" | "contract_invocation" | "create_account" | "other";
  direction: "incoming" | "outgoing";
  amount: string | null;
  assetCode: string | null;
  counterparty: string | null;
  memo: string | null;
  timestamp: string;
  successful: boolean;
}

interface TransactionHistoryResponse {
  address: string;
  transactions: TransactionEntry[];
  cursor: string | null; // for pagination
  hasMore: boolean;
}

function xlmToStroops(xlmStr: string): string {
  const parts = xlmStr.split(".");
  const whole = parts[0];
  let fraction = parts[1] || "";
  fraction = fraction.padEnd(7, "0").slice(0, 7);
  const combined = whole + fraction;
  const trimmed = combined.replace(/^0+/, "");
  return trimmed === "" ? "0" : trimmed;
}

// Helper to parse JSON body from incoming Node.js request.
// Body is capped at 1MB (see readBodyWithLimit) — an oversized body rejects
// with PayloadTooLargeError, which callers handle by responding 413.
async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const body = await readBodyWithLimit(req);
  try {
    return body ? (JSON.parse(body) as T) : ({} as T);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

// Sends the standard 413 Payload Too Large response when readJsonBody
// rejects with PayloadTooLargeError; returns false for any other error so
// callers can fall through to their own error handling.
function respondIfPayloadTooLarge(res: Parameters<typeof json>[0], err: unknown): boolean {
  if (err instanceof PayloadTooLargeError) {
    json(res, 413, {
      data: null,
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: err.message,
      },
    });
    return true;
  }
  return false;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (err: unknown) => boolean;
}

export function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as any)?.response?.status ?? (err as any)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return false;
  }
  return true;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 500,
  options: RetryOptions = {},
): Promise<T> {
  const max = options.maxRetries ?? maxRetries;
  const initialDelay = options.initialDelayMs ?? initialDelayMs;
  const delayFn =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const predicate = options.shouldRetry ?? isNetworkError;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt >= max || !predicate(err)) {
        throw err;
      }
      const delay = initialDelay * Math.pow(2, attempt);
      await delayFn(delay);
      attempt++;
    }
  }
}

export function registerRoutes(
  simulator = new SorobanTransactionSimulator(readSorobanRpcConfig()),
): Route[] {
  const validateAddress = validatePublicKeyMiddleware("address");

  return [
    ...createHealthRoutes({
      registry: walletHealthRegistry,
      serviceName: "wallet",
      version: "0.0.1",
    }),

    route("POST", "/wallets/simulate", async (req, res) => {
      try {
        const body = await readJsonBody<{ xdr?: string; network?: string }>(req);
        if (typeof body.xdr !== "string" || body.xdr.trim() === "") {
          throw new Error("A transaction XDR string is required");
        }
        const network = (body.network ?? "testnet").toLowerCase();
        if (network !== "testnet" && network !== "mainnet") {
          throw new Error("Network must be either testnet or mainnet");
        }

        let transaction: Transaction;
        try {
          transaction = TransactionBuilder.fromXDR(
            body.xdr,
            network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
          ) as Transaction;
          if (!(transaction instanceof Transaction)) {
            throw new Error("Fee-bump transactions are not supported by this endpoint");
          }
        } catch (err) {
          throw new Error(`Invalid transaction XDR: ${err instanceof Error ? err.message : "Unable to parse payload"}`);
        }

        const simulation = await simulator.simulateTransaction(transaction);
        json(res, 200, { data: mapSimulationResult(simulation), error: null });
      } catch (err: any) {
        if (respondIfPayloadTooLarge(res, err)) return;
        const message = err instanceof Error ? err.message : "Transaction simulation failed";
        const status = message.startsWith("Invalid transaction XDR:") ||
          message === "A transaction XDR string is required" ||
          message.startsWith("Network must be") ? 400 : 502;
        json(res, status, {
          data: null,
          error: { code: status === 400 ? "INVALID_XDR" : "SIMULATION_FAILED", message },
        });
      }
    }),

    // Create new Stellar wallet (Master or Delegate keypair)
    route("POST", "/wallets/create", async (req, res) => {
      try {
        const body = await readJsonBody<{ network?: StellarNetwork }>(req);
        const network = body.network ?? "testnet";

        const account = await accountService.createAccount(network);
        json(res, 201, { data: account, error: null });
      } catch (err: any) {
        if (respondIfPayloadTooLarge(res, err)) return;
        json(res, 400, {
          data: null,
          error: { code: "CREATE_WALLET_FAILED", message: err.message },
        });
      }
    }),

    // Retrieve details for a specific wallet address
    route("GET", "/wallets/:address", async (_req, res, params) => {
      try {
        await validateAddress(_req, res, params);
        if (res.writableEnded) return;

        const address = params.address;
        if (!address) {
          throw new Error("Address parameter is required");
        }
        const account = await accountService.getAccount(address);
        if (!account) {
          json(res, 404, {
            data: null,
            error: {
              code: "NOT_FOUND",
              message: `Wallet not found: ${address}`,
            },
          });
          return;
        }
        json(res, 200, { data: account, error: null });
      } catch (err: any) {
        json(res, 400, {
          data: null,
          error: { code: "GET_WALLET_FAILED", message: err.message },
        });
      }
    }),

    // List all public addresses managed by this wallet service
    route("GET", "/wallets", async (_req, res) => {
      try {
        const publicKeys = await vaultService.listPublicKeys();
        json(res, 200, { data: publicKeys, error: null });
      } catch (err: any) {
        json(res, 500, {
          data: null,
          error: { code: "LIST_WALLETS_FAILED", message: err.message },
        });
      }
    }),

    // Simulate Soroban contract call
    route("POST", "/transactions/simulate", async (req, res) => {
      try {
        const body = await readJsonBody<{
          sourceAddress: string;
          contractId: string;
          method: string;
          args: unknown[];
          memo?: string;
        }>(req);

        if (
          !body.sourceAddress ||
          !body.contractId ||
          !body.method ||
          !body.args
        ) {
          throw new Error("Missing required transaction simulation parameters");
        }
        if (!isValidStellarPublicKey(body.sourceAddress)) {
          throw new Error("Malformed Stellar public key address");
        }

        const simResult = await transactionService.simulate({
          sourceAddress: body.sourceAddress,
          contractId: body.contractId,
          method: body.method,
          args: body.args,
          memo: body.memo ?? "Simulating transaction",
        });

        json(res, 200, { data: simResult, error: null });
      } catch (err: any) {
        if (respondIfPayloadTooLarge(res, err)) return;
        json(res, 400, {
          data: null,
          error: { code: "SIMULATION_FAILED", message: err.message },
        });
      }
    }),

    // Sign and submit a transaction to Soroban
    route("POST", "/transactions/submit", async (req, res) => {
      let serviceAuthenticated = false;
      requirePaymentsServiceAuth(req, res, () => {
        serviceAuthenticated = true;
      });
      if (!serviceAuthenticated) return;

      try {
        const body = await readJsonBody<{
          sourceAddress: string;
          contractId: string;
          method: string;
          args: unknown[];
          memo?: string;
        }>(req);

        if (
          !body.sourceAddress ||
          !body.contractId ||
          !body.method ||
          !body.args
        ) {
          throw new Error("Missing required transaction submission parameters");
        }
        if (!isValidStellarPublicKey(body.sourceAddress)) {
          throw new Error("Malformed Stellar public key address");
        }

        let userId: string | undefined;
        let walletId: string | undefined;
        if (body.method === "create_escrow") {
          const escrowContractId = process.env.ESCROW_CONTRACT_ID;
          if (!escrowContractId?.trim()) {
            json(res, 503, {
              data: null,
              error: { code: "SERVICE_CONFIGURATION_ERROR", message: "Escrow contract is not configured" },
            });
            return;
          }
          if (body.contractId !== escrowContractId) {
            json(res, 403, {
              data: null,
              error: { code: "FORBIDDEN", message: "Checkout submission uses an unrecognized escrow contract" },
            });
            return;
          }

          const authenticatedUserId = req.headers["x-delego-user-id"];
          if (typeof authenticatedUserId !== "string" || authenticatedUserId.trim().length === 0) {
            json(res, 401, {
              data: null,
              error: { code: "UNAUTHORIZED", message: "X-Delego-User-Id header is required for checkout deposit" },
            });
            return;
          }

          const wallet = await Wallet.findOne({
            where: { stellarAddress: body.sourceAddress },
          });
          if (!wallet) {
            json(res, 404, {
              data: null,
              error: { code: "WALLET_NOT_FOUND", message: "Source wallet not found" },
            });
            return;
          }
          if (wallet.userId !== authenticatedUserId) {
            json(res, 403, {
              data: null,
              error: { code: "FORBIDDEN", message: "Source wallet is not owned by the authenticated user" },
            });
            return;
          }
          userId = authenticatedUserId;
          walletId = wallet.id;
        }

        const txResult = await transactionService.submit({
          sourceAddress: body.sourceAddress,
          contractId: body.contractId,
          method: body.method,
          args: body.args,
          memo: body.memo ?? "Submitting transaction",
          ...(userId ? { userId, walletId } : {}),
        });

        json(res, 200, { data: txResult, error: null });
      } catch (err: any) {
        if (respondIfPayloadTooLarge(res, err)) return;
        json(res, 400, {
          data: null,
          error: { code: "SUBMISSION_FAILED", message: err.message },
        });
      }
    }),

    // Merge (recover) deprecated account into destination
    route("POST", "/api/v1/wallet/merge", async (req, res) => {
      try {
        const body = await readJsonBody<{
          sourceAddress: string;
          destinationAddress: string;
          network?: StellarNetwork;
        }>(req);

        if (!body.sourceAddress || !body.destinationAddress) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "sourceAddress and destinationAddress are required",
            },
          });
          return;
        }
        if (!isValidStellarPublicKey(body.sourceAddress)) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "Invalid source Stellar address format",
            },
          });
          return;
        }
        if (!isValidStellarPublicKey(body.destinationAddress)) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "Invalid destination Stellar address format",
            },
          });
          return;
        }

        const result = await mergeAccount({
          sourceAddress: body.sourceAddress,
          destinationAddress: body.destinationAddress,
          network: body.network,
        });

        json(res, 200, { data: result, error: null });
      } catch (err: any) {
        if (respondIfPayloadTooLarge(res, err)) return;
        log.error("POST merge account error", { error: err.message });
        json(res, 400, {
          data: null,
          error: { code: "MERGE_FAILED", message: err.message },
        });
      }
    }),

    // Preview merge amount without executing
    route("POST", "/api/v1/wallet/merge/preview", async (req, res) => {
      try {
        const body = await readJsonBody<{
          sourceAddress: string;
          network?: StellarNetwork;
        }>(req);

        if (!body.sourceAddress) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "sourceAddress is required",
            },
          });
          return;
        }
        if (!isValidStellarPublicKey(body.sourceAddress)) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "Invalid Stellar address format",
            },
          });
          return;
        }

        const preview = await previewMerge({
          sourceAddress: body.sourceAddress,
          network: body.network,
        });

        json(res, 200, { data: preview, error: null });
      } catch (err: any) {
        if (respondIfPayloadTooLarge(res, err)) return;
        log.error("POST merge preview error", { error: err.message });
        json(res, 400, {
          data: null,
          error: { code: "PREVIEW_FAILED", message: err.message },
        });
      }
    }),

    // Get native XLM and token balances
    route(
      "GET",
      "/api/v1/wallet/:address/balance",
      async (_req, res, params) => {
        try {
          await validateAddress(_req, res, params);
          if (res.writableEnded) return;

          const address = params.address;

          if (!isValidStellarPublicKey(address)) {
            json(res, 400, {
              data: null,
              error: {
                code: "BAD_REQUEST",
                message: "Invalid Stellar address format",
              },
            });
            return;
          }

          const network = (
            process.env.STELLAR_NETWORK ?? "testnet"
          ).toLowerCase() as "testnet" | "mainnet";
          const horizonUrl =
            network === "mainnet"
              ? (process.env.STELLAR_HORIZON_URL ??
                "https://horizon.stellar.org")
              : (process.env.STELLAR_HORIZON_URL ??
                "https://horizon-testnet.stellar.org");
          const networkPassphrase =
            network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

          const redis = getRedisConnection();
          const cacheKey = `cache:balance:${address}`;

          try {
            const cached = await redis.get(cacheKey);
            if (cached) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(cached);
              return;
            }
          } catch (cacheErr: any) {
            log.warn("Redis read failed during balance query", {
              error: cacheErr.message,
            });
          }

          const server = isMockModeEnabled() ? createHorizonServer(horizonUrl) : new Horizon.Server(horizonUrl);
          let account;
          try {
            account = await retryWithBackoff(() => server.loadAccount(address));
          } catch (err: any) {
            if (err.response?.status === 404) {
              json(res, 404, {
                data: null,
                error: {
                  code: "NOT_FOUND",
                  message: "Account not found on the network",
                },
              });
              return;
            }
            if (err.response?.status === 429) {
              const retryAfter = err.response?.headers?.["retry-after"] || "30";
              res.writeHead(503, {
                "Content-Type": "application/json",
                "Retry-After": retryAfter,
              });
              res.end(
                JSON.stringify({
                  data: null,
                  error: {
                    code: "SERVICE_UNAVAILABLE",
                    message:
                      "Horizon server is currently rate limiting requests",
                  },
                }),
              );
              return;
            }
            throw err;
          }

          const nativeBalanceLine = account.balances.find(
            (b: any) => b.asset_type === "native",
          );
          const nativeBalance = nativeBalanceLine
            ? xlmToStroops(nativeBalanceLine.balance)
            : "0";
          const nativeBalanceFormatted = nativeBalanceLine
            ? nativeBalanceLine.balance
            : "0.0000000";

          const tokenBalances: TokenBalance[] = [];
          for (const b of account.balances) {
            if (
              b.asset_type === "native" ||
              b.asset_type === "liquidity_pool_shares"
            ) {
              continue;
            }
            const code = b.asset_code;
            const issuer = b.asset_issuer;

            let contractId: string | null = null;
            try {
              const asset = new Asset(code, issuer);
              contractId = asset.contractId(networkPassphrase);
            } catch (err) {
              log.error("Failed to compute contractId for asset", {
                code,
                issuer,
                error: err,
              });
            }

            tokenBalances.push({
              assetCode: code,
              assetIssuer: issuer,
              balance: xlmToStroops(b.balance),
              balanceFormatted: b.balance,
              contractId,
            });
          }

          const balanceResponse: BalanceResponse = {
            address,
            network,
            nativeBalance,
            nativeBalanceFormatted,
            tokenBalances,
            lastUpdated: new Date().toISOString(),
          };

          const responsePayload = { data: balanceResponse, error: null };
          const responseString = JSON.stringify(responsePayload);

          try {
            await redis.set(cacheKey, responseString, "EX", 10);
          } catch (cacheErr: any) {
            log.warn("Redis write failed during balance query", {
              error: cacheErr.message,
            });
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(responseString);
        } catch (err: any) {
          log.error("GET balance error", { error: err.message });
          json(res, 500, {
            data: null,
            error: { code: "INTERNAL_ERROR", message: err.message },
          });
        }
      },
    ),

    // Get queue job status by job ID
    route("GET", "/api/v1/queue/jobs/:jobId", async (_req, res, params) => {
      try {
        const jobId = params.jobId;
        if (!jobId) {
          json(res, 400, {
            data: null,
            error: {
              code: "BAD_REQUEST",
              message: "jobId parameter is required",
            },
          });
          return;
        }

        const status = await getJobStatus(jobId);
        if (!status) {
          json(res, 404, {
            data: null,
            error: { code: "NOT_FOUND", message: `Job not found: ${jobId}` },
          });
          return;
        }

        json(res, 200, { data: status, error: null });
      } catch (err: any) {
        log.error("GET job status error", { error: err.message });
        json(res, 500, {
          data: null,
          error: { code: "INTERNAL_ERROR", message: err.message },
        });
      }
    }),

    // Get recent transaction history
    route(
      "GET",
      "/api/v1/wallet/:address/transactions",
      async (req, res, params) => {
        try {
          await validateAddress(req, res, params);
          if (res.writableEnded) return;

          const address = params.address;

          const url = new URL(
            req.url ?? "",
            `http://${req.headers.host ?? "localhost"}`,
          );
          const cursorParam = url.searchParams.get("cursor");

          const network = (
            process.env.STELLAR_NETWORK ?? "testnet"
          ).toLowerCase() as "testnet" | "mainnet";
          const horizonUrl =
            network === "mainnet"
              ? (process.env.STELLAR_HORIZON_URL ??
                "https://horizon.stellar.org")
              : (process.env.STELLAR_HORIZON_URL ??
                "https://horizon-testnet.stellar.org");
          const networkPassphrase =
            network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

          const server = isMockModeEnabled() ? createHorizonServer(horizonUrl) : new Horizon.Server(horizonUrl);

          let txResponse;
          try {
            // Verify account exists before retrieving history
            await retryWithBackoff(() => server.loadAccount(address));

            let builder = server
              .transactions()
              .forAccount(address)
              .limit(20)
              .order("desc");
            if (cursorParam) {
              builder = builder.cursor(cursorParam);
            }
            txResponse = await retryWithBackoff(() => builder.call());
          } catch (err: any) {
            if (err.response?.status === 404) {
              json(res, 404, {
                data: null,
                error: {
                  code: "NOT_FOUND",
                  message: "Account not found on the network",
                },
              });
              return;
            }
            if (err.response?.status === 429) {
              const retryAfter = err.response?.headers?.["retry-after"] || "30";
              res.writeHead(503, {
                "Content-Type": "application/json",
                "Retry-After": retryAfter,
              });
              res.end(
                JSON.stringify({
                  data: null,
                  error: {
                    code: "SERVICE_UNAVAILABLE",
                    message:
                      "Horizon server is currently rate limiting requests",
                  },
                }),
              );
              return;
            }
            throw err;
          }

          const transactions: TransactionEntry[] = txResponse.records.map(
            (tx: any) => {
              let operations: any[] = [];
              try {
                const parsedTx = TransactionBuilder.fromXDR(
                  tx.envelope_xdr,
                  networkPassphrase,
                );
                if (parsedTx instanceof Transaction) {
                  operations = parsedTx.operations;
                } else if ("innerTransaction" in parsedTx) {
                  operations = parsedTx.innerTransaction.operations;
                }
              } catch (err) {
                log.error("Failed to parse transaction XDR", {
                  hash: tx.hash,
                  error: err,
                });
              }

              const op = operations[0];
              let type:
                "payment" | "contract_invocation" | "create_account" | "other" =
                "other";
              let direction: "incoming" | "outgoing" = "outgoing";
              let amount: string | null = null;
              let assetCode: string | null = null;
              let counterparty: string | null = null;

              if (op) {
                if (
                  op.type === "payment" ||
                  op.type === "pathPaymentStrictReceive" ||
                  op.type === "pathPaymentStrictSend"
                ) {
                  type = "payment";
                  amount = op.amount ? xlmToStroops(op.amount) : null;
                  if (op.asset) {
                    assetCode = op.asset.isNative()
                      ? "XLM"
                      : op.asset.getCode();
                  }
                  if (op.destination === address) {
                    direction = "incoming";
                    counterparty = op.source || tx.source_account;
                  } else {
                    direction = "outgoing";
                    counterparty = op.destination;
                  }
                } else if (op.type === "createAccount") {
                  type = "create_account";
                  amount = op.startingBalance
                    ? xlmToStroops(op.startingBalance)
                    : null;
                  assetCode = "XLM";
                  if (op.destination === address) {
                    direction = "incoming";
                    counterparty = op.source || tx.source_account;
                  } else {
                    direction = "outgoing";
                    counterparty = op.destination;
                  }
                } else if (op.type === "invokeHostFunction") {
                  type = "contract_invocation";
                  direction =
                    tx.source_account === address ? "outgoing" : "incoming";
                  counterparty = op.source || tx.source_account;
                } else {
                  type = "other";
                  direction =
                    tx.source_account === address ? "outgoing" : "incoming";
                  counterparty = op.source || tx.source_account;
                }
              } else {
                direction =
                  tx.source_account === address ? "outgoing" : "incoming";
              }

              return {
                id: tx.id,
                hash: tx.hash,
                ledger: tx.ledger_attr || tx.ledger,
                type,
                direction,
                amount,
                assetCode,
                counterparty,
                memo: tx.memo || null,
                timestamp: tx.created_at,
                successful: tx.successful,
              };
            },
          );

          const nextRecord = txResponse.records[txResponse.records.length - 1];
          const nextCursor = nextRecord ? nextRecord.paging_token : null;
          const hasMore = txResponse.records.length === 20;

          const historyResponse: TransactionHistoryResponse = {
            address,
            transactions,
            cursor: nextCursor,
            hasMore,
          };

          json(res, 200, { data: historyResponse, error: null });
        } catch (err: any) {
          log.error("GET transactions history error", { error: err.message });
          json(res, 500, {
            data: null,
            error: { code: "INTERNAL_ERROR", message: err.message },
          });
        }
      },
    ),

    // --- Issue #44: Multi-sig routes ---
    ...registerMultiSigRoutes(),

    // --- Issue #43: Social guardian recovery routes ---
    ...registerRecoveryRoutes(),

    // --- Issue #42: Transaction batching routes ---
    ...registerBatchingRoutes(),

    // --- Issue #140: Sequence reservation monitoring & admin routes ---
    ...registerSequenceAdminRoutes(),

    // --- Issue #141: Simulation cache admin routes ---
    ...registerSimulationCacheAdminRoutes(),

    // --- Issue #143: Transaction DLQ admin routes ---
    ...registerDLQAdminRoutes(),

    // --- Issue #108: Asset management routes ---
    ...registerAssetRoutes(),

    // --- Issue #373: Automated Testnet Faucet Dispenser routes ---
    ...registerFaucetRoutes(),

    // --- Issue #364: Dynamic fee estimator routes ---
    ...registerFeeEstimatorRoutes(),

    // --- SEP-1 merchant domain verification ---
    ...registerMerchantDomainRoutes(),

    // --- Oracle-signed path payment quotes (Horizon strict-receive) ---
    ...registerPathQuoteRoutes(),
  ];
}
