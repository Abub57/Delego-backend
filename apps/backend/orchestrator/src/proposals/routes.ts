/**
 * Proposal routes — Issue #265
 * POST /proposals        — create a proposal
 * GET  /proposals/:id    — fetch a proposal
 * POST /proposals/check  — pre-flight limit check (no state change)
 */
import { createLogger, json, route } from "@delegolabs/utils";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { z } from "zod";
import { ProposalService } from "./service.js";
import {
  DelegationLimitExceededError,
  ConcurrentProposalConflictError,
} from "./types.js";

const log = createLogger(
  "orchestrator:proposals:routes",
  process.env.LOG_LEVEL ?? "info"
);

const ProposalItemSchema = z.object({
  productId: z.string().min(1),
  title: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceStroops: z.string().regex(/^\d+$/),
});

const CreateProposalSchema = z.object({
  userId: z.string().uuid(),
  delegationId: z.string().uuid(),
  merchantAddress: z.string().min(1),
  items: z.array(ProposalItemSchema).min(1),
  totalAmountStroops: z.string().regex(/^\d+$/),
  assetCode: z.string().min(1).max(12),
  rationale: z.string().min(1),
});

const CheckLimitSchema = z.object({
  userId: z.string().uuid(),
  delegationId: z.string().uuid(),
  amountStroops: z.string().regex(/^\d+$/),
});

export function createProposalRoutes(db: Pool) {
  const service = new ProposalService(db);

  return [
    route("POST", "/proposals", async (req: IncomingMessage, res: ServerResponse) => {
      let body: unknown;
      try {
        body = await (req as any).json();
      } catch {
        return json(res, 400, { error: "Invalid JSON body" });
      }

      const parsed = CreateProposalSchema.safeParse(body);
      if (!parsed.success) {
        return json(res, 400, { error: "Validation failed", details: parsed.error.flatten() });
      }

      try {
        const proposal = await service.createProposal(parsed.data);
        return json(res, 201, proposal);
      } catch (err) {
        if (err instanceof DelegationLimitExceededError) {
          return json(res, 422, { error: err.message, code: "DELEGATION_LIMIT_EXCEEDED" });
        }
        if (err instanceof ConcurrentProposalConflictError) {
          return json(res, 409, { error: err.message, code: "CONCURRENT_CONFLICT" });
        }
        log.error("Unexpected error creating proposal", {
          error: err instanceof Error ? err.message : String(err),
        });
        return json(res, 500, { error: "Internal server error" });
      }
    }),

    route("POST", "/proposals/check", async (req: IncomingMessage, res: ServerResponse) => {
      let body: unknown;
      try {
        body = await (req as any).json();
      } catch {
        return json(res, 400, { error: "Invalid JSON body" });
      }

      const parsed = CheckLimitSchema.safeParse(body);
      if (!parsed.success) {
        return json(res, 400, { error: "Validation failed", details: parsed.error.flatten() });
      }

      const result = await service.checkLimit(
        parsed.data.userId,
        parsed.data.delegationId,
        parsed.data.amountStroops
      );
      return json(res, 200, result);
    }),
  ];
}
