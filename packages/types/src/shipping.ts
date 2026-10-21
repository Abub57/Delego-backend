/**
 * Carrier Webhook & Delivery Normalizer Types (Issue #368)
 *
 * Unifies webhook ingestion from major shipping carriers into a canonical
 * delivery state machine feeding into on-chain oracle release triggers.
 */

export type CanonicalCarrier = "easypost" | "fedex" | "ups" | "dhl";

export type NormalizedDeliveryStatus = "in_transit" | "delivered" | "exception";

export interface CarrierWebhookPayload {
  carrier: CanonicalCarrier;
  rawPayload: Record<string, unknown>;
  trackingNumber: string;
  normalizedStatus: NormalizedDeliveryStatus;
}

export interface DeliveryStateEvent extends CarrierWebhookPayload {
  eventId: string;
  carrierStatusCode?: string;
  carrierStatusDetails?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
