/**
 * Carrier Webhook Normalizer and Parser Module (Issue #368)
 *
 * Provides canonical normalization of shipping webhook payloads from
 * EasyPost, FedEx, UPS, and DHL into standardized DeliveryStateEvents.
 */

import type {
  CanonicalCarrier,
  CarrierWebhookPayload,
  DeliveryStateEvent,
  NormalizedDeliveryStatus,
} from "@delegolabs/types";
import { generateId } from "../id.js";
import { createLogger } from "../logger.js";
import { RedisStreamManager } from "../redis/streams.js";

const logger = createLogger("carrier-webhook-normalizer");

export const CARRIER_DELIVERY_STREAM = "stream:carrier:delivery_events";

export interface CarrierParser {
  carrier: CanonicalCarrier;
  parse(payload: Record<string, unknown>): CarrierWebhookPayload;
}

/**
 * Status mapping logic for EasyPost
 * EasyPost statuses:
 * - "delivered" -> "delivered"
 * - "pre_transit", "in_transit", "out_for_delivery", "available_for_pickup" -> "in_transit"
 * - "failure", "cancelled", "error", "return_to_sender", "unknown" -> "exception"
 */
export class EasyPostWebhookParser implements CarrierParser {
  readonly carrier: CanonicalCarrier = "easypost";

  parse(payload: Record<string, unknown>): CarrierWebhookPayload {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid EasyPost webhook payload: expected an object");
    }

    // EasyPost events usually have `result` object containing Tracker details or are Tracker objects directly
    const resultObj = (payload.result && typeof payload.result === "object"
      ? payload.result
      : payload) as Record<string, unknown>;

    const trackingCode =
      (resultObj.tracking_code as string) ||
      (resultObj.trackingNumber as string) ||
      (payload.tracking_code as string) ||
      "";

    if (!trackingCode) {
      throw new Error("Missing tracking number in EasyPost payload");
    }

    const rawStatus = String(resultObj.status || payload.status || "").toLowerCase().trim();
    let normalizedStatus: NormalizedDeliveryStatus = "exception";

    switch (rawStatus) {
      case "delivered":
        normalizedStatus = "delivered";
        break;
      case "pre_transit":
      case "in_transit":
      case "out_for_delivery":
      case "available_for_pickup":
        normalizedStatus = "in_transit";
        break;
      case "failure":
      case "cancelled":
      case "error":
      case "return_to_sender":
      case "unknown":
      default:
        normalizedStatus = "exception";
        break;
    }

    return {
      carrier: "easypost",
      rawPayload: payload,
      trackingNumber: trackingCode,
      normalizedStatus,
    };
  }
}

/**
 * Status mapping logic for FedEx
 * FedEx statuses:
 * - "DL" (Delivered) -> "delivered"
 * - "OC" (Order Created), "PU" (Picked Up), "DP" (Departed), "AR" (Arrived), "OD" (Out for Delivery), "IT" (In Transit) -> "in_transit"
 * - "DE" (Delivery Exception), "CA" (Cancelled), "DY" (Delay), "SE" (Shipment Exception) -> "exception"
 */
export class FedExWebhookParser implements CarrierParser {
  readonly carrier: CanonicalCarrier = "fedex";

  parse(payload: Record<string, unknown>): CarrierWebhookPayload {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid FedEx webhook payload: expected an object");
    }

    // FedEx payloads typically contain trackResults, trackDetails, or direct fields
    let trackingNumber = "";
    let statusCode = "";

    const trackPackagesResponse = payload.TrackPackagesResponse as Record<string, unknown> | undefined;
    const packageList = trackPackagesResponse?.packageList as Array<Record<string, unknown>> | undefined;

    if (Array.isArray(payload.trackResults) && payload.trackResults.length > 0) {
      const firstResult = payload.trackResults[0] as Record<string, unknown>;
      trackingNumber = (firstResult.trackingNumber as string) || "";
      const latestStatusDetail = firstResult.latestStatusDetail as Record<string, unknown> | undefined;
      statusCode = (latestStatusDetail?.code as string) || (latestStatusDetail?.statusByLocale as string) || (firstResult.status as string) || "";
    } else if (Array.isArray(packageList) && packageList.length > 0) {
      const pkg = packageList[0] as Record<string, unknown>;
      trackingNumber = (pkg.trackingNumber as string) || "";
      statusCode = (pkg.status as string) || (pkg.statusCode as string) || "";
    } else {
      trackingNumber =
        (payload.trackingNumber as string) ||
        (payload.tracking_number as string) ||
        (payload.trackingCode as string) ||
        "";
      statusCode = (payload.status as string) || (payload.statusCode as string) || (payload.eventType as string) || "";
    }

    if (!trackingNumber) {
      throw new Error("Missing tracking number in FedEx payload");
    }

    const normalizedCode = statusCode.toUpperCase().trim();
    let normalizedStatus: NormalizedDeliveryStatus = "exception";

    switch (normalizedCode) {
      case "DL":
      case "DELIVERED":
        normalizedStatus = "delivered";
        break;
      case "OC":
      case "PU":
      case "DP":
      case "AR":
      case "OD":
      case "IT":
      case "IN_TRANSIT":
      case "ON_THE_WAY":
      case "OUT_FOR_DELIVERY":
        normalizedStatus = "in_transit";
        break;
      case "DE":
      case "CA":
      case "DY":
      case "SE":
      case "EXCEPTION":
      case "DELAYED":
      case "CANCELLED":
      default:
        normalizedStatus = "exception";
        break;
    }

    return {
      carrier: "fedex",
      rawPayload: payload,
      trackingNumber,
      normalizedStatus,
    };
  }
}

/**
 * Status mapping logic for UPS
 * UPS statuses:
 * - "D" (Delivered) -> "delivered"
 * - "I" (In Transit), "P" (Pickup), "M" (Manifest/Billing information received), "O" (Out for Delivery) -> "in_transit"
 * - "X" (Exception), "RS" (Return to Sender), "NA" -> "exception"
 */
export class UPSWebhookParser implements CarrierParser {
  readonly carrier: CanonicalCarrier = "ups";

  parse(payload: Record<string, unknown>): CarrierWebhookPayload {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid UPS webhook payload: expected an object");
    }

    let trackingNumber = "";
    let statusCode = "";

    const trackResponse = (payload.TrackResponse || payload.trackResponse || payload) as Record<string, unknown>;
    const shipment = (trackResponse.shipment || trackResponse.Shipment || trackResponse) as Record<string, unknown>;

    if (Array.isArray(shipment.package) && shipment.package.length > 0) {
      const pkg = shipment.package[0] as Record<string, unknown>;
      trackingNumber = (pkg.trackingNumber as string) || (pkg.TrackingNumber as string) || "";
      const currentStatus = pkg.currentStatus as Record<string, unknown> | undefined;
      statusCode = (currentStatus?.code as string) || (pkg.status as string) || "";
    } else {
      trackingNumber =
        (shipment.trackingNumber as string) ||
        (shipment.TrackingNumber as string) ||
        (payload.trackingNumber as string) ||
        (payload.tracking_number as string) ||
        "";
      statusCode =
        (shipment.statusCode as string) ||
        (shipment.status as string) ||
        (payload.statusCode as string) ||
        (payload.status as string) ||
        "";
    }

    if (!trackingNumber) {
      throw new Error("Missing tracking number in UPS payload");
    }

    const normalizedCode = statusCode.toUpperCase().trim();
    let normalizedStatus: NormalizedDeliveryStatus = "exception";

    switch (normalizedCode) {
      case "D":
      case "DELIVERED":
        normalizedStatus = "delivered";
        break;
      case "I":
      case "P":
      case "M":
      case "O":
      case "IN_TRANSIT":
      case "OUT_FOR_DELIVERY":
      case "PICKUP":
      case "MANIFEST":
        normalizedStatus = "in_transit";
        break;
      case "X":
      case "RS":
      case "EXCEPTION":
      case "RETURN_TO_SENDER":
      default:
        normalizedStatus = "exception";
        break;
    }

    return {
      carrier: "ups",
      rawPayload: payload,
      trackingNumber,
      normalizedStatus,
    };
  }
}

/**
 * Status mapping logic for DHL
 * DHL statuses:
 * - "delivered" -> "delivered"
 * - "pre-transit", "transit", "picked-up", "out-for-delivery" -> "in_transit"
 * - "failure", "exception", "returned" -> "exception"
 */
export class DHLWebhookParser implements CarrierParser {
  readonly carrier: CanonicalCarrier = "dhl";

  parse(payload: Record<string, unknown>): CarrierWebhookPayload {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid DHL webhook payload: expected an object");
    }

    let trackingNumber = "";
    let statusCode = "";

    const shipments = (payload.shipments || payload.events) as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(shipments) && shipments.length > 0) {
      const first = shipments[0];
      trackingNumber = (first.id as string) || (first.trackingNumber as string) || "";
      const statusObj = first.status as Record<string, unknown> | undefined;
      statusCode = (statusObj?.statusCode as string) || (first.statusCode as string) || (first.status as string) || "";
    } else {
      trackingNumber =
        (payload.trackingNumber as string) ||
        (payload.tracking_number as string) ||
        (payload.id as string) ||
        "";
      statusCode = (payload.status as string) || (payload.statusCode as string) || "";
    }

    if (!trackingNumber) {
      throw new Error("Missing tracking number in DHL payload");
    }

    const normalizedCode = statusCode.toLowerCase().trim();
    let normalizedStatus: NormalizedDeliveryStatus = "exception";

    switch (normalizedCode) {
      case "delivered":
      case "success":
        normalizedStatus = "delivered";
        break;
      case "pre-transit":
      case "transit":
      case "in-transit":
      case "picked-up":
      case "out-for-delivery":
        normalizedStatus = "in_transit";
        break;
      case "failure":
      case "exception":
      case "returned":
      default:
        normalizedStatus = "exception";
        break;
    }

    return {
      carrier: "dhl",
      rawPayload: payload,
      trackingNumber,
      normalizedStatus,
    };
  }
}

/**
 * Carrier Webhook Normalizer Registry & Service
 */
export class CarrierWebhookNormalizer {
  private readonly parsers = new Map<CanonicalCarrier, CarrierParser>();
  private readonly streamManager?: RedisStreamManager<DeliveryStateEvent>;

  constructor(options?: {
    redisClient?: any;
    streamManager?: RedisStreamManager<DeliveryStateEvent>;
    customParsers?: CarrierParser[];
  }) {
    // Register default carrier parsers
    this.registerParser(new EasyPostWebhookParser());
    this.registerParser(new FedExWebhookParser());
    this.registerParser(new UPSWebhookParser());
    this.registerParser(new DHLWebhookParser());

    if (options?.customParsers) {
      for (const parser of options.customParsers) {
        this.registerParser(parser);
      }
    }

    if (options?.streamManager) {
      this.streamManager = options.streamManager;
    } else if (options?.redisClient) {
      this.streamManager = new RedisStreamManager<DeliveryStateEvent>(
        CARRIER_DELIVERY_STREAM,
        {
          maxLength: 50000,
          trimStrategy: "maxlen",
          consumerGroups: [
            { name: "oracle-delivery-triggers", consumers: 3, claimMinIdleMs: 30000 },
          ],
        },
        options.redisClient
      );
    }
  }

  registerParser(parser: CarrierParser): void {
    this.parsers.set(parser.carrier, parser);
  }

  getParser(carrier: CanonicalCarrier): CarrierParser | undefined {
    return this.parsers.get(carrier);
  }

  /**
   * Normalizes a carrier webhook payload into a canonical CarrierWebhookPayload
   */
  normalize(carrier: CanonicalCarrier, rawPayload: Record<string, unknown>): CarrierWebhookPayload {
    const parser = this.parsers.get(carrier);
    if (!parser) {
      throw new Error(`Unsupported carrier: ${carrier}`);
    }
    return parser.parse(rawPayload);
  }

  /**
   * Ingests a raw webhook, normalizes it into a DeliveryStateEvent,
   * and publishes it to the Redis stream for oracle release trigger processing.
   */
  async ingestAndPublish(
    carrier: CanonicalCarrier,
    rawPayload: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): Promise<DeliveryStateEvent> {
    const normalized = this.normalize(carrier, rawPayload);

    const event: DeliveryStateEvent = {
      ...normalized,
      eventId: generateId("delv_"),
      timestamp: new Date().toISOString(),
      metadata,
    };

    if (this.streamManager) {
      try {
        await this.streamManager.publish(
          `delivery.${event.carrier}.${event.normalizedStatus}`,
          event,
          {
            carrier: event.carrier,
            trackingNumber: event.trackingNumber,
            status: event.normalizedStatus,
          }
        );
        logger.info("Published carrier delivery event to Redis stream", {
          eventId: event.eventId,
          carrier: event.carrier,
          trackingNumber: event.trackingNumber,
          normalizedStatus: event.normalizedStatus,
        });
      } catch (err: any) {
        logger.error("Failed to publish carrier delivery event to Redis stream", {
          eventId: event.eventId,
          error: err.message,
        });
        throw err;
      }
    } else {
      logger.debug("No Redis stream manager configured, returning event without publishing", {
        eventId: event.eventId,
      });
    }

    return event;
  }
}
