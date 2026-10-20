import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { rateLimitMiddleware } from "../../middleware/rateLimit.js";
import { createGlobalRateLimiter } from "./globalRedis.js";
import type { GlobalTokenBucket } from "./globalTokenBucket.js";

export interface GlobalRateLimitOptions {
  /** An injected limiter is owned by the caller. */
  limiter?: GlobalTokenBucket;
}

const plugin: FastifyPluginAsync<GlobalRateLimitOptions> = async (app, options) => {
  const owned = options.limiter ? undefined : createGlobalRateLimiter();
  const middleware = rateLimitMiddleware(undefined, {
    globalLimiter: options.limiter ?? owned!.limiter,
  });
  if (owned) app.addHook("onClose", async () => { owned.client.disconnect(); });
  app.addHook("onRequest", async (request, reply) => {
    let continued = false;
    await middleware(request.raw, reply.raw, (error?: unknown) => {
      if (error) throw error;
      continued = true;
    });
    if (!continued) reply.hijack();
  });
};

/** Register before routes; applies to sibling routes through fastify-plugin. */
export const globalRateLimitPlugin = fp(plugin, {
  name: "delego-global-rate-limit",
  fastify: "5.x",
});
