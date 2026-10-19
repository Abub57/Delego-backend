/**
 * Low-stock alert contract shared by the orchestrator (producer, during
 * inventory decrement) and the notifications service (consumer: webhook +
 * transactional email).
 */

export interface LowStockAlertPayload {
  merchantId: string;
  productId: string;
  sku: string;
  title: string;
  currentStock: number;
  threshold: number;
  triggeredAt: string;
}

/** Outbound webhook event type for low-stock alerts. */
export const LOW_STOCK_WEBHOOK_EVENT = "inventory.low_stock" as const;

/** BullMQ queue carrying low-stock work (BullMQ forbids ":" in queue names). */
export const LOW_STOCK_QUEUE_NAME = "merchant-inventory-low-stock";

/** Job names on {@link LOW_STOCK_QUEUE_NAME}. */
export const LOW_STOCK_JOB = {
  dispatchWebhook: "dispatch-webhook",
  sendEmail: "send-email",
} as const;

export type LowStockJobName = (typeof LOW_STOCK_JOB)[keyof typeof LOW_STOCK_JOB];
