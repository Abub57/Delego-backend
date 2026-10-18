/**
 * Webhook registration and filter matching (Issue #102).
 */

import { createLogger } from "@delegolabs/utils";
import { randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_RETRY_POLICY, type RetryPolicy, type Webhook, type WebhookFilter } from "./types.js";

const log = createLogger("notifications:webhooks:registry", process.env.LOG_LEVEL ?? "info");

export interface RegisterWebhookInput {
  name: string;
  url: string;
  events: string[];
  filters?: WebhookFilter[];
  headers?: Record<string, string>;
  retryPolicy?: Partial<RetryPolicy>;
}

export class WebhookRegistry {
  private webhooks: Map<string, Webhook> = new Map();

  register(input: RegisterWebhookInput): Webhook {
    // Issue #348 — HTTPS exclusively. Plain HTTP is rejected outright (not
    // just discouraged): it leaks the HMAC-signed payload on the wire, and
    // DNS-rebinding/SSRF checks at send time (see ssrfGuard.ts) assume TLS.
    // The hostname/private-IP checks themselves can only run at send time
    // (DNS can change after registration), so this is a cheap, synchronous
    // first line of defense, not the full guard.
    if (!input.url.startsWith("https://")) {
      throw new Error(`Invalid webhook URL: ${input.url} — only https:// URLs are accepted`);
    }
    if (input.events.length === 0) {
      throw new Error("A webhook must subscribe to at least one event");
    }

    const now = new Date().toISOString();
    const webhook: Webhook = {
      id: randomUUID(),
      name: input.name,
      url: input.url,
      secret: randomBytes(32).toString("hex"),
      events: input.events,
      filters: input.filters ?? [],
      headers: input.headers ?? {},
      retryPolicy: { ...DEFAULT_RETRY_POLICY, ...input.retryPolicy },
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.webhooks.set(webhook.id, webhook);
    log.info("Webhook registered", { id: webhook.id, name: webhook.name, events: webhook.events });
    return webhook;
  }

  /** Update a webhook's config, bumping its version so receivers/tests can
   * distinguish which config a given delivery was sent under. */
  update(id: string, patch: Partial<Omit<Webhook, "id" | "secret" | "createdAt" | "version">>): Webhook {
    const webhook = this.mustGet(id);
    Object.assign(webhook, patch, {
      version: webhook.version + 1,
      updatedAt: new Date().toISOString(),
    });
    return webhook;
  }

  pause(id: string): Webhook {
    return this.update(id, { status: "paused" });
  }

  resume(id: string): Webhook {
    return this.update(id, { status: "active" });
  }

  disable(id: string): Webhook {
    return this.update(id, { status: "disabled" });
  }

  get(id: string): Webhook | undefined {
    return this.webhooks.get(id);
  }

  list(): Webhook[] {
    return Array.from(this.webhooks.values());
  }

  /** Webhooks subscribed to `eventType`, active, and matching every filter. */
  findSubscribers(eventType: string, eventPayload: Record<string, unknown>): Webhook[] {
    return this.list().filter(
      (webhook) =>
        webhook.status === "active" &&
        webhook.events.includes(eventType) &&
        matchesFilters(webhook.filters, eventPayload),
    );
  }

  clear(): void {
    this.webhooks.clear();
  }

  private mustGet(id: string): Webhook {
    const webhook = this.webhooks.get(id);
    if (!webhook) {
      throw new Error(`Webhook not found: ${id}`);
    }
    return webhook;
  }
}

export function matchesFilters(filters: WebhookFilter[], payload: Record<string, unknown>): boolean {
  return filters.every((filter) => matchesFilter(filter, payload));
}

function matchesFilter(filter: WebhookFilter, payload: Record<string, unknown>): boolean {
  const actual = payload[filter.field];
  switch (filter.operator) {
    case "eq":
      return actual === filter.value;
    case "neq":
      return actual !== filter.value;
    case "contains":
      return typeof actual === "string" && typeof filter.value === "string"
        ? actual.includes(filter.value)
        : Array.isArray(actual)
          ? actual.includes(filter.value)
          : false;
    case "gt":
      return typeof actual === "number" && typeof filter.value === "number" && actual > filter.value;
    case "lt":
      return typeof actual === "number" && typeof filter.value === "number" && actual < filter.value;
    default:
      return false;
  }
}

export const defaultWebhookRegistry = new WebhookRegistry();
