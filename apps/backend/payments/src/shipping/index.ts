/**
 * Shipping exception & lost package detector (Issue #295) — public surface.
 *
 * `detectShippingExceptions` is the entry point; `startShippingExceptionScheduler`
 * runs it daily from the payments service.
 */

export {
  classifyAnomaly,
  detectShippingExceptions,
  resolveShippingDetectionConfig,
  startShippingExceptionScheduler,
} from "./exceptionDetector.js";
export type { ShippingDetectionDeps } from "./exceptionDetector.js";

export {
  buildShippingAnomalyNotification,
  notifyShippingAnomaly,
  shippingInquiryUrl,
  SHIPPING_ANOMALY_EVENT,
} from "./notifications.js";
export type { ShippingAnomalyNotification } from "./notifications.js";

export {
  InMemoryShipmentStore,
  getShipmentStore,
  resetShipmentStore,
  setShipmentStore,
} from "./shipmentStore.js";
export type { ShipmentAnomalyFlag, ShipmentStore } from "./shipmentStore.js";

export {
  addBusinessDays,
  businessDaysBetween,
  currentTrackingStatus,
  lastMovementTimestamp,
  latestTrackingUpdate,
  TERMINAL_TRACKING_STATUSES,
} from "./tracking.js";

export {
  canTransition,
  extractCarrierCheckpoint,
  mapCarrierStatus,
  normalizeCarrierTrackingEvent,
  normalizeTrackingEvent,
  processTrackingEvent,
} from "./normalizer.js";
export type {
  CanonicalDeliveryState,
  CarrierCheckpoint,
  NormalizedTrackingEvent,
  NormalizedTrackingPayload,
  RawCarrierCheckpoint,
  RawCarrierTrackingInput,
  RawTrackingInput,
  TrackingDeps,
} from "./normalizer.js";

export { DEFAULT_SHIPPING_DETECTION_CONFIG } from "./types.js";
export type {
  InTransitShipment,
  ShipmentTrackingStatus,
  ShipmentTrackingUpdate,
  ShippingAnomalyReason,
  ShippingAnomalyRecord,
  ShippingDetectionConfig,
  ShippingScanResult,
} from "./types.js";
