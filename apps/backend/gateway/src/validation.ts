import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new (Ajv as any)();
(addFormats as any)(ajv);

export interface ValidationErrorDetail {
  field: string;
  message: string;
  keyword: string;
}

export interface RegisterPayload {
  email: string;
  password: string;
  displayName?: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export interface CreateDelegationPolicyPayload {
  agentId: string;
  walletId: string;
  label: string;
  policy: {
    maxPerTransaction: string;
    maxTotal: string;
    allowedMerchants: string[];
    allowedCategories: string[];
    expiresAt?: string | null;
  };
  permissionLevel: "VIEW_ONLY" | "AUTO_APPROVE" | "SIGNER" | "ADMIN";
}

export interface UpdateDelegationPayload {
  status?: "pending" | "active" | "paused" | "revoked" | "expired";
  policy?: {
    maxPerTransaction?: string;
    maxTotal?: string;
    allowedMerchants?: string[];
    allowedCategories?: string[];
    expiresAt?: string | null;
  };
}

export interface CreateMerchantPayload {
  storeName: string;
  description?: string;
  stellarAddress: string;
  contactEmail: string;
  category: string;
}

export interface UpdateMerchantPayload {
  storeName?: string;
  description?: string;
  contactEmail?: string;
  category?: string;
}

export interface CreateProductPayload {
  sku: string;
  title: string;
  description?: string;
  priceStroops: string;
  assetCode?: string;
  stockQuantity?: number;
  isListed?: boolean;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateProductPayload {
  sku?: string;
  title?: string;
  description?: string;
  priceStroops?: string;
  assetCode?: string;
  stockQuantity?: number;
  isListed?: boolean;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateProductVariantPayload {
  sku: string;
  attributes: Record<string, unknown>;
  priceStroops: string;
  stockCount?: number;
  barcode?: string;
}

export interface UpdateProductVariantStockPayload {
  delta: number; // Atomic delta: positive to add, negative to subtract
}

export interface ReviewSubmissionPayload {
  orderId: string;
  rating: number;
  title: string;
  content: string;
  escrowContractId: string;
  buyerSignature: string;
}

export interface ReviewAppealRequest {
  reviewId: string;
  reasonCategory: "spam" | "abusive" | "unrelated" | "fraudulent";
  justification: string;
  evidenceUrls: string[];
}

export interface ReviewModerationPayload {
  status: "approved" | "rejected";
  moderatorNotes?: string;
}

export interface AdminVerdictPayload {
  appealId: string;
  verdict: "remove_review" | "keep_review" | "warn_buyer";
  adminNotes: string;
}

export interface DeliveryEvidencePayload {
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
}

export interface AgentChatPayload {
  messages: Array<{ role: string; content: string }>;
  delegationId?: string;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

export const RegisterSchema: any = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 8 },
    displayName: { type: "string" }
  },
  required: ["email", "password"],
  additionalProperties: false
};

export const LoginSchema: any = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string" }
  },
  required: ["email", "password"],
  additionalProperties: false
};

export const OAuthCallbackSchema: any = {
  type: "object",
  properties: {
    provider: { type: "string", enum: ["google", "github"] },
    code: { type: "string", minLength: 1 },
    state: { type: "string", minLength: 1 },
  },
  required: ["provider", "code", "state"],
  additionalProperties: false,
};

export const CreateDelegationSchema: any = {
  type: "object",
  properties: {
    agentId: { type: "string", format: "uuid" },
    walletId: { type: "string", format: "uuid" },
    label: { type: "string" },
    policy: {
      type: "object",
      properties: {
        maxPerTransaction: { type: "string", pattern: "^[0-9]+$" },
        maxTotal: { type: "string", pattern: "^[0-9]+$" },
        allowedMerchants: { type: "array", items: { type: "string" } },
        allowedCategories: { type: "array", items: { type: "string" } },
        expiresAt: { type: "string", format: "date-time" }
      },
      required: ["maxPerTransaction", "maxTotal", "allowedMerchants", "allowedCategories"],
      additionalProperties: false
    },
    permissionLevel: { type: "string", enum: ["VIEW_ONLY", "AUTO_APPROVE", "SIGNER", "ADMIN"] }
  },
  required: ["agentId", "walletId", "label", "policy", "permissionLevel"],
  additionalProperties: false
};

export const UpdateDelegationSchema: any = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["pending", "active", "paused", "revoked", "expired"] },
    policy: {
      type: "object",
      properties: {
        maxPerTransaction: { type: "string", pattern: "^[0-9]+$" },
        maxTotal: { type: "string", pattern: "^[0-9]+$" },
        allowedMerchants: { type: "array", items: { type: "string" } },
        allowedCategories: { type: "array", items: { type: "string" } },
        expiresAt: { type: "string", format: "date-time" }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
};

export const CreateMerchantSchema: any = {
  type: "object",
  properties: {
    storeName: { type: "string", minLength: 1, maxLength: 128 },
    description: { type: "string" },
    stellarAddress: { type: "string", minLength: 56, maxLength: 56, pattern: "^G[A-Za-z0-9]{55}$" },
    contactEmail: { type: "string", format: "email" },
    category: { type: "string", minLength: 1, maxLength: 64 }
  },
  required: ["storeName", "stellarAddress", "contactEmail", "category"],
  additionalProperties: false
};

export const UpdateMerchantSchema: any = {
  type: "object",
  properties: {
    storeName: { type: "string", minLength: 1, maxLength: 128 },
    description: { type: "string" },
    contactEmail: { type: "string", format: "email" },
    category: { type: "string", minLength: 1, maxLength: 64 }
  },
  additionalProperties: false,
  minProperties: 1
};

export const CreateProductSchema: any = {
  type: "object",
  properties: {
    sku: { type: "string", minLength: 1, maxLength: 64 },
    title: { type: "string", minLength: 1, maxLength: 255 },
    description: { type: "string" },
    priceStroops: { type: "string", pattern: "^[1-9][0-9]*$" },
    assetCode: { type: "string", minLength: 1, maxLength: 12 },
    stockQuantity: { type: "integer", minimum: 0 },
    isListed: { type: "boolean" },
    imageUrl: { type: "string" },
    metadata: { type: "object" }
  },
  required: ["sku", "title", "priceStroops"],
  additionalProperties: false
};

export const UpdateProductSchema: any = {
  type: "object",
  properties: {
    sku: { type: "string", minLength: 1, maxLength: 64 },
    title: { type: "string", minLength: 1, maxLength: 255 },
    description: { type: "string" },
    priceStroops: { type: "string", pattern: "^[1-9][0-9]*$" },
    assetCode: { type: "string", minLength: 1, maxLength: 12 },
    stockQuantity: { type: "integer", minimum: 0 },
    isListed: { type: "boolean" },
    imageUrl: { type: "string" },
    metadata: { type: "object" }
  },
  additionalProperties: false,
  minProperties: 1
};

export const AgentChatSchema: any = {
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
          content: { type: "string" }
        },
        required: ["role", "content"],
        additionalProperties: false
      },
      minItems: 1
    },
    delegationId: { type: "string", format: "uuid" },
    tools: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          parameters: { type: "object" }
        },
        required: ["name", "description", "parameters"],
        additionalProperties: false
      }
    }
  },
  required: ["messages"],
  additionalProperties: false
};

export function validateSchema(schema: any, data: unknown): { valid: boolean; errors?: ValidationErrorDetail[] } {
  const validate = ajv.compile(schema);
  const valid = validate(data);
  if (valid) {
    return { valid: true };
  } else {
    const errors: ValidationErrorDetail[] = (validate.errors ?? []).map((err: any) => ({
      field: err.instancePath.slice(1) || "body",
      message: err.message ?? "Invalid value",
      keyword: err.keyword
    }));
    return { valid: false, errors };
  }
}
export const CreateProductVariantSchema: any = {
  type: "object",
  properties: {
    sku: { type: "string", minLength: 1, maxLength: 64 },
    attributes: { type: "object" },
    priceStroops: { type: "string", pattern: "^[1-9][0-9]*$" },
    stockCount: { type: "integer", minimum: 0 },
    barcode: { type: "string", maxLength: 64 },
  },
  required: ["sku", "attributes", "priceStroops"],
  additionalProperties: false,
};

export const UpdateProductVariantStockSchema: any = {
  type: "object",
  properties: {
    delta: { type: "integer" },
  },
  required: ["delta"],
  additionalProperties: false,
};

export const ReviewSubmissionSchema: any = {
  type: "object",
  properties: {
    orderId: { type: "string", minLength: 1, maxLength: 128 },
    rating: { type: "integer", minimum: 1, maximum: 5 },
    title: { type: "string", minLength: 1, maxLength: 255 },
    content: { type: "string", minLength: 1 },
    escrowContractId: { type: "string", minLength: 1, maxLength: 64 },
    buyerSignature: { type: "string", minLength: 1, maxLength: 256 },
  },
  required: ["orderId", "rating", "title", "content", "escrowContractId", "buyerSignature"],
  additionalProperties: false,
};

export const ReviewAppealSchema: any = {
  type: "object",
  properties: {
    reviewId: { type: "string", format: "uuid" },
    reasonCategory: { type: "string", enum: ["spam", "abusive", "unrelated", "fraudulent"] },
    justification: { type: "string", minLength: 1, maxLength: 5000 },
    evidenceUrls: {
      type: "array",
      items: { type: "string", format: "uri" },
      minItems: 1,
      maxItems: 10,
    },
  },
  required: ["reviewId", "reasonCategory", "justification", "evidenceUrls"],
  additionalProperties: false,
};

export const ReviewModerationSchema: any = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["approved", "rejected"] },
    moderatorNotes: { type: "string", maxLength: 5000 },
  },
  required: ["status"],
  additionalProperties: false,
  minProperties: 1,
};

export const AdminVerdictSchema: any = {
  type: "object",
  properties: {
    // appealId is sourced from the request path, not the body; accepted here
    // for backwards compatibility but never required.
    appealId: { type: "string", minLength: 1, maxLength: 128 },
    verdict: { type: "string", enum: ["remove_review", "keep_review", "warn_buyer"] },
    adminNotes: { type: "string", minLength: 1, maxLength: 5000 },
  },
  required: ["verdict", "adminNotes"],
  additionalProperties: false,
};

export const DeliveryEvidenceSchema: any = {
  type: "object",
  properties: {
    fileName: { type: "string", minLength: 1, maxLength: 255 },
    mimeType: { type: "string", minLength: 1, maxLength: 64 },
    fileSizeBytes: { type: "integer", minimum: 1, maximum: 10485760 }, // 10MB max
  },
  required: ["fileName", "mimeType", "fileSizeBytes"],
  additionalProperties: false,
};