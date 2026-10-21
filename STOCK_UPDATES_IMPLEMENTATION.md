# Stock Updates WebSocket Implementation - 1% Complete

## Overview
This is the initial foundation (1%) for implementing a Redis pub/sub to WebSocket bridge that broadcasts real-time stock updates to storefront clients.

## What Was Implemented

### 1. Type Definitions (packages/types/src/inventory.ts)
Created a new inventory types module with:

- **`StockDepletionBroadcastMessage` interface**: Defines the structure of real-time stock update messages sent to WebSocket clients
  ```typescript
  interface StockDepletionBroadcastMessage {
    type: "inventory.stock_updated";
    productId: string;
    merchantId: string;
    newStockCount: number;
    isAvailable: boolean;
    timestamp: string;
  }
  ```

- **`INVENTORY_PUBSUB_CHANNEL` constant**: Redis pub/sub channel name for inventory updates
  - Value: `"storefront:inventory:updates"`

- **`getProductRoomId()` helper function**: Creates product-specific room identifiers for WebSocket subscriptions
  - Pattern: `product:{merchantId}:{productId}`

### 2. Bug Fixes
Fixed pre-existing TypeScript errors:
- Corrected `totalStroops` type from `bigint` to `string` in test files
- Fixed `unitPriceStroops` type in integration fixtures

## Git Branch
- Branch: `feature/stock-updates-websocket`
- Pushed to: https://github.com/coderolisa/Delego-backend.git
- Commits: 3

## Next Steps (Remaining 99%)

### Phase 1: Redis Publisher Integration
- Hook inventory deduction events in `InventoryReservationService`
- Publish stock change messages to Redis pub/sub channel
- Use existing `RedisPublisher` class with retry logic

### Phase 2: WebSocket Bridge Service
- Create subscriber that listens to `storefront:inventory:updates` channel
- Maintain WebSocket connections using existing patterns from:
  - `apps/backend/notifications/src/websocket.ts` (JWT auth, heartbeat)
  - `apps/backend/wallet/src/websocket/server.ts` (connection registry)
- Implement product room subscriptions
- Broadcast messages to subscribed clients

### Phase 3: WebSocket Endpoint
- Create `/ws/products/:productId` endpoint or similar
- Implement JWT authentication
- Add connection tracking per product room
- Handle reconnection and state synchronization

### Phase 4: Integration & Testing
- Add integration tests verifying <100ms delivery
- Test disconnection/reconnection scenarios
- Load test with multiple concurrent connections
- Add monitoring and metrics

## Project Context
The codebase already has excellent infrastructure:
- Redis pub/sub patterns (CDC broker, notifications)
- WebSocket implementations (wallet, notifications services)
- Connection pooling and resilience (exponential backoff, buffers)
- Inventory management with distributed locks

## How to Continue Development
1. Start with Phase 1: Modify `apps/backend/orchestrator/src/inventory/reservation.ts`
2. Import and use the new types from `@delegolabs/types`
3. Follow existing patterns in `apps/backend/cdc/src/broker.ts` for dual Redis publish
4. Reuse WebSocket infrastructure from notifications service
