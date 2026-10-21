/**
 * Unit tests for Carrier Webhook Receiver & Normalizer (Issue #368)
 *
 * Verifies coverage across sample payloads from:
 * - EasyPost
 * - FedEx
 * - UPS
 * - DHL
 * And tests event ingestion & publishing to Redis stream.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CarrierWebhookNormalizer,
  EasyPostWebhookParser,
  FedExWebhookParser,
  UPSWebhookParser,
  DHLWebhookParser,
  CARRIER_DELIVERY_STREAM,
} from "./index.js";

describe("Carrier Webhook Receiver & Normalizer (Issue #368)", () => {
  describe("EasyPostWebhookParser", () => {
    const parser = new EasyPostWebhookParser();

    it("parses EasyPost delivered event correctly", () => {
      const payload = {
        result: {
          tracking_code: "EZ1000000001",
          status: "delivered",
          carrier: "USPS",
        },
      };

      const result = parser.parse(payload);
      expect(result.carrier).toBe("easypost");
      expect(result.trackingNumber).toBe("EZ1000000001");
      expect(result.normalizedStatus).toBe("delivered");
    });

    it("parses EasyPost in_transit statuses (pre_transit, in_transit, out_for_delivery)", () => {
      const statuses = ["pre_transit", "in_transit", "out_for_delivery", "available_for_pickup"];
      for (const status of statuses) {
        const payload = {
          tracking_code: "EZ1000000002",
          status,
        };
        const result = parser.parse(payload);
        expect(result.normalizedStatus).toBe("in_transit");
        expect(result.trackingNumber).toBe("EZ1000000002");
      }
    });

    it("parses EasyPost exception statuses (failure, cancelled, return_to_sender, error)", () => {
      const exceptionStatuses = ["failure", "cancelled", "return_to_sender", "error", "unknown"];
      for (const status of exceptionStatuses) {
        const payload = {
          result: {
            tracking_code: "EZ1000000003",
            status,
          },
        };
        const result = parser.parse(payload);
        expect(result.normalizedStatus).toBe("exception");
      }
    });

    it("throws error on missing tracking code", () => {
      expect(() => parser.parse({ status: "in_transit" })).toThrow("Missing tracking number");
    });
  });

  describe("FedExWebhookParser", () => {
    const parser = new FedExWebhookParser();

    it("parses FedEx delivered payload (trackResults format)", () => {
      const payload = {
        trackResults: [
          {
            trackingNumber: "794612345678",
            latestStatusDetail: {
              code: "DL",
              description: "Delivered",
            },
          },
        ],
      };

      const result = parser.parse(payload);
      expect(result.carrier).toBe("fedex");
      expect(result.trackingNumber).toBe("794612345678");
      expect(result.normalizedStatus).toBe("delivered");
    });

    it("parses FedEx in_transit payload (TrackPackagesResponse format)", () => {
      const payload = {
        TrackPackagesResponse: {
          packageList: [
            {
              trackingNumber: "794698765432",
              status: "IT",
            },
          ],
        },
      };

      const result = parser.parse(payload);
      expect(result.carrier).toBe("fedex");
      expect(result.trackingNumber).toBe("794698765432");
      expect(result.normalizedStatus).toBe("in_transit");
    });

    it("parses FedEx exception payload", () => {
      const payload = {
        trackingNumber: "794611112222",
        status: "DE",
      };

      const result = parser.parse(payload);
      expect(result.carrier).toBe("fedex");
      expect(result.trackingNumber).toBe("794611112222");
      expect(result.normalizedStatus).toBe("exception");
    });

    it("throws error on missing tracking number", () => {
      expect(() => parser.parse({ status: "DL" })).toThrow("Missing tracking number");
    });
  });

  describe("UPSWebhookParser", () => {
    const parser = new UPSWebhookParser();

    it("parses UPS delivered payload (TrackResponse format)", () => {
      const payload = {
        TrackResponse: {
          shipment: {
            package: [
              {
                trackingNumber: "1Z9999999999999999",
                currentStatus: {
                  code: "D",
                  description: "DELIVERED",
                },
              },
            ],
          },
        },
      };

      const result = parser.parse(payload);
      expect(result.carrier).toBe("ups");
      expect(result.trackingNumber).toBe("1Z9999999999999999");
      expect(result.normalizedStatus).toBe("delivered");
    });

    it("parses UPS in_transit payload", () => {
      const payload = {
        trackingNumber: "1Z8888888888888888",
        statusCode: "I",
      };

      const result = parser.parse(payload);
      expect(result.carrier).toBe("ups");
      expect(result.trackingNumber).toBe("1Z8888888888888888");
      expect(result.normalizedStatus).toBe("in_transit");
    });

    it("parses UPS exception payload", () => {
      const payload = {
        trackingNumber: "1Z7777777777777777",
        statusCode: "X",
      };

      const result = parser.parse(payload);
      expect(result.carrier).toBe("ups");
      expect(result.trackingNumber).toBe("1Z7777777777777777");
      expect(result.normalizedStatus).toBe("exception");
    });

    it("throws error on missing tracking number", () => {
      expect(() => parser.parse({ statusCode: "D" })).toThrow("Missing tracking number");
    });
  });

  describe("DHLWebhookParser", () => {
    const parser = new DHLWebhookParser();

    it("parses DHL delivered payload", () => {
      const payload = {
        shipments: [
          {
            id: "DHL1234567890",
            status: {
              statusCode: "delivered",
            },
          },
        ],
      };

      const result = parser.parse(payload);
      expect(result.carrier).toBe("dhl");
      expect(result.trackingNumber).toBe("DHL1234567890");
      expect(result.normalizedStatus).toBe("delivered");
    });

    it("parses DHL in-transit payload", () => {
      const payload = {
        trackingNumber: "DHL0987654321",
        status: "transit",
      };

      const result = parser.parse(payload);
      expect(result.carrier).toBe("dhl");
      expect(result.trackingNumber).toBe("DHL0987654321");
      expect(result.normalizedStatus).toBe("in_transit");
    });

    it("parses DHL exception payload", () => {
      const payload = {
        trackingNumber: "DHL5555555555",
        status: "exception",
      };

      const result = parser.parse(payload);
      expect(result.carrier).toBe("dhl");
      expect(result.trackingNumber).toBe("DHL5555555555");
      expect(result.normalizedStatus).toBe("exception");
    });
  });

  describe("CarrierWebhookNormalizer integration & publishing", () => {
    let normalizer: CarrierWebhookNormalizer;
    let mockStreamManager: any;

    beforeEach(() => {
      mockStreamManager = {
        publish: vi.fn().mockResolvedValue("msg-12345"),
      };
      normalizer = new CarrierWebhookNormalizer({
        streamManager: mockStreamManager,
      });
    });

    it("normalizes and publishes delivery event to Redis stream for EasyPost", async () => {
      const rawPayload = {
        tracking_code: "EZ9999",
        status: "delivered",
      };

      const event = await normalizer.ingestAndPublish("easypost", rawPayload, { orderId: "ord_1" });

      expect(event.carrier).toBe("easypost");
      expect(event.trackingNumber).toBe("EZ9999");
      expect(event.normalizedStatus).toBe("delivered");
      expect(event.eventId).toMatch(/^delv_/);
      expect(event.metadata).toEqual({ orderId: "ord_1" });

      expect(mockStreamManager.publish).toHaveBeenCalledWith(
        "delivery.easypost.delivered",
        event,
        {
          carrier: "easypost",
          trackingNumber: "EZ9999",
          status: "delivered",
        }
      );
    });

    it("normalizes and publishes in_transit event for FedEx", async () => {
      const rawPayload = {
        trackingNumber: "FDX123",
        status: "IN_TRANSIT",
      };

      const event = await normalizer.ingestAndPublish("fedex", rawPayload);

      expect(event.carrier).toBe("fedex");
      expect(event.normalizedStatus).toBe("in_transit");
      expect(mockStreamManager.publish).toHaveBeenCalledWith(
        "delivery.fedex.in_transit",
        event,
        {
          carrier: "fedex",
          trackingNumber: "FDX123",
          status: "in_transit",
        }
      );
    });

    it("normalizes and publishes exception event for UPS", async () => {
      const rawPayload = {
        trackingNumber: "UPS123",
        status: "EXCEPTION",
      };

      const event = await normalizer.ingestAndPublish("ups", rawPayload);

      expect(event.carrier).toBe("ups");
      expect(event.normalizedStatus).toBe("exception");
      expect(mockStreamManager.publish).toHaveBeenCalledWith(
        "delivery.ups.exception",
        event,
        {
          carrier: "ups",
          trackingNumber: "UPS123",
          status: "exception",
        }
      );
    });

    it("throws error for unsupported carrier", () => {
      expect(() =>
        normalizer.normalize("unknown_carrier" as any, { trackingNumber: "123" })
      ).toThrow("Unsupported carrier: unknown_carrier");
    });

    it("works without streamManager (returns event without publishing)", async () => {
      const standaloneNormalizer = new CarrierWebhookNormalizer();
      const event = await standaloneNormalizer.ingestAndPublish("easypost", {
        tracking_code: "EZ000",
        status: "delivered",
      });
      expect(event.normalizedStatus).toBe("delivered");
    });
  });
});
