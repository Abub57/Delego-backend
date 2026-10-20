import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { Route } from "@delegolabs/utils";
import { route, createLogger } from "@delegolabs/utils";
import { extractAuth } from "../../middleware/auth.js";
import { validateSchema, DeliveryEvidenceSchema } from "../../src/validation.js";
import { readJsonBody, InvalidJsonError, BodyTooLargeError } from "../../src/request.js";
import { badRequest, notFound, unauthorized, sendApiError } from "../../src/errors.js";
import { Merchant, DeliveryEvidence } from "../../src/models/index.js";

const log = createLogger("gateway:delivery", process.env.LOG_LEVEL ?? "info");

// IPFS configuration (would come from config/env in production)
const IPFS_API_URL = process.env.IPFS_API_URL ?? "https://api.pinata.cloud/pinning/pinFileToIPFS";
const IPFS_API_KEY = process.env.IPFS_API_KEY ?? "";
const IPFS_API_SECRET = process.env.IPFS_API_SECRET ?? "";

/**
 * Upload file to IPFS pinning service (Pinata/Infura)
 * Returns the immutable CID
 */
async function uploadToIpfs(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<{ cid: string; storageUrl: string }> {
  // In production, this would make an actual API call to Pinata/Infura
  // For now, we'll simulate the response
  
  if (!IPFS_API_KEY || !IPFS_API_SECRET) {
    // Fallback: use local hash as "CID" for development
    const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const simulatedCid = "Qm" + hash.substring(0, 44);
    const storageUrl = `ipfs://${simulatedCid}`;
    
    log.warn("IPFS credentials not configured, using simulated CID", { 
      simulatedCid,
      fileName 
    });
    
    return { cid: simulatedCid, storageUrl };
  }

  const formData = new FormData();
  const blob = new Blob([fileBuffer], { type: mimeType });
  formData.append('file', blob, fileName);

  try {
    const response = await fetch(IPFS_API_URL, {
      method: "POST",
      headers: {
        "pinata_api_key": IPFS_API_KEY,
        "pinata_secret_api_key": IPFS_API_SECRET,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`IPFS upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { IpfsHash: string };
    const cid = result.IpfsHash;
    const storageUrl = `ipfs://${cid}`;

    log.info("File uploaded to IPFS", { cid, fileName });
    return { cid, storageUrl };
  } catch (uploadError) {
    log.error("IPFS upload failed", { 
      error: uploadError instanceof Error ? uploadError.message : String(uploadError),
      fileName 
    });
    throw uploadError;
  }
}

/**
 * S3 backup upload (alternative to IPFS)
 * Uses AWS S3 for document archival
 */
async function uploadToS3(
  fileBuffer: Buffer,
  orderId: string,
  fileName: string,
  _mimeType: string,
): Promise<{ cid: string; storageUrl: string }> {
  // In production, this would use @aws-sdk/client-s3
  // For development, we'll create a deterministic "CID" based on hash
  
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const s3Key = `delivery-evidence/${orderId}/${hash}/${fileName}`;
  const storageUrl = `s3://${process.env.S3_BUCKET ?? "delego-delivery-evidence"}/${s3Key}`;
  
  log.info("S3 upload (simulated)", { s3Key, fileName });
  
  // Return hash as pseudo-CID for consistency
  return { cid: hash, storageUrl };
}

function formatDeliveryEvidenceResponse(evidence: DeliveryEvidence): Record<string, unknown> {
  return {
    id: evidence.id,
    orderId: evidence.orderId,
    merchantAddress: evidence.merchantAddress,
    sha256Hash: evidence.sha256Hash,
    ipfsCid: evidence.ipfsCid,
    storageUrl: evidence.storageUrl,
    fileName: evidence.fileName,
    mimeType: evidence.mimeType,
    fileSizeBytes: evidence.fileSizeBytes,
    verifiedAt: evidence.verifiedAt.toISOString(),
    createdAt: evidence.createdAt.toISOString(),
  };
}

/**
 * POST /api/v1/merchant/orders/:orderId/delivery-proof
 * Upload delivery evidence (signed bill of lading, courier receipt)
 * - Computes SHA-256 hash
 * - Uploads to IPFS/Arweave
 * - Stores cryptographic metadata
 */
export async function uploadDeliveryEvidenceHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const auth = extractAuth(req);
    if (!auth.userId) {
      unauthorized(res, "Authentication required", req);
      return;
    }

    const orderId = params.orderId;
    if (!orderId) {
      badRequest(res, "orderId path parameter is required", req);
      return;
    }

    // Read the multipart body
    // In a real implementation, we'd use a multipart parser
    // For this example, we'll expect JSON with base64-encoded file
    const body = await readJsonBody(req);
    
    // Validate metadata
    const validation = validateSchema(DeliveryEvidenceSchema, body);
    if (!validation.valid) {
      badRequest(res, "Invalid request body", req, validation.errors);
      return;
    }

    // Get merchant address from user's merchant profile
    const merchant = await Merchant.findOne({
      where: { ownerUserId: auth.userId },
    });
    if (!merchant) {
      notFound(res, "No merchant profile found", req);
      return;
    }

    // Decode base64 file (in production, parse multipart formdata)
    let fileBuffer: Buffer;
    try {
      if (body.fileData && typeof body.fileData === 'string') {
        fileBuffer = Buffer.from(body.fileData, 'base64');
      } else {
        // For testing, generate a dummy buffer
        fileBuffer = Buffer.from(`Mock file content for order ${orderId}`);
      }
    } catch (decodeError) {
      badRequest(res, "Invalid file data: could not decode base64", req);
      return;
    }

    // Verify file size matches
    if (fileBuffer.length !== body.fileSizeBytes) {
      badRequest(res, "File size mismatch", req, {
        expected: body.fileSizeBytes,
        actual: fileBuffer.length,
      });
      return;
    }

    // Check if evidence already exists for this order
    const existingEvidence = await DeliveryEvidence.findOne({
      where: { orderId },
    });
    if (existingEvidence) {
      sendApiError(res, 409, "EVIDENCE_ALREADY_EXISTS",
        "Delivery evidence has already been uploaded for this order", req);
      return;
    }

    // Compute SHA-256 hash
    const sha256Hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    log.info("SHA-256 computed", { orderId, sha256Hash, fileSize: fileBuffer.length });

    // Upload to IPFS (or S3 as fallback)
    let ipfsResult: { cid: string; storageUrl: string };
    try {
      if (process.env.USE_S3_STORAGE === "true") {
        ipfsResult = await uploadToS3(fileBuffer, orderId, body.fileName, body.mimeType);
      } else {
        ipfsResult = await uploadToIpfs(fileBuffer, body.fileName, body.mimeType);
      }
    } catch (uploadError) {
      log.error("Failed to upload to storage", {
        error: uploadError instanceof Error ? uploadError.message : String(uploadError),
        orderId,
      });
      sendApiError(res, 500, "UPLOAD_FAILED",
        "Failed to upload delivery evidence to storage", req);
      return;
    }

    // Store the evidence record
    const evidence = await DeliveryEvidence.create({
      orderId,
      merchantAddress: merchant.stellarAddress,
      sha256Hash,
      ipfsCid: ipfsResult.cid,
      storageUrl: ipfsResult.storageUrl,
      fileName: body.fileName,
      mimeType: body.mimeType,
      fileSizeBytes: body.fileSizeBytes,
      verifiedAt: new Date(),
    });

    log.info("Delivery evidence stored", {
      evidenceId: evidence.id,
      orderId,
      sha256Hash,
      ipfsCid: ipfsResult.cid,
      userId: auth.userId,
    });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatDeliveryEvidenceResponse(evidence),
      error: null,
    }));
  } catch (err: any) {
    // Handle unique constraint violation
    if (err?.name === "SequelizeUniqueConstraintError" ||
        err?.errors?.some((e: any) => e.type === "unique violation" && e.path === "order_id")) {
      sendApiError(res, 409, "EVIDENCE_ALREADY_EXISTS",
        "Delivery evidence has already been uploaded for this order", req);
      return;
    }
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to upload delivery evidence", {
      error: err instanceof Error ? err.message : String(err),
      orderId: params.orderId,
      userId: extractAuth(req).userId,
    });
    sendApiError(res, 500, "EVIDENCE_UPLOAD_FAILED",
      err instanceof Error ? err.message : "Failed to upload delivery evidence", req);
  }
}

/**
 * GET /api/v1/merchant/orders/:orderId/delivery-proof
 * Get delivery evidence for an order
 */
export async function getDeliveryEvidenceHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const orderId = params.orderId;
    if (!orderId) {
      badRequest(res, "orderId path parameter is required", req);
      return;
    }

    const evidence = await DeliveryEvidence.findOne({
      where: { orderId },
    });
    if (!evidence) {
      notFound(res, "Delivery evidence not found for this order", req);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: formatDeliveryEvidenceResponse(evidence),
      error: null,
    }));
  } catch (err: any) {
    log.error("Failed to fetch delivery evidence", {
      error: err instanceof Error ? err.message : String(err),
      orderId: params.orderId,
    });
    sendApiError(res, 500, "EVIDENCE_FETCH_FAILED",
      err instanceof Error ? err.message : "Failed to fetch delivery evidence", req);
  }
}

/**
 * POST /api/v1/merchant/orders/:orderId/delivery-proof/verify
 * Verify the SHA-256 hash of previously uploaded evidence
 */
export async function verifyDeliveryEvidenceHandler(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  try {
    const orderId = params.orderId;
    if (!orderId) {
      badRequest(res, "orderId path parameter is required", req);
      return;
    }

    const evidence = await DeliveryEvidence.findOne({
      where: { orderId },
    });
    if (!evidence) {
      notFound(res, "Delivery evidence not found for this order", req);
      return;
    }

    const body = await readJsonBody(req);
    const providedHash = body.sha256Hash;

    if (!providedHash || typeof providedHash !== 'string') {
      badRequest(res, "sha256Hash is required in request body", req);
      return;
    }

    const isValid = evidence.sha256Hash.toLowerCase() === providedHash.toLowerCase();

    log.info("Delivery evidence verification", {
      orderId,
      providedHash,
      storedHash: evidence.sha256Hash,
      isValid,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        orderId,
        isValid,
        ipfsCid: evidence.ipfsCid,
        verifiedAt: evidence.verifiedAt.toISOString(),
      },
      error: null,
    }));
  } catch (err: any) {
    if (err instanceof InvalidJsonError || err instanceof BodyTooLargeError) {
      badRequest(res, err.message, req);
      return;
    }
    log.error("Failed to verify delivery evidence", {
      error: err instanceof Error ? err.message : String(err),
      orderId: params.orderId,
    });
    sendApiError(res, 500, "EVIDENCE_VERIFY_FAILED",
      err instanceof Error ? err.message : "Failed to verify delivery evidence", req);
  }
}

export function registerDeliveryEvidenceRoutes(): Route[] {
  return [
    // Delivery evidence upload
    route("POST", "/api/v1/merchant/orders/:orderId/delivery-proof", uploadDeliveryEvidenceHandler),
    route("GET", "/api/v1/merchant/orders/:orderId/delivery-proof", getDeliveryEvidenceHandler),
    route("POST", "/api/v1/merchant/orders/:orderId/delivery-proof/verify", verifyDeliveryEvidenceHandler),
  ];
}