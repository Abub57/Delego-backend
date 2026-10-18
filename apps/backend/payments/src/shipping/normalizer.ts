export type CanonicalDeliveryState =
  | "label_created"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception";

export interface NormalizedTrackingPayload {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  state: CanonicalDeliveryState;
  deliveredTimestamp?: string;
  location?: string;
}

export interface RawTrackingInput {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  /** Provider status code or description, e.g. "DL", "Delivered", "out_for_delivery". */
  status: string | null | undefined;
  deliveredTimestamp?: string;
  location?: string;
}

const DEFAULT_STATE: CanonicalDeliveryState = "in_transit";

const clean = (v: unknown): string =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const STATUS_MAP: Record<string, Record<string, CanonicalDeliveryState>> = {
  fedex: {
    oc: "label_created",
    order_created: "label_created",
    pu: "in_transit",
    picked_up: "in_transit",
    it: "in_transit",
    in_transit: "in_transit",
    od: "out_for_delivery",
    out_for_delivery: "out_for_delivery",
    dl: "delivered",
    delivered: "delivered",
    de: "exception",
    se: "exception",
    delivery_exception: "exception",
    shipment_exception: "exception",
  },
  ups: {
    m: "label_created",
    mp: "label_created",
    manifest: "label_created",
    label_created: "label_created",
    p: "in_transit",
    i: "in_transit",
    in_transit: "in_transit",
    o: "out_for_delivery",
    out_for_delivery: "out_for_delivery",
    d: "delivered",
    delivered: "delivered",
    x: "exception",
    exception: "exception",
  },
  dhl: {
    pre_transit: "label_created",
    transit: "in_transit",
    in_transit: "in_transit",
    out_for_delivery: "out_for_delivery",
    delivered: "delivered",
    failure: "exception",
    exception: "exception",
  },
  easypost: {
    pre_transit: "label_created",
    in_transit: "in_transit",
    out_for_delivery: "out_for_delivery",
    available_for_pickup: "out_for_delivery",
    delivered: "delivered",
    return_to_sender: "exception",
    failure: "exception",
    cancelled: "exception",
    error: "exception",
  },
};

/** Map a provider status string to the canonical state. Never throws; unmapped -> "in_transit". */
export function mapCarrierStatus(
  carrier: string,
  status: string | null | undefined
): CanonicalDeliveryState {
  try {
    const table = STATUS_MAP[clean(carrier)];
    return table?.[clean(status)] ?? DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

export function normalizeTrackingEvent(input: RawTrackingInput): NormalizedTrackingPayload {
  const state = mapCarrierStatus(input.carrier, input.status);
  const payload: NormalizedTrackingPayload = {
    orderId: input.orderId,
    carrier: input.carrier,
    trackingNumber: input.trackingNumber,
    state,
  };
  if (state === "delivered" && input.deliveredTimestamp) {
    payload.deliveredTimestamp = input.deliveredTimestamp;
  }
  if (input.location) payload.location = input.location;
  return payload;
}

const RANK: Record<CanonicalDeliveryState, number> = {
  label_created: 0,
  in_transit: 1,
  out_for_delivery: 2,
  delivered: 3,
  exception: 1,
};

/** Forward-only transitions; "delivered" is terminal; "exception" is reachable from any non-delivered state. */
export function canTransition(
  from: CanonicalDeliveryState | undefined,
  to: CanonicalDeliveryState
): boolean {
  if (!from) return true;
  if (from === to || from === "delivered") return false;
  if (to === "exception" || to === "delivered") return true;
  if (from === "exception") return true; // recovery after an exception
  return RANK[to] > RANK[from];
}

// ---------------------------------------------------------------------------
// Checkpoint-aware normalization (Issue #341)
//
// Carrier webhooks (DHL, FedEx, UPS) frequently report a scan event with no
// resolved location yet — e.g. "label created" before the parcel has reached
// a facility, or a mid-transit scan the carrier hasn't geocoded. Treating the
// checkpoint object as always-present threw `TypeError: Cannot read
// properties of undefined` deep in the ingestion pipeline. Everything below
// extracts what's there and falls back to `null`/defaults for what isn't;
// nothing here ever throws on a sparse or absent checkpoint.
// ---------------------------------------------------------------------------

/** Raw checkpoint shape as carriers send it — every field may be missing or null. */
export interface RawCarrierCheckpoint {
  city?: string | null;
  state?: string | null;
  country?: string | null;
  timestamp?: string | null;
  statusDetails?: string | null;
  /** Some providers (EasyPost) use `message` instead of `statusDetails`. */
  message?: string | null;
}

/** Cleaned checkpoint; only fields the carrier actually sent are present. */
export interface CarrierCheckpoint {
  city?: string;
  state?: string;
  country?: string;
  timestamp?: string;
  statusDetails?: string;
}

/** Provider-agnostic normalized tracking event, per issue #341's schema. */
export interface NormalizedTrackingEvent {
  trackingNumber: string;
  carrier: string;
  status: CanonicalDeliveryState;
  checkpoint: CarrierCheckpoint | null;
  occurredAt: Date;
}

export interface RawCarrierTrackingInput {
  carrier: string;
  trackingNumber: string;
  status: string | null | undefined;
  checkpoint?: RawCarrierCheckpoint | null;
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Safely extracts whatever location/timestamp data a carrier checkpoint
 * actually contains. Returns `null` when the checkpoint is missing entirely
 * or carries no usable fields — never throws on `undefined`/`null` input or
 * on individual missing fields (the exact "sparse webhook payload" case
 * from DHL, FedEx, and UPS that issue #341 reports crashing the normalizer).
 */
export function extractCarrierCheckpoint(
  raw: RawCarrierCheckpoint | null | undefined
): CarrierCheckpoint | null {
  if (!raw) return null;

  const checkpoint: CarrierCheckpoint = {};
  const city = cleanOptionalString(raw.city);
  if (city) checkpoint.city = city;
  const state = cleanOptionalString(raw.state);
  if (state) checkpoint.state = state;
  const country = cleanOptionalString(raw.country);
  if (country) checkpoint.country = country;
  const timestamp = cleanOptionalString(raw.timestamp);
  if (timestamp) checkpoint.timestamp = timestamp;
  const statusDetails = cleanOptionalString(raw.statusDetails) ?? cleanOptionalString(raw.message);
  if (statusDetails) checkpoint.statusDetails = statusDetails;

  return Object.keys(checkpoint).length > 0 ? checkpoint : null;
}

/**
 * Normalizes a raw carrier webhook payload into a {@link NormalizedTrackingEvent}.
 * Zero uncaught `TypeError`s: a missing/undefined `checkpoint`, or a
 * checkpoint missing its `timestamp`, never crashes ingestion — the status
 * mapping and `occurredAt` both fall back to safe defaults instead.
 */
export function normalizeCarrierTrackingEvent(
  input: RawCarrierTrackingInput
): NormalizedTrackingEvent {
  const status = mapCarrierStatus(input.carrier, input.status);
  const checkpoint = extractCarrierCheckpoint(input.checkpoint);

  const parsedTimestamp = checkpoint?.timestamp ? Date.parse(checkpoint.timestamp) : NaN;
  const occurredAt = Number.isFinite(parsedTimestamp) ? new Date(parsedTimestamp) : new Date();

  return {
    trackingNumber: input.trackingNumber,
    carrier: input.carrier,
    status,
    checkpoint,
    occurredAt,
  };
}

export interface TrackingDeps {
  getPreviousState: (trackingNumber: string) => Promise<CanonicalDeliveryState | undefined>;
  saveState: (payload: NormalizedTrackingPayload) => Promise<void>;
  /** Orchestrator workflow step trigger; called only on an actual state change. */
  onStateChange: (
    payload: NormalizedTrackingPayload,
    previous: CanonicalDeliveryState | undefined
  ) => Promise<void>;
}

/**
 * Idempotent: replayed or out-of-order events produce no change and no trigger.
 * State is saved only after the orchestrator step succeeds, so failures can be retried.
 */
export async function processTrackingEvent(
  input: RawTrackingInput,
  deps: TrackingDeps
): Promise<{ changed: boolean; payload: NormalizedTrackingPayload }> {
  const payload = normalizeTrackingEvent(input);
  const previous = await deps.getPreviousState(payload.trackingNumber);
  if (!canTransition(previous, payload.state)) return { changed: false, payload };
  await deps.onStateChange(payload, previous);
  await deps.saveState(payload);
  return { changed: true, payload };
}
