import { createLogger } from "@delegolabs/utils";
import type { EmailMessage } from "../../email/index.js";
import { classifyError } from "../../email/errorClassifier.js";
import type { PushPayload, PushSubscription } from "../../push/index.js";
import type { WalletLookupAdapter } from "../walletLookup.js";
import type { TokenBucketRateLimiter } from "./rateLimiter.js";
import type { RestockProduct, RestockWaitlistEntry } from "./repository.js";

const log = createLogger("notifications:restock:notifier", process.env.LOG_LEVEL ?? "info");

export type RestockNotifyResult = "sent" | "permanent_failure" | "transient_failure";

export interface RestockNotifier {
  notify(entry: RestockWaitlistEntry, product: RestockProduct): Promise<RestockNotifyResult>;
}

export interface ChannelRestockNotifierDeps {
  sendEmail(message: EmailMessage): Promise<void>;
  /** Throttles email provider calls across the whole worker process. */
  emailLimiter: Pick<TokenBucketRateLimiter, "acquire">;
  walletLookup: WalletLookupAdapter;
  getPushSubscriptions(userId: string): Promise<PushSubscription[]>;
  sendPush(subscription: PushSubscription, payload: PushPayload): Promise<void>;
  storefrontUrl: string;
}

type ChannelResult = "sent" | "skipped" | RestockNotifyResult;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Notifies one waitlist subscriber over every channel they gave us: email
 * (rate limited) and web push (resolved from their wallet address).
 *
 * The subscriber counts as notified if any channel delivers. A transient
 * failure with no successful channel is reported as transient so the
 * subscriber stays pending and is retried.
 */
export class ChannelRestockNotifier implements RestockNotifier {
  constructor(private readonly deps: ChannelRestockNotifierDeps) {}

  async notify(entry: RestockWaitlistEntry, product: RestockProduct): Promise<RestockNotifyResult> {
    const productUrl = `${this.deps.storefrontUrl.replace(/\/$/, "")}/products/${product.id}`;
    const results: ChannelResult[] = await Promise.all([
      entry.email ? this.sendEmail(entry.email, product, productUrl) : Promise.resolve<ChannelResult>("skipped"),
      entry.buyerAddress
        ? this.sendPush(entry.buyerAddress, product, productUrl)
        : Promise.resolve<ChannelResult>("skipped"),
    ]);

    if (results.includes("sent")) return "sent";
    if (results.includes("transient_failure")) return "transient_failure";
    return "permanent_failure";
  }

  private async sendEmail(to: string, product: RestockProduct, productUrl: string): Promise<ChannelResult> {
    const title = escapeHtml(product.title);
    const seller = product.merchantName ? ` from ${escapeHtml(product.merchantName)}` : "";
    try {
      await this.deps.emailLimiter.acquire();
      await this.deps.sendEmail({
        to,
        subject: `Back in stock: ${product.title}`,
        html:
          `<p>Good news — <strong>${title}</strong>${seller} is back in stock.</p>` +
          `<p><a href="${escapeHtml(productUrl)}">View the product</a> before it sells out again.</p>` +
          `<p style="color:#666;font-size:12px">You received this because you joined the restock waitlist.</p>`,
        text: `${product.title} is back in stock: ${productUrl}`,
      });
      return "sent";
    } catch (err) {
      const classification = classifyError(err);
      log.warn("Restock email failed", {
        productId: product.id,
        classification,
        error: err instanceof Error ? err.message : String(err),
      });
      return classification === "transient" ? "transient_failure" : "permanent_failure";
    }
  }

  private async sendPush(walletAddress: string, product: RestockProduct, productUrl: string): Promise<ChannelResult> {
    const target = await this.deps.walletLookup.lookupByWalletAddress(walletAddress);
    if (!target?.pushEnabled) return "skipped";

    const subscriptions = await this.deps.getPushSubscriptions(target.userId);
    const payload: PushPayload = {
      title: "Back in stock",
      body: `${product.title} is available again.`,
      data: { type: "product.restocked", productId: product.id, url: productUrl },
      actions: [{ action: "view", title: "View product" }],
    };

    let delivered = false;
    for (const subscription of subscriptions) {
      try {
        await this.deps.sendPush(subscription, payload);
        delivered = true;
      } catch (err) {
        log.warn("Restock push failed", {
          productId: product.id,
          userId: target.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Dead push endpoints are pruned by the existing subscription cleanup job.
    return delivered ? "sent" : "skipped";
  }
}
