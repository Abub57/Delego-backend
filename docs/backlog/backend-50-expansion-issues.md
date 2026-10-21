# Backend Expansion Backlog (50 Issues)

Comprehensive, developer-ready issues for `Delego-backend` (`apps/backend/*`, `agents/*`, and `packages/*`).
**Sizing:** 1–2 developer-days per issue (~75 dev-days total).
**Prerequisites:** All issues include explicit TypeScript interfaces, Zod schemas, database models, or API payloads.

---

## 📋 Table of Contents
1. [Theme 1: AI Agent Framework & Tool Calling Runtime (BE-01 – BE-10)](#theme-1-ai-agent-framework--tool-calling-runtime)
2. [Theme 2: Merchant Portal, Catalog & Fulfillment Microservice (BE-11 – BE-20)](#theme-2-merchant-portal-catalog--fulfillment-microservice)
3. [Theme 3: Stellar & Soroban Advanced Infrastructure (BE-21 – BE-30)](#theme-3-stellar--soroban-advanced-infrastructure)
4. [Theme 4: Real-World Delivery Oracles & Auto-Settlement (BE-31 – BE-40)](#theme-4-real-world-delivery-oracles--auto-settlement)
5. [Theme 5: Enterprise Controls, Security & Observability (BE-41 – BE-50)](#theme-5-enterprise-controls-security--observability)

---

## Theme 1: AI Agent Framework & Tool Calling Runtime

### LLM Provider Client Abstraction (OpenAI / Anthropic / Gemini)
- **Estimate:** 2 days
- **Scope:** `agents/buyer-agent/src/llm/`
- **Context:** Implement a unified LLM interface supporting streaming responses, structured function calling, and provider failover.
- **Data Types:**
```typescript
export type LLMProviderName = "openai" | "anthropic" | "gemini";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface LLMCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: LLMToolDefinition[];
  stream?: boolean;
}

export interface LLMToolCallResponse {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMCompletionResult {
  content: string;
  toolCalls?: LLMToolCallResponse[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}
```
- **Tasks:**
  - [ ] Implement `LLMClient` factory supporting OpenAI SDK, `@anthropic-ai/sdk`, and `@google/genai`
  - [ ] Support JSON schema parameter validation for tools
  - [ ] Add automatic exponential backoff on 429 rate limit responses
- **Acceptance Criteria:**
  - [ ] Unit tests mock LLM responses and verify tool call argument parsing
  - [ ] Provider can be switched via `LLM_PROVIDER` environment variable

---

### Agent Tool Registry & Secure Sandboxed Invoker
- **Estimate:** 2 days
- **Scope:** `agents/buyer-agent/src/tools/`
- **Context:** A type-safe registry where tools are registered with schemas, permission constraints, and execution timeouts.
- **Data Types:**
```typescript
import { z } from "zod";

export interface AgentTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  inputSchema: z.ZodSchema<TInput>;
  requiredPermission: "read_only" | "propose_order" | "execute_payment";
  execute: (input: TInput, context: AgentContext) => Promise<TOutput>;
}

export interface AgentContext {
  userId: string;
  walletAddress: string;
  delegationId?: string;
  spendingLimitRemainingStroops: string;
}
```
- **Tasks:**
  - [ ] Create `ToolRegistry` class with `.register()` and `.execute(name, args, context)`
  - [ ] Enforce execution timeout (max 10 seconds per tool)
  - [ ] Log every tool call and argument to audit database
- **Acceptance Criteria:**
  - [ ] Rejects execution if input parameters fail Zod validation
  - [ ] Throws permission error if agent context lacks required scope

---

### Product Catalog Semantic Vector Search Tool
- **Estimate:** 2 days
- **Scope:** `apps/backend/gateway/src/search/`
- **Context:** Tool enabling the buyer agent to search products via semantic embeddings stored in PostgreSQL `pgvector`.
- **Data Types:**
```typescript
export interface SearchProductsInput {
  query: string;
  category?: string;
  maxPriceStroops?: string;
  preferredAsset?: string;
  minMerchantRating?: number;
  limit?: number; // default 10
}

export interface SearchProductResult {
  productId: string;
  merchantAddress: string;
  merchantName: string;
  title: string;
  description: string;
  priceStroops: string;
  assetCode: string;
  similarityScore: number; // 0.0 - 1.0
  inStock: boolean;
}
```
- **Tasks:**
  - [ ] Embed user query using text embedding model
  - [ ] Perform cosine similarity vector search query against `products.embedding`
  - [ ] Apply SQL filters for price, category, and active inventory
- **Acceptance Criteria:**
  - [ ] Returns top results matching semantic intent within 150ms
  - [ ] Excludes unlisted or out-of-stock products

---

### On-Chain Merchant Reputation & Verification Tool
- **Estimate:** 1 day
- **Scope:** `agents/buyer-agent/src/tools/merchantReputation.ts`
- **Context:** Tool allowing the agent to query the `delego-reputation` and `delego-marketplace` Soroban contracts for merchant reliability before proposing an order.
- **Data Types:**
```typescript
export interface MerchantReputationReport {
  merchantAddress: string;
  isRegisteredOnChain: boolean;
  reputationScore: number; // 0 to 100
  totalCompletedEscrows: number;
  totalDisputesOpened: number;
  disputeRatePercent: number;
  isSuspended: boolean;
}
```
- **Tasks:**
  - [ ] Query Soroban RPC contract storage for merchant address
  - [ ] Calculate dispute percentage from completed vs disputed escrow history
- **Acceptance Criteria:**
  - [ ] Flags merchant as high-risk if dispute rate > 5% or score < 60

---

### Purchase Proposal Generation & Limits Pre-Check Service
- **Estimate:** 2 days
- **Scope:** `apps/backend/orchestrator/src/proposals/`
- **Context:** Service that receives agent order recommendations, validates against user spending limits, and issues a formal purchase proposal.
- **Data Types:**
```typescript
export interface CreateProposalRequest {
  userId: string;
  delegationId: string;
  merchantAddress: string;
  items: { productId: string; title: string; quantity: number; unitPriceStroops: string }[];
  totalAmountStroops: string;
  assetCode: string;
  rationale: string;
}

export interface PurchaseProposalRecord {
  id: string;
  status: "pending_approval" | "auto_approved" | "rejected" | "expired";
  requiresManualApproval: boolean;
  delegationLimitRemainingStroops: string;
  expiresAt: string;
}
```
- **Tasks:**
  - [ ] Check remaining allowance in PostgreSQL delegation record
  - [ ] If amount <= delegation `autoApproveThreshold`, mark as `auto_approved`
  - [ ] If amount > threshold, set `pending_approval` and emit notification event
- **Acceptance Criteria:**
  - [ ] Atomic balance check prevents double-spending across concurrent proposals

---

### Long-Term User Preference Memory in PostgreSQL
- **Estimate:** 1 day
- **Scope:** `agents/buyer-agent/src/memory/`
- **Context:** Store and retrieve learned user preferences (sizes, dietary constraints, preferred brands) with vector similarity search.
- **Data Types:**
```sql
CREATE TABLE user_agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category VARCHAR(32) NOT NULL, -- 'preference', 'constraint', 'address'
  key VARCHAR(64) NOT NULL,
  value TEXT NOT NULL,
  embedding vector(1536),
  confidence REAL DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```
```typescript
export interface UserMemoryItem {
  id: string;
  userId: string;
  category: string;
  key: string;
  value: string;
  confidence: number;
}
```
- **Tasks:**
  - [ ] Database migration adding `user_agent_memories` table with vector index
  - [ ] Method `getRelevantMemories(userId, promptText)` retrieving top 5 memories
- **Acceptance Criteria:**
  - [ ] Memories are injected into system prompt before LLM inference

---

### Prompt Injection Defense & Schema Guardrail Middleware
- **Estimate:** 1 day
- **Scope:** `agents/buyer-agent/src/guardrails/`
- **Context:** Sanitize untrusted merchant descriptions and tool outputs to prevent prompt injections from tampering with agent decisions.
- **Data Types:**
```typescript
export interface GuardrailCheckResult {
  isSafe: boolean;
  flaggedCategories: ("instruction_override" | "exfiltration" | "budget_tampering")[];
  sanitizedText: string;
  riskScore: number; // 0.0 - 1.0
}
```
- **Tasks:**
  - [ ] Regex and heuristic filter for common jailbreak keywords ("ignore previous", "system override")
  - [ ] Strictly validate all tool parameters against Zod before returning to agent
- **Acceptance Criteria:**
  - [ ] Blocks inputs with prompt injection attempts and logs alert to security table

---

### Multi-Turn Conversational Session State Manager
- **Estimate:** 1 day
- **Scope:** `agents/buyer-agent/src/session/`
- **Context:** Manage multi-turn conversation context in Redis with automatic TTL expiration.
- **Data Types:**
```typescript
export interface AgentSessionState {
  sessionId: string;
  userId: string;
  agentId: string;
  messages: LLMMessage[];
  activeProposalId?: string;
  lastActiveAt: number;
  totalTokensConsumed: number;
}
```
- **Tasks:**
  - [ ] Redis session store with 24-hour sliding TTL
  - [ ] Windowing function truncating conversation history when tokens exceed model context limit
- **Acceptance Criteria:**
  - [ ] Preserves system prompt while sliding oldest user/assistant turns

---

### Agent-to-Agent (A2A) Merchant Negotiation Protocol
- **Estimate:** 2 days
- **Scope:** `agents/buyer-agent/src/negotiation/`
- **Context:** Standardized JSON-RPC protocol allowing the buyer agent to negotiate volume discounts with merchant endpoints.
- **Data Types:**
```typescript
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
```
- **Tasks:**
  - [ ] Implement `A2ANegotiator` sending signed HTTP POST offers to merchant API
  - [ ] Cryptographic signature verification of merchant counter-offers
- **Acceptance Criteria:**
  - [ ] Caps negotiation rounds at max 3 turns to prevent infinite loops

---

### Server-Sent Events (SSE) Streaming Agent Response Endpoint
- **Estimate:** 1 day
- **Scope:** `apps/backend/gateway/routes/agentChat.ts`
- **Context:** HTTP endpoint streaming token chunks and tool status events to the frontend via SSE.
- **Data Types:**
```typescript
export type SSEEvent = 
  | { event: "token"; data: { text: string } }
  | { event: "tool_start"; data: { tool: string; input: Record<string, unknown> } }
  | { event: "tool_end"; data: { tool: string; output: Record<string, unknown> } }
  | { event: "proposal"; data: { proposalId: string; orderId: string } }
  | { event: "done"; data: { runId: string } }
  | { event: "error"; data: { message: string } };
```
- **Tasks:**
  - [ ] Implement `POST /api/v1/agents/:agentId/chat` with `text/event-stream` response
  - [ ] Pipe LLM stream generator directly into HTTP response writer
- **Acceptance Criteria:**
  - [ ] Correctly flushes SSE events in `event: ...
data: ...

` format

---

## Theme 2: Merchant Portal, Catalog & Fulfillment Microservice

### Merchant Profile CRUD & Soroban Identity Verification
- **Estimate:** 2 days
- **Scope:** `apps/backend/gateway/src/merchant/`
- **Context:** Endpoints for merchant registration, store management, and on-chain verification check against the marketplace contract.
- **Data Types:**
```sql
CREATE TABLE merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  store_name VARCHAR(128) NOT NULL,
  description TEXT,
  stellar_address VARCHAR(56) UNIQUE NOT NULL,
  contact_email VARCHAR(255) NOT NULL,
  category VARCHAR(64) NOT NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  reputation_score INT DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```
- **Tasks:**
  - [ ] Migration and models for `merchants`
  - [ ] Endpoints: `POST /api/v1/merchants`, `GET /api/v1/merchants/me`, `PUT /api/v1/merchants/me`
- **Acceptance Criteria:**
  - [ ] Validates Stellar address format
  - [ ] Rejects duplicate Stellar address registrations

---

### Product Catalog Database Schema, Indexing & REST Endpoints
- **Estimate:** 2 days
- **Scope:** `apps/backend/gateway/src/catalog/`
- **Context:** Store merchant product listings with full-text and price indexing.
- **Data Types:**
```sql
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  sku VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  price_stroops BIGINT NOT NULL,
  asset_code VARCHAR(12) NOT NULL DEFAULT 'USDC',
  stock_quantity INT NOT NULL DEFAULT 0,
  is_listed BOOLEAN DEFAULT TRUE,
  image_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_products_merchant_sku ON products(merchant_id, sku);
CREATE INDEX idx_products_price ON products(price_stroops) WHERE is_listed = TRUE;
```
- **Tasks:**
  - [ ] Products migration and REST CRUD routes
  - [ ] Pagination (`cursor` and `limit`) for product queries
- **Acceptance Criteria:**
  - [ ] Price must be positive integer (> 0)
  - [ ] Stock must be >= 0

---

### Real-Time Inventory & Stock Reservation Engine
- **Estimate:** 2 days
- **Scope:** `apps/backend/payments/src/inventory/`
- **Context:** Reserve stock when an escrow is proposed and release if escrow is not funded within 15 minutes.
- **Data Types:**
```typescript
export interface StockReservation {
  reservationId: string;
  productId: string;
  quantity: number;
  orderId: string;
  expiresAt: number; // Unix epoch ms
}
```
- **Tasks:**
  - [ ] Atomic Redis Lua script to decrement inventory and create reservation key
  - [ ] Background worker restoring stock on expired reservations
- **Acceptance Criteria:**
  - [ ] Prevents overselling under high concurrency
  - [ ] Automatically frees reservation if escrow payment times out

---

### Merchant Order Ingestion & Escrow Deposit Event Handler
- **Estimate:** 1 day
- **Scope:** `apps/backend/payments/src/handlers/escrowFunded.ts`
- **Context:** Listen to Soroban contract event when an escrow is funded, create the merchant order record, and notify the merchant.
- **Data Types:**
```typescript
export interface EscrowDepositEvent {
  contractId: string;
  escrowId: string;
  orderId: string;
  buyerAddress: string;
  sellerAddress: string;
  amount: string;
  tokenAddress: string;
  timeoutLedger: number;
  ledger: number;
}
```
- **Tasks:**
  - [ ] Ingest `deposit` event from contract event listener
  - [ ] Update internal order status to `"escrow_funded"`
  - [ ] Dispatch webhook to merchant's registered endpoint
- **Acceptance Criteria:**
  - [ ] Idempotent event processing by tracking `(contractId, escrowId, ledger)`

---

### Carrier Shipment Tracking Ingestion & Status Normalizer
- **Estimate:** 2 days
- **Scope:** `apps/backend/payments/src/shipping/`
- **Context:** Ingest merchant-submitted tracking numbers and register tracking webhooks with carrier APIs.
- **Data Types:**
```typescript
export interface RegisterShipmentDTO {
  orderId: string;
  carrier: "fedex" | "ups" | "usps" | "dhl";
  trackingNumber: string;
}

export interface NormalizedTrackingEvent {
  orderId: string;
  status: "label_created" | "in_transit" | "out_for_delivery" | "delivered" | "exception";
  locationCity?: string;
  locationState?: string;
  timestamp: string;
  rawDetails: string;
}
```
- **Tasks:**
  - [ ] Endpoint `POST /api/v1/merchant/orders/:orderId/shipment`
  - [ ] Register tracking number with EasyPost / carrier webhook API
- **Acceptance Criteria:**
  - [ ] Rejects malformed carrier tracking codes

---

### Automated Merchant Payout Calculator & Settlement Scheduler
- **Estimate:** 2 days
- **Scope:** `apps/backend/payments/src/payouts/`
- **Context:** Calculate platform commission fee (e.g. 1%) and schedule Soroban escrow release call upon delivery.
- **Data Types:**
```typescript
export interface PayoutCalculation {
  escrowId: string;
  grossAmountStroops: bigint;
  platformFeeStroops: bigint; // e.g. 1%
  netMerchantPayoutStroops: bigint;
  merchantAddress: string;
}
```
- **Tasks:**
  - [ ] Calculate net payout subtracting contract commission
  - [ ] Submit signed contract `release()` transaction via Wallet Service
- **Acceptance Criteria:**
  - [ ] Rounding errors favor merchant (never overcharge fee)
  - [ ] Logs payout ledger transaction hash in `merchant_payouts` table

---

### Public Storefront Catalog Search API with Cursor Pagination
- **Estimate:** 1 day
- **Scope:** `apps/backend/gateway/routes/storefront.ts`
- **Context:** High-throughput public REST API allowing buyers and agents to browse a merchant's inventory.
- **Data Types:**
```typescript
export interface StorefrontQueryParams {
  cursor?: string;
  limit?: number; // 1-50, default 20
  category?: string;
  minPrice?: string;
  maxPrice?: string;
  sort?: "price_asc" | "price_desc" | "newest";
}

export interface PaginatedProductsResponse {
  items: MerchantProductDTO[];
  nextCursor: string | null;
  totalCount: number;
}
```
- **Tasks:**
  - [ ] Route `GET /api/v1/merchants/:merchantId/products`
  - [ ] Base64 cursor encoding for `(created_at, id)` deterministic pagination
- **Acceptance Criteria:**
  - [ ] Response cached in Redis for 60 seconds with cache invalidation on product update

---

### Merchant Webhook Dispatcher with HMAC Signature & Retries
- **Estimate:** 2 days
- **Scope:** `apps/backend/notifications/src/webhooks/`
- **Context:** Deliver order and escrow lifecycle events to merchants with HMAC-SHA256 signatures and exponential backoff retries.
- **Data Types:**
```typescript
export interface WebhookPayload<T = unknown> {
  id: string; // event id
  event: "order.created" | "escrow.funded" | "escrow.released" | "dispute.opened";
  timestamp: string;
  data: T;
}
```
- **Tasks:**
  - [ ] BullMQ queue `merchant-webhooks`
  - [ ] Sign payload with merchant secret key and pass in `X-Delego-Signature` header
  - [ ] Retry up to 5 times (1m, 5m, 30m, 2h, 24h) before moving to DLQ
- **Acceptance Criteria:**
  - [ ] Merchant can verify signature using standard HMAC-SHA256 algorithm

---

### Merchant Dispute Response & Counter-Evidence Submission Endpoints
- **Estimate:** 1 day
- **Scope:** `apps/backend/gateway/routes/disputes.ts`
- **Context:** Endpoints for merchants to submit responses, carrier delivery receipts, and optional partial refund counter-offers.
- **Data Types:**
```typescript
export interface SubmitDisputeResponseDTO {
  disputeId: string;
  responseStatement: string;
  evidenceAttachmentUrls?: string[];
  partialRefundAmountStroops?: string;
}
```
- **Tasks:**
  - [ ] Endpoint `POST /api/v1/merchant/disputes/:disputeId/response`
  - [ ] Validate that caller is the merchant linked to the disputed escrow
- **Acceptance Criteria:**
  - [ ] Sets dispute state to `"merchant_responded"` and notifies buyer

---

### Secure S3/R2 Pre-Signed URL Generator for Media & Evidence
- **Estimate:** 1 day
- **Scope:** `apps/backend/gateway/src/storage/`
- **Context:** Generate short-lived pre-signed URLs for uploading product photos and dispute evidence directly to Cloudflare R2 / AWS S3.
- **Data Types:**
```typescript
export interface PresignedUrlRequest {
  filename: string;
  contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  fileSizeBytes: number;
  purpose: "product_image" | "dispute_evidence";
}

export interface PresignedUrlResponse {
  uploadUrl: string;
  publicUrl: string;
  expiresInSeconds: number;
}
```
- **Tasks:**
  - [ ] Implement AWS S3 SDK `@aws-sdk/s3-request-presigner`
  - [ ] Enforce max 10MB limit and MIME type restriction in pre-signed policy
- **Acceptance Criteria:**
  - [ ] Pre-signed URL expires after 15 minutes

---

## Theme 3: Stellar & Soroban Advanced Infrastructure

### Passkey / WebAuthn Signature Verification & Account Linker (SEP-0030)
- **Estimate:** 2 days
- **Scope:** `apps/backend/wallet/src/passkeys/`
- **Context:** Validate WebAuthn client signatures on the backend and map passkeys to user Stellar accounts.
- **Data Types:**
```typescript
export interface WebAuthnVerificationPayload {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  challenge: string;
}

export interface PasskeyAccountMapping {
  userId: string;
  stellarAddress: string;
  credentialId: string;
  publicKeyDer: string;
}
```
- **Tasks:**
  - [ ] Verify signature using `@simplewebauthn/server`
  - [ ] Generate challenge with 5-minute Redis expiration
- **Acceptance Criteria:**
  - [ ] Replay attacks prevented by single-use challenge consumption

---

### Bounded Session Key Delegation Signer Service
- **Estimate:** 2 days
- **Scope:** `apps/backend/wallet/src/sessionKeys/`
- **Context:** Securely store encrypted temporary agent session keys in Vault, signing contract calls within defined policy boundaries.
- **Data Types:**
```typescript
export interface SignWithSessionKeyDTO {
  sessionPublicKey: string;
  contractCallXdr: string;
  requestedAmountStroops: string;
}
```
- **Tasks:**
  - [ ] Validate that session key has not expired
  - [ ] Verify cumulative spent amount does not exceed session spending limit
  - [ ] Sign transaction with session private key stored in HashiCorp Vault
- **Acceptance Criteria:**
  - [ ] Immediately denies signature if requested amount exceeds remaining cap

---

### Stellar Path Payment Quote & Route Discovery Engine
- **Estimate:** 2 days
- **Scope:** `apps/backend/wallet/src/pathPayments/`
- **Context:** Discover the cheapest payment path via Horizon order books to convert source assets (e.g. XLM) into destination escrow assets (e.g. USDC).
- **Data Types:**
```typescript
export interface PathPaymentQuoteRequest {
  sourceAsset: string;
  destinationAsset: string;
  destinationAmount: string;
  sourceAccount: string;
}

export interface PathPaymentQuoteResponse {
  sourceAsset: string;
  sourceAmountMax: string;
  destinationAsset: string;
  destinationAmount: string;
  path: { assetCode: string; issuer?: string }[];
  priceImpactPercent: number;
}
```
- **Tasks:**
  - [ ] Call Horizon `strict-receive-paths` endpoint
  - [ ] Add 0.5% buffer for `sourceAmountMax` to account for market movement
- **Acceptance Criteria:**
  - [ ] Rejects quotes if price impact exceeds 2.5%

---

### Blend Protocol Soroban Yield Pool Lending Coordinator
- **Estimate:** 2 days
- **Scope:** `apps/backend/payments/src/yield/`
- **Context:** Coordinate depositing locked escrow funds into Blend Protocol lending pools and withdrawing principal + yield on release.
- **Data Types:**
```typescript
export interface BlendSupplyPosition {
  escrowId: string;
  poolContractId: string;
  assetAddress: string;
  depositedAmountStroops: string;
  bTokenAmount: string;
  supplyLedger: number;
}
```
- **Tasks:**
  - [ ] Construct Soroban invocation to deposit USDC into Blend pool
  - [ ] Construct withdrawal invocation during escrow release
- **Acceptance Criteria:**
  - [ ] Records accrued interest separately in database for accounting

---

### Real-Time Soroban Contract Event Ingestion Worker
- **Estimate:** 2 days
- **Scope:** `apps/backend/cdc/src/sorobanEvents/`
- **Context:** Continuous background poller streaming contract events (`deposit`, `release`, `dispute`, `refund`) from Soroban RPC.
- **Data Types:**
```typescript
export interface ContractEventCursor {
  contractId: string;
  lastLedgerSequence: number;
  cursorToken?: string;
}

export interface NormalizedContractEvent {
  contractId: string;
  topic: string;
  data: Record<string, unknown>;
  ledger: number;
  txHash: string;
  timestamp: string;
}
```
- **Tasks:**
  - [ ] Query Soroban RPC `getEvents` with paging
  - [ ] Store event stream cursor in Redis to guarantee at-least-once ingestion
  - [ ] Publish normalized events to Redis Stream `soroban:events`
- **Acceptance Criteria:**
  - [ ] Resumes from saved cursor without reprocessing past ledgers upon restart

---

### Automated Testnet Contract Deployer & Friendbot Faucet Relayer
- **Estimate:** 1 day
- **Scope:** `apps/backend/wallet/src/faucet/`
- **Context:** Microservice relaying Friendbot testnet requests and funding user testnet accounts with mock USDC tokens.
- **Data Types:**
```typescript
export interface FaucetRelayRequest {
  destinationAddress: string;
  mintMockUsdc?: boolean;
}

export interface FaucetRelayResult {
  success: boolean;
  xlmFunded: string;
  usdcFunded?: string;
  txHash: string;
}
```
- **Tasks:**
  - [ ] Call Stellar Friendbot URL
  - [ ] If `mintMockUsdc` requested, execute mint transaction from faucet issuer key
- **Acceptance Criteria:**
  - [ ] Rate limits faucet requests to 1 per IP/address per hour

---

### Dynamic Horizon Fee Estimator Optimization with Adaptive TTL Caching
- **Estimate:** 1 day
- **Scope:** `apps/backend/wallet/src/feeEstimator/`
- **Context:** Optimize `feeEstimator.ts` to adjust cache TTL dynamically based on Stellar ledger congestion (lower TTL when congestion spikes).
- **Data Types:**
```typescript
export interface AdaptiveFeeConfig {
  minTtlSeconds: number; // 5s during congestion
  maxTtlSeconds: number; // 60s during calm
  congestionThresholdPercentile: number; // e.g. p95 > 500 stroops
}
```
- **Tasks:**
  - [ ] Inspect fee delta between p50 and p99
  - [ ] Shorten Redis TTL to 5 seconds if network is surging
- **Acceptance Criteria:**
  - [ ] Prevents fee cache staleness during sudden network fee spikes

---

### BullMQ Stellar Transaction Queue Auto-Healing & Resubmission
- **Estimate:** 2 days
- **Scope:** `apps/backend/wallet/src/queue/healer.ts`
- **Context:** Detect transactions stuck in "pending" due to bad sequence numbers or network drops and resubmit with incremented sequence.
- **Data Types:**
```typescript
export interface StuckTxCandidate {
  jobId: string;
  sourceAddress: string;
  expectedSequence: string;
  submittedAt: number;
  retryCount: number;
}
```
- **Tasks:**
  - [ ] Background worker checking for transactions unconfirmed after 90 seconds
  - [ ] Query Horizon account sequence number and re-sign with fresh sequence
- **Acceptance Criteria:**
  - [ ] Resolves sequence gaps automatically without manual database intervention

---

### Multi-Sig Dual-Control Co-Signing Coordination Service
- **Estimate:** 2 days
- **Scope:** `apps/backend/wallet/src/multisig/`
- **Context:** Coordinate collecting signatures from multiple authorized team members before submitting transaction to Stellar.
- **Data Types:**
```typescript
export interface MultiSigSession {
  sessionId: string;
  orderId: string;
  transactionXdr: string;
  requiredThreshold: number;
  collectedSignatures: { signerAddress: string; signatureBase64: string }[];
  status: "collecting" | "ready" | "submitted" | "expired";
}
```
- **Tasks:**
  - [ ] Combine signatures into unified Stellar transaction envelope via SDK
  - [ ] Submit to network once threshold is satisfied
- **Acceptance Criteria:**
  - [ ] Validates each partial signature against signer public key

---

### Soroban Contract State Snapshot Archiver & Ledger Pruner
- **Estimate:** 1 day
- **Scope:** `apps/backend/cdc/src/archiver/`
- **Context:** Archive expired escrow and inactive delegation states from active database tables into cold storage.
- **Data Types:**
```sql
CREATE TABLE escrow_archives (
  id UUID PRIMARY KEY,
  escrow_id VARCHAR(64) NOT NULL,
  final_status VARCHAR(32) NOT NULL,
  settled_at TIMESTAMPTZ NOT NULL,
  archive_payload JSONB NOT NULL
);
```
- **Tasks:**
  - [ ] Nightly cron job moving escrows closed > 90 days ago into `escrow_archives`
  - [ ] Keeps primary `escrows` table compact and index lookups fast
- **Acceptance Criteria:**
  - [ ] Preserves full audit history in compressed archive table

---

## Theme 4: Real-World Delivery Oracles & Auto-Settlement

### Carrier Tracking Webhook Receiver (EasyPost / FedEx / UPS)
- **Estimate:** 2 days
- **Scope:** `apps/backend/payments/src/webhooks/carrierWebhook.ts`
- **Context:** Ingest carrier tracking updates, verify webhook signatures, and push normalized events to processing queue.
- **Data Types:**
```typescript
export interface EasyPostTrackingWebhook {
  id: string;
  description: "tracker.updated";
  result: {
    tracking_code: string;
    status: "pre_transit" | "in_transit" | "out_for_delivery" | "delivered" | "return_to_sender" | "failure";
    status_detail: string;
    carrier: string;
    est_delivery_date: string;
    tracking_details: { status: string; message: string; datetime: string; source: string }[];
  };
}
```
- **Tasks:**
  - [ ] Route `POST /api/v1/webhooks/carriers/easypost`
  - [ ] Verify HMAC webhook signature
- **Acceptance Criteria:**
  - [ ] Responds with HTTP 200 within 500ms and processes payload asynchronously in BullMQ

---

### Carrier Tracking Event Normalizer & State Machine
- **Estimate:** 1 day
- **Scope:** `apps/backend/payments/src/shipping/normalizer.ts`
- **Context:** Convert provider-specific carrier payloads (FedEx, UPS, DHL, EasyPost) into a canonical delivery state enum.
- **Data Types:**
```typescript
export type CanonicalDeliveryState = "label_created" | "in_transit" | "out_for_delivery" | "delivered" | "exception";

export interface NormalizedTrackingPayload {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  state: CanonicalDeliveryState;
  deliveredTimestamp?: string;
  location?: string;
}
```
- **Tasks:**
  - [ ] Map provider status strings to canonical enum
  - [ ] Trigger orchestrator workflow step on state change
- **Acceptance Criteria:**
  - [ ] Unmapped carrier statuses fall back to `"in_transit"` without throwing

---

### Cryptographic Delivery Receipt Signer (Oracle Key)
- **Estimate:** 1 day
- **Scope:** `apps/backend/payments/src/oracle/signer.ts`
- **Context:** Sign delivery receipts with the authorized Delego Oracle Ed25519 key for Soroban contract verification.
- **Data Types:**
```typescript
export interface DeliveryReceipt {
  escrowId: string;
  orderId: string;
  carrier: string;
  trackingNumber: string;
  deliveredAtTimestamp: number;
}

export interface SignedDeliveryProof {
  receipt: DeliveryReceipt;
  oraclePublicKey: string;
  signatureBase64: string;
}
```
- **Tasks:**
  - [ ] Encode `DeliveryReceipt` as deterministic canonical JSON
  - [ ] Sign with oracle private key loaded from Vault
- **Acceptance Criteria:**
  - [ ] Signature can be verified on-chain via Soroban Ed25519 crypto verify function

---

### Auto-Release Escrow Soroban Trigger Worker
- **Estimate:** 2 days
- **Scope:** `apps/backend/payments/src/workers/autoRelease.ts`
- **Context:** When a verified delivery event arrives and grace window lapses, submit Soroban `release()` transaction automatically.
- **Data Types:**
```typescript
export interface AutoReleaseJobData {
  escrowId: string;
  orderId: string;
  signedProof: SignedDeliveryProof;
  graceExpiresAt: number;
}
```
- **Tasks:**
  - [ ] Enqueue delayed BullMQ job scheduled for `graceExpiresAt`
  - [ ] On job run, check if user filed a dispute during grace window
  - [ ] If no dispute, call contract release
- **Acceptance Criteria:**
  - [ ] Immediately aborts release if dispute flag is active

---

### Shipping Exception & Lost Package Detector
- **Estimate:** 1 day
- **Scope:** `apps/backend/payments/src/shipping/exceptionDetector.ts`
- **Context:** Detect packages stuck in transit > 10 business days past estimated delivery and notify buyer to initiate inquiry.
- **Data Types:**
```typescript
export interface ShippingAnomalyRecord {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  daysInTransit: number;
  lastUpdateTimestamp: string;
  flagReason: "stalled_transit" | "return_to_sender" | "delivery_failed";
}
```
- **Tasks:**
  - [ ] Daily scan for shipped orders without movement for > 7 days
  - [ ] Emit notification event alerting buyer and merchant
- **Acceptance Criteria:**
  - [ ] Creates high-priority notification in buyer dashboard

---

### Automated Dispute Mediation & Rule-Based Arbitration Engine
- **Estimate:** 2 days
- **Scope:** `apps/backend/payments/src/disputes/mediator.ts`
- **Context:** Rule engine settling straightforward disputes (e.g. tracking confirms delivery was returned to sender $	o$ refund buyer).
- **Data Types:**
```typescript
export interface DisputeMediationDecision {
  disputeId: string;
  verdict: "refund_buyer" | "payout_merchant" | "escalate_human";
  confidence: number; // 0.0 - 1.0
  reasoning: string;
}
```
- **Tasks:**
  - [ ] Evaluate carrier tracking: if status == `"return_to_sender"`, auto-refund
  - [ ] If merchant accepted partial refund, execute split release
- **Acceptance Criteria:**
  - [ ] Escalates to human arbitration if evidence is ambiguous

---

### Timeout Refund Worker for Stalled Escrows
- **Estimate:** 1 day
- **Scope:** `apps/backend/payments/src/workers/timeoutRefund.ts`
- **Context:** Scheduled worker monitoring escrows that exceeded their `timeoutLedger` and executing the contract refund on behalf of the buyer.
- **Data Types:**
```typescript
export interface ExpiredEscrowCheck {
  escrowId: string;
  orderId: string;
  buyerAddress: string;
  timeoutLedger: number;
  currentLedger: number;
}
```
- **Tasks:**
  - [ ] Query escrows where `currentLedger >= timeoutLedger` and status == `"Funded"`
  - [ ] Submit Soroban `refund()` transaction
- **Acceptance Criteria:**
  - [ ] Only triggers if escrow is not disputed or released

---

### Proof of Delivery Hash Anchor in Soroban Contract
- **Estimate:** 2 days
- **Scope:** `apps/backend/payments/src/oracle/anchor.ts`
- **Context:** Hash the tracking number and carrier receipt and anchor it as contract memo storage during release.
- **Data Types:**
```typescript
export interface OnChainProofAnchor {
  escrowId: string;
  proofHashSha256: string; // 32-byte hex hash
  carrierCode: string;
}
```
- **Tasks:**
  - [ ] Compute SHA-256 of receipt data
  - [ ] Pass proof hash as argument to Soroban `release_with_proof()` method
- **Acceptance Criteria:**
  - [ ] Hash is permanently verifiable on Stellar ledger

---

### Delivery Oracle Health Check & Heartbeat Monitor
- **Estimate:** 1 day
- **Scope:** `apps/backend/monitoring/src/oracleHealth.ts`
- **Context:** Synthetic check verifying carrier API response times, webhook listener latency, and oracle key validity.
- **Data Types:**
```typescript
export interface OracleHealthReport {
  isOperational: boolean;
  carrierApiLatencyMs: number;
  lastWebhookReceivedAt: string;
  pendingDeliveriesCount: number;
  signingKeyValidUntil: string;
}
```
- **Tasks:**
  - [ ] Expose endpoint `GET /health/oracle`
  - [ ] Alert if no webhooks received for > 6 hours during business hours
- **Acceptance Criteria:**
  - [ ] Returns 503 if signing key is expired or carrier API is unreachable

---

### SMS & WhatsApp Delivery Notification Dispatcher (Twilio)
- **Estimate:** 1 day
- **Scope:** `apps/backend/notifications/src/sms/`
- **Context:** Send SMS / WhatsApp updates when a package is out for delivery or an escrow is nearing auto-release.
- **Data Types:**
```typescript
export interface SmsNotificationPayload {
  toPhoneNumber: string;
  messageType: "out_for_delivery" | "auto_release_warning" | "refund_processed";
  orderId: string;
  trackingNumber: string;
}
```
- **Tasks:**
  - [ ] Twilio SDK client integration
  - [ ] Template renderer with localized language support
- **Acceptance Criteria:**
  - [ ] Respects user quiet hours and notification preferences

---

## Theme 5: Enterprise Controls, Security & Observability

### Hierarchical Multi-Level Budget & Category Policy Evaluator
- **Estimate:** 2 days
- **Scope:** `apps/backend/orchestrator/src/policies/evaluator.ts`
- **Context:** Evaluate complex spending policies (e.g. Category cap + Daily cap + Merchant allowlist) in single atomic evaluation.
- **Data Types:**
```typescript
export interface PolicyEvaluationContext {
  userId: string;
  merchantAddress: string;
  category: string;
  orderAmountStroops: bigint;
  timestamp: Date;
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  violatedRules: string[];
  requiresDualApproval: boolean;
  applicableDailyAllowanceRemainingStroops: bigint;
}
```
- **Tasks:**
  - [ ] Evaluate delegation limits against rolling daily, weekly, and category spend
  - [ ] Return structured verdict with clear violation explanations
- **Acceptance Criteria:**
  - [ ] Rejects order if any individual category or global wallet limit is breached

---

### Transaction Risk Scoring & Fraud Detection Pipeline
- **Estimate:** 2 days
- **Scope:** `apps/backend/fraud-detection/src/scoring/`
- **Context:** Score each order transaction for fraud indicators (new merchant, velocity spike, unusual order amount).
- **Data Types:**
```typescript
export interface FraudEvaluationRequest {
  orderId: string;
  userId: string;
  merchantAddress: string;
  amountStroops: string;
  ipAddress: string;
  deviceFingerprint?: string;
}

export interface FraudEvaluationScore {
  riskScore: number; // 0 to 100
  recommendation: "allow" | "challenge" | "block";
  riskFactors: string[];
}
```
- **Tasks:**
  - [ ] Check transaction velocity (orders per hour)
  - [ ] Check merchant age and reputation score
- **Acceptance Criteria:**
  - [ ] High risk (score > 80) blocks execution and alerts user

---

### Multi-Party Dual-Control Quorum Enforcement Service
- **Estimate:** 2 days
- **Scope:** `apps/backend/orchestrator/src/dualControl/`
- **Context:** Manage quorum approvals for enterprise team accounts requiring M-of-N signatures.
- **Data Types:**
```sql
CREATE TABLE dual_control_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  required_signatures INT NOT NULL DEFAULT 2,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE dual_control_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL REFERENCES dual_control_approvals(id),
  signer_user_id UUID NOT NULL REFERENCES users(id),
  signed_at TIMESTAMPTZ DEFAULT NOW(),
  signature_note TEXT
);
```
- **Tasks:**
  - [ ] Database migration and service logic
  - [ ] Enforce rule: `created_by_user_id` cannot sign their own proposal
- **Acceptance Criteria:**
  - [ ] Transitions order to `"approved"` only once quorum count is met

---

### Emergency Kill-Switch Broadcast Service
- **Estimate:** 1 day
- **Scope:** `apps/backend/wallet/src/killswitch/`
- **Context:** Broadcast on-chain revocations of all session keys and invalidate active Redis auth tokens immediately.
- **Data Types:**
```typescript
export interface EmergencyRevocationDTO {
  walletAddress: string;
  adminSecretToken?: string;
  revokeOnChain: boolean;
}
```
- **Tasks:**
  - [ ] Flush all active user sessions from Redis
  - [ ] Batch submit permission revocations to `delego-permissions` contract
- **Acceptance Criteria:**
  - [ ] Cancels all pending agent proposals within 1 second

---

### Recurring Subscription Scheduler & Smart Purchase Trigger
- **Estimate:** 2 days
- **Scope:** `apps/backend/orchestrator/src/subscriptions/`
- **Context:** Automated cron scheduler that triggers buyer agents to execute recurring purchases on set intervals.
- **Data Types:**
```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  item_sku VARCHAR(64) NOT NULL,
  interval_days INT NOT NULL,
  max_price_stroops BIGINT NOT NULL,
  last_executed_at TIMESTAMPTZ,
  next_execution_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active'
);
```
- **Tasks:**
  - [ ] Scheduled BullMQ repeatable worker checking `next_execution_at <= NOW()`
  - [ ] Triggers buyer agent to verify stock and price before placing order
- **Acceptance Criteria:**
  - [ ] Skips execution and notifies user if merchant price has risen above `max_price_stroops`

---

### High-Throughput Spend Metrics Aggregation Pipeline
- **Estimate:** 1 day
- **Scope:** `apps/backend/analytics/src/metrics/aggregator.ts`
- **Context:** Scheduled worker aggregating completed escrows into daily and monthly summary tables for fast dashboard queries.
- **Data Types:**
```sql
CREATE TABLE daily_spend_metrics (
  date DATE NOT NULL,
  user_id UUID NOT NULL,
  category VARCHAR(64) NOT NULL,
  total_spent_stroops BIGINT NOT NULL DEFAULT 0,
  orders_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (date, user_id, category)
);
```
- **Tasks:**
  - [ ] Aggregation query executing every hour
  - [ ] Fast endpoint `GET /api/v1/analytics/spend-summary` querying summary table
- **Acceptance Criteria:**
  - [ ] Reduces dashboard chart query times from > 1s to < 20ms

---

### Distributed Tracing with OpenTelemetry Across Microservices
- **Estimate:** 2 days
- **Scope:** `packages/utils/src/telemetry/`
- **Context:** Instrument HTTP clients and Redis event handlers with OpenTelemetry traces across Gateway, Orchestrator, and Wallet.
- **Data Types:**
```typescript
export interface TracingSpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: number;
}
```
- **Tasks:**
  - [ ] Inject `traceparent` header into outgoing HTTP requests and Redis pub/sub messages
  - [ ] Export spans to OpenTelemetry collector / Jaeger
- **Acceptance Criteria:**
  - [ ] End-to-end trace connects Gateway request through Orchestrator to Wallet on-chain submission

---

### Cryptographic Tamper-Evident Audit Log Chaining
- **Estimate:** 1 day
- **Scope:** `apps/backend/gateway/src/audit/hasher.ts`
- **Context:** Cryptographically link audit log entries via SHA-256 previous-hash pointer (blockchain-style log chain).
- **Data Types:**
```sql
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  sequence_number BIGINT NOT NULL UNIQUE,
  event_type VARCHAR(64) NOT NULL,
  actor_address VARCHAR(56) NOT NULL,
  payload JSONB NOT NULL,
  prev_hash VARCHAR(64) NOT NULL,
  current_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```
- **Tasks:**
  - [ ] Compute `current_hash = SHA256(prev_hash + sequence + event_type + payload)`
  - [ ] Verification script detecting if any historical audit row was altered
- **Acceptance Criteria:**
  - [ ] Verification script fails if any database row is modified out-of-band

---

### Tenant & Tier-Based Redis Rate Limiter with Burst Allowances
- **Estimate:** 1 day
- **Scope:** `apps/backend/gateway/src/rateLimit/`
- **Context:** Implement tiered rate limits (Free: 60 req/min, Merchant: 300 req/min, Enterprise: 1200 req/min) with Redis sliding window.
- **Data Types:**
```typescript
export interface RateLimitTier {
  name: "free" | "merchant" | "enterprise";
  requestsPerMinute: number;
  burstAllowance: number;
}
```
- **Tasks:**
  - [ ] Redis sliding window rate limiter middleware
  - [ ] Returns `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `Retry-After` headers
- **Acceptance Criteria:**
  - [ ] Returns HTTP 429 when quota is exceeded with exact `Retry-After` seconds

---

### Dead Letter Queue (DLQ) Auto-Replay & Remediation Worker
- **Estimate:** 2 days
- **Scope:** `apps/backend/orchestrator/src/dlq/`
- **Context:** Service that monitors failed BullMQ jobs (e.g. temporary network partitions) and safely replays them after circuit breaker resets.
- **Data Types:**
```typescript
export interface DeadLetterJobRecord {
  jobId: string;
  queueName: string;
  failedReason: string;
  attemptsMade: number;
  payload: Record<string, unknown>;
  failedAt: string;
}
```
- **Tasks:**
  - [ ] Endpoint `POST /api/v1/admin/dlq/replay` and auto-replay cron for recoverable network errors
  - [ ] Circuit breaker preventing retry storm if target service is down
- **Acceptance Criteria:**
  - [ ] Successfully re-enqueues jobs without duplicating completed transaction side-effects
