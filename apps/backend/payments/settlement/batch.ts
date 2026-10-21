export interface CompletedMerchantOrder {
  orderId: string;
  merchantId: string;
  payoutAddress: string;
  grossAmount: bigint;
  completedAt: Date;
  status: "completed";
}

export interface MerchantBatchSettlement {
  settlementId: string;
  merchantId: string;
  payoutAddress: string;
  periodStart: Date;
  periodEnd: Date;
  totalGrossAmount: bigint;
  platformFees: bigint;
  netDisbursement: bigint;
  orderCount: number;
  orderIds: string[];
}

/**
 * UTC-aligned daily settlement window (Issue #339).
 *
 * Mirrors `MerchantBatchSettlement` in Stroops-denominated field names for
 * callers that need the explicit "this window is UTC, not local time" shape
 * the issue calls for — `startUtc`/`endUtc` rather than ambiguous
 * `periodStart`/`periodEnd` Date objects that a careless caller could build
 * from local-time calendar fields.
 */
export interface DailySettlementWindow {
  merchantId: string;
  startUtc: Date;
  endUtc: Date;
  totalGrossStroops: bigint;
  totalFeeStroops: bigint;
  netPayoutStroops: bigint;
}

/**
 * Returns the [start, end) UTC-day window containing `referenceDate`
 * (default: now). Built from `Date.UTC` with the UTC calendar getters, so
 * the boundary is always the UTC midnight for that day regardless of the
 * server's local timezone — the fix for settlement windows silently
 * shifting across daylight-saving transitions or non-UTC hosts.
 */
export function getUtcDailySettlementWindow(referenceDate: Date = new Date()): {
  startUtc: Date;
  endUtc: Date;
} {
  const startUtc = new Date(
    Date.UTC(
      referenceDate.getUTCFullYear(),
      referenceDate.getUTCMonth(),
      referenceDate.getUTCDate()
    )
  );
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

export function calculateMerchantSettlements(
  orders: readonly CompletedMerchantOrder[],
  periodStart: Date,
  periodEnd: Date,
  platformFeeBps: bigint = 250n
): MerchantBatchSettlement[] {
  if (periodStart >= periodEnd) throw new Error("periodStart must be before periodEnd");
  if (platformFeeBps < 0n || platformFeeBps > 10_000n) {
    throw new Error("platformFeeBps must be between 0 and 10000");
  }

  const groups = new Map<string, CompletedMerchantOrder[]>();
  for (const order of orders) {
    // Both bounds compare the order's `completedAt` instant directly against
    // `periodStart`/`periodEnd` Date objects — `Date` comparison is instant
    // (epoch-ms) based and therefore already timezone-agnostic. The window
    // itself must still be constructed from explicit UTC boundaries (see
    // `getUtcDailySettlementWindow`); this function trusts the caller to
    // pass UTC-aligned bounds rather than re-deriving local-time ones here.
    if (
      order.status !== "completed" ||
      order.completedAt < periodStart ||
      order.completedAt >= periodEnd
    ) {
      continue;
    }
    if (order.grossAmount < 0n) throw new Error(`negative gross amount for ${order.orderId}`);
    const key = `${order.merchantId}\u0000${order.payoutAddress}`;
    const group = groups.get(key) ?? [];
    group.push(order);
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((a, b) => a[0]!.merchantId.localeCompare(b[0]!.merchantId))
    .map((group) => {
      const totalGrossAmount = group.reduce((sum, order) => sum + order.grossAmount, 0n);
      const platformFees = (totalGrossAmount * platformFeeBps) / 10_000n;
      return {
        settlementId: `settlement-${group[0]!.merchantId}-${periodStart.toISOString().slice(0, 10)}`,
        merchantId: group[0]!.merchantId,
        payoutAddress: group[0]!.payoutAddress,
        periodStart,
        periodEnd,
        totalGrossAmount,
        platformFees,
        netDisbursement: totalGrossAmount - platformFees,
        orderCount: group.length,
        orderIds: group.map((order) => order.orderId).sort(),
      };
    });
}

/** Converts calculated settlements into the UTC-explicit window shape. */
export function toDailySettlementWindows(
  settlements: readonly MerchantBatchSettlement[]
): DailySettlementWindow[] {
  return settlements.map((s) => ({
    merchantId: s.merchantId,
    startUtc: s.periodStart,
    endUtc: s.periodEnd,
    totalGrossStroops: s.totalGrossAmount,
    totalFeeStroops: s.platformFees,
    netPayoutStroops: s.netDisbursement,
  }));
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function settlementCsv(settlements: readonly MerchantBatchSettlement[]): string {
  const header =
    "settlementId,merchantId,payoutAddress,periodStart,periodEnd,totalGrossAmount,platformFees,netDisbursement,orderCount,orderIds";
  const rows = settlements.map((s) =>
    [
      s.settlementId,
      s.merchantId,
      s.payoutAddress,
      s.periodStart.toISOString(),
      s.periodEnd.toISOString(),
      s.totalGrossAmount.toString(),
      s.platformFees.toString(),
      s.netDisbursement.toString(),
      String(s.orderCount),
      s.orderIds.join("|"),
    ]
      .map(csvCell)
      .join(",")
  );
  return [header, ...rows].join("\n") + "\n";
}
