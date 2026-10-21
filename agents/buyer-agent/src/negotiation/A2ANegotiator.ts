import { createHash, createSign, createVerify, generateKeyPairSync, type KeyPairKeyObjectResult } from "node:crypto";
import type {
  NegotiationOffer,
  NegotiationResponse,
  NegotiationSession,
  NegotiationResult,
  NegotiationStatus,
  SignedOffer,
} from "./types.js";

export const MAX_NEGOTIATION_ROUNDS = 3;
export const DEFAULT_OFFER_TTL_SECONDS = 300;
export const SIGNATURE_ALGORITHM = "SHA256";
export const DEFAULT_BASE_URL = "http://localhost:3000";

function canonicalizeObject(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort());
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function computeOfferDigest(offer: NegotiationOffer, timestamp: number): string {
  const payload = {
    sessionId: offer.sessionId,
    orderItems: offer.orderItems.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    })),
    offeredPriceStroops: offer.offeredPriceStroops,
    targetCurrency: offer.targetCurrency,
    buyerMaxBudgetStroops: offer.buyerMaxBudgetStroops,
    timestamp,
  };
  return sha256Hex(canonicalizeObject(payload));
}

function computeResponseDigest(
  response: NegotiationResponse,
  offer: NegotiationOffer,
  timestamp: number,
): string {
  const payload = {
    accepted: response.accepted,
    counterOfferStroops: response.counterOfferStroops,
    discountPercentage: response.discountPercentage,
    validForSeconds: response.validForSeconds,
    sessionId: offer.sessionId,
    timestamp,
  };
  return sha256Hex(canonicalizeObject(payload));
}

export interface A2ANegotiatorConfig {
  buyerSigningKey?: KeyPairKeyObjectResult;
  merchantPublicKeyPem?: string;
  baseUrl?: string;
  maxRounds?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class A2ANegotiator {
  private readonly signingKey: KeyPairKeyObjectResult;
  private readonly merchantPublicKeyPem: string | undefined;
  private readonly baseUrl: string;
  private readonly maxRounds: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  private readonly sessions = new Map<string, NegotiationSession>();

  constructor(config: A2ANegotiatorConfig = {}) {
    this.signingKey = config.buyerSigningKey ?? generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    this.merchantPublicKeyPem = config.merchantPublicKeyPem;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.maxRounds = config.maxRounds ?? MAX_NEGOTIATION_ROUNDS;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.logger = config.logger ?? noopLogger;
  }

  getBuyerPublicKeyPem(): string {
    return this.signingKey.publicKey.export({ type: "spki", format: "pem" }) as string;
  }

  setMerchantPublicKey(publicKeyPem: string): void {
    (this as any).merchantPublicKeyPem = publicKeyPem;
  }

  private createSession(sessionId: string, merchantEndpoint: string): NegotiationSession {
    const session: NegotiationSession = {
      sessionId,
      merchantEndpoint,
      round: 0,
      history: [],
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): NegotiationSession | undefined {
    return this.sessions.get(sessionId);
  }

  private signOffer(offer: NegotiationOffer, timestamp: number): string {
    const digest = computeOfferDigest(offer, timestamp);
    const signer = createSign(SIGNATURE_ALGORITHM);
    signer.update(digest, "hex");
    return signer.sign(this.signingKey.privateKey, "base64");
  }

  verifyMerchantSignature(
    response: NegotiationResponse,
    offer: NegotiationOffer,
    timestamp: number,
    publicKeyPemOverride?: string,
  ): boolean {
    const keyPem = publicKeyPemOverride ?? this.merchantPublicKeyPem;
    if (!keyPem) {
      this.logger.warn("Cannot verify merchant signature: no public key configured", {
        sessionId: offer.sessionId,
      });
      return false;
    }

    try {
      const digest = computeResponseDigest(response, offer, timestamp);
      const verifier = createVerify(SIGNATURE_ALGORITHM);
      verifier.update(digest, "hex");
      return verifier.verify(keyPem, response.merchantSignature, "base64");
    } catch (err) {
      this.logger.error("Merchant signature verification threw exception", {
        sessionId: offer.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async sendSignedOffer(
    offer: NegotiationOffer,
    merchantEndpoint: string,
  ): Promise<{ response: NegotiationResponse; timestamp: number }> {
    const timestamp = Date.now();
    const buyerSignature = this.signOffer(offer, timestamp);
    const signedPayload: SignedOffer & { timestamp: number } = {
      offer,
      buyerSignature,
      timestamp,
    };

    const url = merchantEndpoint.startsWith("http")
      ? merchantEndpoint
      : `${this.baseUrl}${merchantEndpoint}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      this.logger.info("Sending negotiation offer", {
        sessionId: offer.sessionId,
        offeredPriceStroops: offer.offeredPriceStroops,
        url,
      });

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Negotiation-Session": offer.sessionId,
          "X-Negotiation-Timestamp": String(timestamp),
        },
        body: JSON.stringify(signedPayload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Merchant negotiation endpoint returned ${res.status}: ${text}`);
      }

      const body = (await res.json()) as NegotiationResponse;
      return { response: body, timestamp };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildCounterOffer(
    previous: NegotiationOffer,
    response: NegotiationResponse,
  ): NegotiationOffer | null {
    if (!response.counterOfferStroops) {
      return null;
    }

    const counter = BigInt(response.counterOfferStroops);
    const maxBudget = BigInt(previous.buyerMaxBudgetStroops);

    if (counter > maxBudget) {
      this.logger.info("Counter offer exceeds buyer max budget — will not counter", {
        sessionId: previous.sessionId,
        counterOfferStroops: response.counterOfferStroops,
        buyerMaxBudgetStroops: previous.buyerMaxBudgetStroops,
      });
      return null;
    }

    const current = BigInt(previous.offeredPriceStroops);
    const diff = counter - current;
    const split = diff / 2n;
    const nextOffer = current + split;

    return {
      sessionId: previous.sessionId,
      orderItems: previous.orderItems,
      offeredPriceStroops: String(nextOffer),
      targetCurrency: previous.targetCurrency,
      buyerMaxBudgetStroops: previous.buyerMaxBudgetStroops,
    };
  }

  async negotiate(
    initialOffer: NegotiationOffer,
    merchantEndpoint: string,
  ): Promise<NegotiationResult> {
    const session = this.createSession(initialOffer.sessionId, merchantEndpoint);
    let currentOffer: NegotiationOffer = initialOffer;
    let lastResponse: NegotiationResponse | undefined;

    while (session.round < this.maxRounds) {
      session.round += 1;

      this.logger.info("Negotiation round starting", {
        sessionId: session.sessionId,
        round: session.round,
        maxRounds: this.maxRounds,
      });

      let response: NegotiationResponse;
      let responseTimestamp: number;

      try {
        const sent = await this.sendSignedOffer(currentOffer, merchantEndpoint);
        response = sent.response;
        responseTimestamp = sent.timestamp;
      } catch (err: any) {
        session.finalResult = "error";
        session.history.push({ offer: currentOffer, timestamp: Date.now() });

        const status: NegotiationStatus = "error";
        this.logger.error("Negotiation round failed with transport error", {
          sessionId: session.sessionId,
          round: session.round,
          error: err instanceof Error ? err.message : String(err),
        });

        return {
          status,
          roundsCompleted: session.round - 1,
          lastError: err instanceof Error ? err.message : String(err),
        };
      }

      session.history.push({
        offer: currentOffer,
        response,
        timestamp: Date.now(),
      });

      if (this.merchantPublicKeyPem) {
        const signatureValid = this.verifyMerchantSignature(
          response,
          currentOffer,
          responseTimestamp,
        );
        if (!signatureValid) {
          session.finalResult = "error";
          this.logger.warn("Merchant response signature verification failed", {
            sessionId: session.sessionId,
            round: session.round,
          });
          return {
            status: "signature_invalid",
            roundsCompleted: session.round,
            lastError: "Merchant signature verification failed",
          };
        }
      }

      if (response.accepted) {
        session.finalResult = "accepted";
        session.bestOfferStroops = currentOffer.offeredPriceStroops;
        this.logger.info("Negotiation accepted by merchant", {
          sessionId: session.sessionId,
          round: session.round,
          finalPriceStroops: currentOffer.offeredPriceStroops,
          discountPercentage: response.discountPercentage,
        });
        return {
          status: "accepted",
          finalPriceStroops: currentOffer.offeredPriceStroops,
          discountPercentage: response.discountPercentage,
          validForSeconds: response.validForSeconds,
          merchantSignature: response.merchantSignature,
          roundsCompleted: session.round,
        };
      }

      lastResponse = response;
      const nextOffer = this.buildCounterOffer(currentOffer, response);

      if (!nextOffer) {
        session.finalResult = "rejected";
        this.logger.info("Negotiation ended: no acceptable counter available", {
          sessionId: session.sessionId,
          round: session.round,
        });
        return {
          status: "rejected",
          roundsCompleted: session.round,
          finalPriceStroops: response.counterOfferStroops,
          discountPercentage: response.discountPercentage,
        };
      }

      currentOffer = nextOffer;
    }

    session.finalResult = "max_rounds_exceeded";
    this.logger.warn("Negotiation exceeded maximum rounds", {
      sessionId: session.sessionId,
      maxRounds: this.maxRounds,
    });

    return {
      status: "max_rounds_exceeded",
      roundsCompleted: this.maxRounds,
      finalPriceStroops: lastResponse?.counterOfferStroops,
      discountPercentage: lastResponse?.discountPercentage,
      lastError: `Negotiation exceeded maximum of ${this.maxRounds} rounds`,
    };
  }
}
