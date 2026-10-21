/**
 * Multi-Signature Wallet — HTTP routes
 * Issue #44
 *
 * POST   /multisig/wallets                             – create wallet
 * GET    /multisig/wallets/:walletId                   – get wallet
 * POST   /multisig/wallets/:walletId/pause             – pause wallet
 * POST   /multisig/wallets/:walletId/unpause           – unpause wallet
 * POST   /multisig/wallets/:walletId/signers           – add/remove/update signer
 * GET    /multisig/wallets/:walletId/proposals         – list proposals
 * POST   /multisig/wallets/:walletId/proposals         – create proposal
 * GET    /multisig/wallets/:walletId/proposals/:pid    – get proposal
 * POST   /multisig/wallets/:walletId/proposals/:pid/sign     – submit signature
 * POST   /multisig/wallets/:walletId/proposals/:pid/execute  – execute proposal
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { route, json, type Route } from "@delegolabs/utils";
import {
  createMultiSigWallet,
  createProposal,
  submitSignature,
  executeProposal,
  updateSigner,
  pauseWallet,
  unpauseWallet,
  getWallet,
  listProposals,
  getProposal,
} from "./service.js";
import { registerCoSigningRoutes } from "./coSigningRoutes.js";

async function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function handleError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  const status = message.toLowerCase().includes("not found") ? 404 : 400;
  json(res, status, { data: null, error: { code: "MULTISIG_ERROR", message } });
}

export function registerMultiSigRoutes(): Route[] {
  return [
    // Create wallet
    route("POST", "/multisig/wallets", async (req, res) => {
      try {
        const body = await readBody(req);
        const wallet = await createMultiSigWallet(
          body as Parameters<typeof createMultiSigWallet>[0],
        );
        json(res, 201, { data: wallet, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Get wallet
    route("GET", "/multisig/wallets/:walletId", async (_req, res, params) => {
      try {
        const wallet = await getWallet(params.walletId);
        json(res, 200, { data: wallet, error: null });
      } catch (err) {
        handleError(res, err);
      }
    }),

    // Pause wallet
    route(
      "POST",
      "/multisig/wallets/:walletId/pause",
      async (req, res, params) => {
        try {
          const { performedBy } = await readBody<{ performedBy: string }>(req);
          const wallet = await pauseWallet(params.walletId, performedBy);
          json(res, 200, { data: wallet, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // Unpause wallet
    route(
      "POST",
      "/multisig/wallets/:walletId/unpause",
      async (req, res, params) => {
        try {
          const { performedBy } = await readBody<{ performedBy: string }>(req);
          const wallet = await unpauseWallet(params.walletId, performedBy);
          json(res, 200, { data: wallet, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // Update signer
    route(
      "POST",
      "/multisig/wallets/:walletId/signers",
      async (req, res, params) => {
        try {
          const body = await readBody(req);
          const wallet = await updateSigner(
            params.walletId,
            body as Parameters<typeof updateSigner>[1],
          );
          json(res, 200, { data: wallet, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // List proposals
    route(
      "GET",
      "/multisig/wallets/:walletId/proposals",
      async (_req, res, params) => {
        try {
          const proposals = await listProposals(params.walletId);
          json(res, 200, { data: proposals, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // Create proposal
    route(
      "POST",
      "/multisig/wallets/:walletId/proposals",
      async (req, res, params) => {
        try {
          const body = await readBody(req);
          const proposal = await createProposal(
            params.walletId,
            body as Parameters<typeof createProposal>[1],
          );
          json(res, 201, { data: proposal, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // Get proposal
    route(
      "GET",
      "/multisig/wallets/:walletId/proposals/:proposalId",
      async (_req, res, params) => {
        try {
          const proposal = await getProposal(
            params.walletId,
            params.proposalId,
          );
          json(res, 200, { data: proposal, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // Submit signature
    route(
      "POST",
      "/multisig/wallets/:walletId/proposals/:proposalId/sign",
      async (req, res, params) => {
        try {
          const body = await readBody(req);
          const proposal = await submitSignature(
            params.walletId,
            params.proposalId,
            body as Parameters<typeof submitSignature>[2],
          );
          json(res, 200, { data: proposal, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // Execute proposal
    route(
      "POST",
      "/multisig/wallets/:walletId/proposals/:proposalId/execute",
      async (req, res, params) => {
        try {
          const { executorAddress } = await readBody<{
            executorAddress: string;
          }>(req);
          const proposal = await executeProposal(
            params.walletId,
            params.proposalId,
            executorAddress,
          );
          json(res, 200, { data: proposal, error: null });
        } catch (err) {
          handleError(res, err);
        }
      },
    ),

    // Issue #289: Dual-control co-signing coordination
    ...registerCoSigningRoutes(),
  ];
}
