export interface NegotiationOffer {
  sessionId: string;
  orderItems: { productId: string; quantity: number }[];
  offeredPriceStroops: string;
  targetCurrency: string;
  buyerMaxBudgetStroops: string;
}

export interface NegotiationResponse {
  accepted: boolean;
  counterOfferStroops?: string;
  discountPercentage?: number;
  validForSeconds: number;
  merchantSignature: string;
}

export interface SignedOffer {
  offer: NegotiationOffer;
  buyerSignature: string;
  timestamp: number;
}

export interface NegotiationSession {
  sessionId: string;
  merchantEndpoint: string;
  round: number;
  history: Array<{ offer: NegotiationOffer; response?: NegotiationResponse; timestamp: number }>;
  bestOfferStroops?: string;
  finalResult?: "accepted" | "rejected" | "max_rounds_exceeded" | "error";
}

export type NegotiationStatus =
  | "in_progress"
  | "accepted"
  | "rejected"
  | "max_rounds_exceeded"
  | "signature_invalid"
  | "error";

export interface NegotiationResult {
  status: NegotiationStatus;
  finalPriceStroops?: string;
  discountPercentage?: number;
  validForSeconds?: number;
  merchantSignature?: string;
  roundsCompleted: number;
  lastError?: string;
}
