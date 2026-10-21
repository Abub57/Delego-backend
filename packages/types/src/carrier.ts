export type CanonicalCarrier = "fedex" | "dhl" | "ups" | "usps" | "custom";

export interface CarrierWebhookPayload {
  carrier: CanonicalCarrier;
  rawPayload: Record<string, unknown>;
  signatureHeader: string;
  receivedAt: string;
}

export interface DeliveryStateEvent {
  trackingNumber: string;
  status: NormalizedDeliveryStatus;
  location?: string;
  timestamp: string;
  signatureRequired: boolean;
}

export type NormalizedDeliveryStatus =
  | "label_created"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception"
  | "returned";
