/**
 * OpenAPI-driven request validation middleware
 * 
 * Validates incoming requests against the OpenAPI specification defined in
 * ../openapi.ts. Rejects invalid requests with 400 Bad Request and structured
 * error details including field paths and expected types.
 * 
 * Implementation Requirements (per specification):
 * - Validates path parameters, query parameters, and request bodies
 * - Excludes health check and documentation endpoints
 * - Returns structured error responses with field paths
 * - Uses AJV for JSON Schema validation
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import Ajv, { type ValidateFunction, type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { createLogger } from "@delegolabs/utils";
import { openApiSpec } from "../openapi.js";

const log = createLogger("gateway:validate-request");

// Initialize AJV with formats support
const ajv = new (Ajv as any)({
  allErrors: true,      // Collect all validation errors
  coerceTypes: true,    // Coerce types for query/path params (e.g., "123" -> 123)
  removeAdditional: false,
  useDefaults: true,
  strict: false,
});

(addFormats as any)(ajv);

// Endpoints that should bypass validation
const EXCLUDED_PATHS = [
  "/health",
  "/healthz",
  "/ready",
  "/api/docs",
  "/swagger",
  "/openapi.json",
  "/api/docs/openapi.json",
];

// HTTP methods that typically have request bodies
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

/**
 * Structured validation error detail
 */
interface ValidationErrorDetail {
  field: string;
  message: string;
  expected?: string;
}

/**
 * Structured error response format
 */
interface ValidationErrorResponse {
  error: string;
  details: ValidationErrorDetail[];
}

/**
 * Compiled operation from OpenAPI spec
 */
interface CompiledOperation {
  method: string;
  pathTemplate: string;
  pathPattern: RegExp;
  pathParamNames: string[];
  operation: any;
  validators: {
    path?: ValidateFunction;
    query?: ValidateFunction;
    body?: ValidateFunction;
  };
}

/**
 * Compile path template into regex pattern for matching
 * Example: "/api/v1/wallets/{walletId}" -> /^\/api\/v1\/wallets\/([^/]+)$/
 */
function compilePathTemplate(pathTemplate: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segments = pathTemplate.split(/(\{[^}]+\})/g);
  
  const regexSource = segments
    .map((segment) => {
      const match = segment.match(/^\{([^}]+)\}$/);
      if (match) {
        paramNames.push(match[1]);
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  
  return {
    pattern: new RegExp(`^${regexSource}$`),
    paramNames,
  };
}

/**
 * Build JSON Schema for path/query/header parameters
 */
function buildParamsSchema(parameters: any[] | undefined, location: "path" | "query" | "header"): any {
  const relevantParams = (parameters ?? []).filter((p: any) => p.in === location);
  
  if (relevantParams.length === 0) {
    return null;
  }
  
  const properties: Record<string, any> = {};
  const required: string[] = [];
  
  for (const param of relevantParams) {
    properties[param.name] = param.schema ?? { type: "string" };
    if (param.required) {
      required.push(param.name);
    }
  }
  
  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: true,
  };
}

/**
 * Compile all operations from OpenAPI spec
 */
function compileOperations(): CompiledOperation[] {
  const compiled: CompiledOperation[] = [];
  const paths = (openApiSpec as any).paths ?? {};
  
  for (const [pathTemplate, pathItem] of Object.entries<any>(paths)) {
    const { pattern, paramNames } = compilePathTemplate(pathTemplate);
    
    for (const method of ["get", "post", "put", "patch", "delete", "options", "head"]) {
      const operation = pathItem[method];
      if (!operation) continue;
      
      const validators: CompiledOperation["validators"] = {};
      
      // Compile path parameter validator
      const pathSchema = buildParamsSchema(operation.parameters, "path");
      if (pathSchema) {
        validators.path = ajv.compile(pathSchema);
      }
      
      // Compile query parameter validator
      const querySchema = buildParamsSchema(operation.parameters, "query");
      if (querySchema) {
        validators.query = ajv.compile(querySchema);
      }
      
      // Compile request body validator
      const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
      if (bodySchema) {
        validators.body = ajv.compile(bodySchema);
      }
      
      compiled.push({
        method: method.toUpperCase(),
        pathTemplate,
        pathPattern: pattern,
        pathParamNames: paramNames,
        operation,
        validators,
      });
    }
  }
  
  log.info(`Compiled ${compiled.length} OpenAPI operations for validation`);
  return compiled;
}

// Compile operations at module load time (once)
const compiledOperations = compileOperations();

/**
 * Find matching operation for incoming request
 */
function findOperation(method: string, pathname: string): CompiledOperation | null {
  for (const op of compiledOperations) {
    if (op.method !== method) continue;
    
    const match = pathname.match(op.pathPattern);
    if (match) {
      return op;
    }
  }
  return null;
}

/**
 * Extract path parameters from URL using compiled pattern
 */
function extractPathParams(pathname: string, operation: CompiledOperation): Record<string, string> {
  const match = pathname.match(operation.pathPattern);
  if (!match) return {};
  
  const params: Record<string, string> = {};
  operation.pathParamNames.forEach((name, index) => {
    params[name] = decodeURIComponent(match[index + 1] ?? "");
  });
  
  return params;
}

/**
 * Map AJV errors to structured validation error details
 */
function mapAjvErrors(errors: ErrorObject[] | null | undefined, location: string): ValidationErrorDetail[] {
  if (!errors) return [];
  
  return errors.map((err) => {
    const instancePath = err.instancePath ? err.instancePath.slice(1).split("/") : [];
    const missingProperty = err.keyword === "required" ? (err.params as any)?.missingProperty : undefined;
    const path = missingProperty ? [...instancePath, missingProperty] : instancePath;
    
    const fieldPath = [location, ...path].filter(Boolean).join(".");
    
    let message = err.message ?? "Invalid value";
    let expected: string | undefined;
    
    // Extract expected type/constraint from error
    switch (err.keyword) {
      case "type":
        expected = (err.params as any)?.type;
        message = `must be ${expected}`;
        break;
      case "format":
        expected = `format: ${(err.params as any)?.format}`;
        message = `must match format "${(err.params as any)?.format}"`;
        break;
      case "minimum":
        expected = `>= ${(err.params as any)?.limit}`;
        message = `must be >= ${(err.params as any)?.limit}`;
        break;
      case "maximum":
        expected = `<= ${(err.params as any)?.limit}`;
        message = `must be <= ${(err.params as any)?.limit}`;
        break;
      case "minLength":
        expected = `minLength: ${(err.params as any)?.limit}`;
        break;
      case "maxLength":
        expected = `maxLength: ${(err.params as any)?.limit}`;
        break;
      case "enum":
        expected = `enum: [${(err.params as any)?.allowedValues?.join(", ")}]`;
        message = `must be one of: ${(err.params as any)?.allowedValues?.join(", ")}`;
        break;
      case "required":
        message = "is required";
        expected = "required field";
        break;
    }
    
    return {
      field: fieldPath,
      message,
      ...(expected ? { expected } : {}),
    };
  });
}

/**
 * Send validation error response
 */
function sendValidationError(res: ServerResponse, details: ValidationErrorDetail[]): void {
  const response: ValidationErrorResponse = {
    error: "Validation Error",
    details,
  };
  
  res.writeHead(400, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(response, null, 2));
}

/**
 * Read and parse JSON body from request
 */
async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : undefined);
      } catch (err) {
        reject(new Error("Invalid JSON in request body"));
      }
    });
    
    req.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * OpenAPI request validation middleware
 * 
 * Validates incoming requests against the OpenAPI specification.
 * Returns 400 Bad Request with structured error details for invalid requests.
 */
export function validateRequest() {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;
      const method = (req.method ?? "GET").toUpperCase();
      
      // Skip validation for excluded paths
      if (EXCLUDED_PATHS.some(excluded => pathname === excluded || pathname.startsWith(excluded))) {
        next();
        return;
      }
      
      // Find matching operation
      const operation = findOperation(method, pathname);
      
      // If no matching operation, pass through (404 will be handled by router)
      if (!operation) {
        next();
        return;
      }
      
      const allErrors: ValidationErrorDetail[] = [];
      
      // Validate path parameters
      if (operation.validators.path) {
        const pathParams = extractPathParams(pathname, operation);
        if (!operation.validators.path(pathParams)) {
          const errors = mapAjvErrors(operation.validators.path.errors, "path");
          allErrors.push(...errors);
        }
      }
      
      // Validate query parameters
      if (operation.validators.query) {
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((value, key) => {
          queryParams[key] = value;
        });
        
        if (!operation.validators.query(queryParams)) {
          const errors = mapAjvErrors(operation.validators.query.errors, "query");
          allErrors.push(...errors);
        }
      }
      
      // Validate request body (for POST, PUT, PATCH)
      if (METHODS_WITH_BODY.has(method) && operation.validators.body) {
        try {
          const body = await readJsonBody(req);
          
          // Check if body is required but missing
          if (operation.operation.requestBody?.required && (body === undefined || body === null)) {
            allErrors.push({
              field: "body",
              message: "Request body is required",
              expected: "non-empty request body",
            });
          } else if (body !== undefined && !operation.validators.body(body)) {
            const errors = mapAjvErrors(operation.validators.body.errors, "body");
            allErrors.push(...errors);
          }
        } catch (err) {
          allErrors.push({
            field: "body",
            message: err instanceof Error ? err.message : "Invalid request body",
            expected: "valid JSON",
          });
        }
      }
      
      // If validation errors exist, return 400
      if (allErrors.length > 0) {
        log.warn("Request validation failed", {
          method,
          path: pathname,
          errors: allErrors,
        });
        sendValidationError(res, allErrors);
        return;
      }
      
      // Validation passed, continue to next middleware
      next();
    } catch (err) {
      log.error("Validation middleware error", { error: err });
      next(err);
    }
  };
}
