/**
 * Inventory management and real-time stock update types.
 * Issue: Redis pub/sub to WebSocket bridge for stock updates.
 */

/**
 * Real-time stock update message broadcast to storefront clients
 * via WebSocket when inventory levels change.
 */
export interface StockDepletionBroadcastMessage {
  type: "inventory.stock_updated";
  productId: string;
  merchantId: string;
  newStockCount: number;
  isAvailable: boolean;
  timestamp: string;
}

/**
 * Redis pub/sub channel for inventory updates.
 * Pattern: storefront:inventory:updates
 */
export const INVENTORY_PUBSUB_CHANNEL = "storefront:inventory:updates";

/**
 * Product-specific room pattern for WebSocket subscriptions.
 * Pattern: product:{merchantId}:{productId}
 */
export function getProductRoomId(merchantId: string, productId: string): string {
  return `product:${merchantId}:${productId}`;
}
