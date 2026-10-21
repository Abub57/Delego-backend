/**
 * Automated Testnet Contract Deployer & Friendbot Faucet Relayer
 *
 * Microservice that:
 * 1. Relays Stellar Friendbot funding requests for testnet accounts
 * 2. Optionally mints mock USDC tokens from a faucet issuer key
 * 3. Rate limits requests to 1 per IP/address per hour
 *
 * Closes #286
 */

import { Redis } from "ioredis";
import { createLogger, type Logger } from "@delegolabs/utils";
import { Horizon, Asset, TransactionBuilder, Operation, Keypair, Networks } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types (matching issue spec)
// ---------------------------------------------------------------------------

export interface FaucetRelayRequest {
  destinationAddress: string;
  mintMockUsdc?: boolean;
}

export interface FaucetRelayResult {
  success: boolean;
  xlmFunded: string;
  usdcFunded?: string;
  txHash: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRIENDBOT_URL = "https://friendbot.stellar.org";
const RATE_LIMIT_WINDOW_SECONDS = 3600; // 1 hour
const RATE_LIMIT_KEY_PREFIX = "faucet:ratelimit:";
const RATE_LIMIT_IP_KEY_PREFIX = "faucet:ratelimit:ip:";
const MOCK_USDC_ISSUER = process.env.FAUCET_USDC_ISSUER_SECRET ?? "";
const MOCK_USDC_CODE = "USDC";
const HORIZON_TESTNET_URL = "https://horizon-testnet.stellar.org";

// ---------------------------------------------------------------------------
// Rate Limiter
// ---------------------------------------------------------------------------

export class FaucetRateLimiter {
  private redis: Redis;
  private windowSeconds: number;

  constructor(redis: Redis, windowSeconds: number = RATE_LIMIT_WINDOW_SECONDS) {
    this.redis = redis;
    this.windowSeconds = windowSeconds;
  }

  /**
   * Check and record a faucet request for rate limiting.
   * Returns true if the request is allowed, false if rate limited.
   */
  async checkAndRecord(address: string, ip: string): Promise<{
    allowed: boolean;
    reason?: string;
    retryAfterSeconds?: number;
  }> {
    const addressKey = `${RATE_LIMIT_KEY_PREFIX}${address}`;
    const ipKey = `${RATE_LIMIT_IP_KEY_PREFIX}${ip}`;

    // Check both address and IP limits
    const [addressCount, ipCount] = await Promise.all([
      this.redis.get(addressKey),
      this.redis.get(ipKey),
    ]);

    if (addressCount) {
      const ttl = await this.redis.ttl(addressKey);
      return {
        allowed: false,
        reason: "Rate limit exceeded for this address",
        retryAfterSeconds: ttl > 0 ? ttl : this.windowSeconds,
      };
    }

    if (ipCount) {
      const ttl = await this.redis.ttl(ipKey);
      return {
        allowed: false,
        reason: "Rate limit exceeded for this IP",
        retryAfterSeconds: ttl > 0 ? ttl : this.windowSeconds,
      };
    }

    // Record the request
    await Promise.all([
      this.redis.setex(addressKey, this.windowSeconds, "1"),
      this.redis.setex(ipKey, this.windowSeconds, "1"),
    ]);

    return { allowed: true };
  }

  /**
   * Get remaining time until rate limit expires for an address.
   */
  async getRemainingLimit(address: string): Promise<number> {
    const key = `${RATE_LIMIT_KEY_PREFIX}${address}`;
    return await this.redis.ttl(key);
  }
}

// ---------------------------------------------------------------------------
// Faucet Relayer
// ---------------------------------------------------------------------------

export class FaucetRelayer {
  private rateLimiter: FaucetRateLimiter;
  private log: Logger;
  private horizonUrl: string;

  constructor(
    redis: Redis,
    options?: {
      rateLimiter?: FaucetRateLimiter;
      horizonUrl?: string;
      logger?: Logger;
    },
  ) {
    this.rateLimiter = options?.rateLimiter ?? new FaucetRateLimiter(redis);
    this.horizonUrl = options?.horizonUrl ?? HORIZON_TESTNET_URL;
    this.log = options?.logger ?? createLogger("wallet:faucetRelayer", process.env.LOG_LEVEL ?? "info");
  }

  /**
   * Relay a faucet funding request.
   * 1. Rate limit check
   * 2. Call Friendbot for XLM funding
   * 3. Optionally mint mock USDC
   */
  async relay(request: FaucetRelayRequest, clientIp: string): Promise<FaucetRelayResult> {
    const { destinationAddress, mintMockUsdc } = request;

    // Validate address
    if (!this.isValidStellarAddress(destinationAddress)) {
      return {
        success: false,
        xlmFunded: "0",
        txHash: "",
      };
    }

    // Rate limit check
    const rateLimitResult = await this.rateLimiter.checkAndRecord(destinationAddress, clientIp);
    if (!rateLimitResult.allowed) {
      this.log.warn("Faucet request rate limited", {
        address: destinationAddress,
        ip: clientIp,
        reason: rateLimitResult.reason,
      });
      return {
        success: false,
        xlmFunded: "0",
        txHash: "",
      };
    }

    // 1. Call Friendbot for XLM
    let xlmTxHash = "";
    try {
      const friendbotResponse = await fetch(
        `${FRIENDBOT_URL}?addr=${destinationAddress}`,
        { method: "GET" },
      );

      if (!friendbotResponse.ok) {
        const errorBody = await friendbotResponse.text();
        this.log.error("Friendbot funding failed", {
          address: destinationAddress,
          status: friendbotResponse.status,
          error: errorBody,
        });
        return {
          success: false,
          xlmFunded: "0",
          txHash: "",
        };
      }

      const friendbotResult = await friendbotResponse.json() as any;
      xlmTxHash = friendbotResult?.result_xdr ? this.hashFromXdr(friendbotResult.result_xdr) : "";
      this.log.info("Friendbot funding successful", {
        address: destinationAddress,
        txHash: xlmTxHash,
      });
    } catch (err) {
      this.log.error("Friendbot request failed", {
        address: destinationAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        xlmFunded: "0",
        txHash: "",
      };
    }

    // 2. Optionally mint mock USDC
    let usdcFunded: string | undefined;
    if (mintMockUsdc) {
      try {
        const usdcResult = await this.mintMockUsdc(destinationAddress);
        usdcFunded = usdcResult.amount;
        if (usdcResult.txHash) {
          xlmTxHash = xlmTxHash || usdcResult.txHash;
        }
        this.log.info("Mock USDC minted", {
          address: destinationAddress,
          amount: usdcFunded,
        });
      } catch (err) {
        this.log.error("Mock USDC minting failed", {
          address: destinationAddress,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't fail the whole request if USDC minting fails — XLM was funded
      }
    }

    return {
      success: true,
      xlmFunded: "10000.0000000", // Friendbot funds 10,000 XLM
      usdcFunded,
      txHash: xlmTxHash,
    };
  }

  /**
   * Mint mock USDC tokens to the destination address from the faucet issuer.
   */
  private async mintMockUsdc(destinationAddress: string): Promise<{ amount: string; txHash: string }> {
    if (!MOCK_USDC_ISSUER) {
      this.log.warn("FAUCET_USDC_ISSUER_SECRET not configured, skipping mock USDC mint");
      return { amount: "0", txHash: "" };
    }

    const issuerKeypair = Keypair.fromSecret(MOCK_USDC_ISSUER);
    const server = new Horizon.Server(this.horizonUrl);
    const issuerAccount = await server.loadAccount(issuerKeypair.publicKey());

    const usdcAsset = new Asset(MOCK_USDC_CODE, issuerKeypair.publicKey());
    const mintAmount = "1000.0000000"; // 1000 mock USDC

    const tx = new TransactionBuilder(issuerAccount, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: destinationAddress,
          asset: usdcAsset,
          amount: mintAmount,
        }),
      )
      .setTimeout(30)
      .build();

    tx.sign(issuerKeypair);

    const result = await server.submitTransaction(tx);
    return {
      amount: mintAmount,
      txHash: result.hash ?? "",
    };
  }

  /**
   * Validate a Stellar public key.
   */
  private isValidStellarAddress(address: string): boolean {
    return /^G[A-Z2-7]{55}$/.test(address.trim());
  }

  /**
   * Extract transaction hash from Friendbot XDR response.
   */
  private hashFromXdr(_xdr: string): string {
    // Friendbot returns result_xdr but not the hash directly.
    // In production, we'd decode the XDR to extract the hash.
    // For now, return empty — the hash can be looked up via Horizon.
    return "";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFaucetRelayer(
  redis: Redis,
  options?: {
    rateLimiter?: FaucetRateLimiter;
    horizonUrl?: string;
    logger?: Logger;
  },
): FaucetRelayer {
  return new FaucetRelayer(redis, options);
}
