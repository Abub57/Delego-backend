import { describe, it, expect, vi } from "vitest";
import { validateUploadHandler } from "./storage.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";

describe("storage routes - validateUploadHandler", () => {
  function createMockReqRes(body: unknown) {
    const req = new EventEmitter() as unknown as IncomingMessage;
    const jsonBody = JSON.stringify(body);

    const res = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: "",
      setHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
      },
      writeHead(code: number, headers?: Record<string, string>) {
        this.statusCode = code;
        if (headers) {
          Object.assign(this.headers, headers);
        }
      },
      end(data?: string) {
        if (data) this.body += data;
      },
    } as unknown as ServerResponse & { statusCode: number; body: string };

    process.nextTick(() => {
      req.emit("data", Buffer.from(jsonBody));
      req.emit("end");
    });

    return { req, res };
  }

  it("returns 400 if fileKey is missing", async () => {
    const { req, res } = createMockReqRes({ expectedMimeType: "image/jpeg" });
    await validateUploadHandler(req, res, {});

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse((res as any).body);
    expect(parsed.error.code).toBe("INVALID_REQUEST");
  });

  it("returns 400 if expectedMimeType is missing", async () => {
    const { req, res } = createMockReqRes({ fileKey: "evidence/123/file.jpg" });
    await validateUploadHandler(req, res, {});

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse((res as any).body);
    expect(parsed.error.code).toBe("INVALID_REQUEST");
  });
});
