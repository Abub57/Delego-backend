import { route, type Route } from "@delegolabs/utils";
import { getSpendSummaryHandler } from "./spendSummary.js";
import { getMerchantRevenueHandler } from "./merchantRevenue.js";
import { getRealtimeVisitorsHandler } from "./realtimeVisitors.js";
import {
  getFunnelMetricsHandler,
  getEngagementMetricsHandler,
  listABTestsHandler,
  createABTestHandler,
  getABTestHandler,
  updateABTestHandler,
  startABTestHandler,
  endABTestHandler,
  getCohortAnalysisHandler,
  trackCustomEventHandler,
  exportTransactionsCsvHandler,
  exportDataHandler,
  getRevenueMetricsHandler,
  getMerchantQualityScoreHandler,
  getMerchantSalesHandler,
  getMerchantDailyGmvHandler,
} from "./analyticsRoutes.js";
export function registerAnalyticsRoutes(): Route[] {
  return [
    route("GET", "/api/v1/analytics/spend-summary", getSpendSummaryHandler),
    // Funnel metrics
    route("GET", "/api/v1/analytics/funnel", getFunnelMetricsHandler),
    route("Get", "/api/v1/analytics/engagement", getEngagementMetricsHandler),

    // A/B tests
    route("GET", "/api/v1/analytics/ab-tests", listABTestsHandler),
    route("POST", "/api/v1/analytics/ab-tests", createABTestHandler),
    route("GET", "/api/v1/analytics/ab-tests/:id", getABTestHandler),
    route("PATCH", "/api/v1/analytics/ab-tests/:id", updateABTestHandler),
    route("POST", "/api/v1/analytics/ab-tests/:id/start", startABTestHandler),
    route("POST", "/api/v1/analytics/ab-tests/:id/end", endABTestHandler),

    // Cohort analysis
    route("Get", "/api/v1/analytics/cohorts", getCohortAnalysisHandler),

    // Custom events
    route("POST", "/api/v1/analytics/events", trackCustomEventHandler),

        // Revenue attribution
    route("GET", "/api/v1/analytics/revenue", getRevenueMetricsHandler),

    // Merchant reputation (#392)
    route("GET", "/api/v1/analytics/merchants/:merchantId/quality-score", getMerchantQualityScoreHandler),

    // Real-Time Merchant Continuous Aggregates (#377)
    route("GET", "/api/v1/analytics/merchants/:merchantId/sales", getMerchantSalesHandler),

    // Merchant daily GMV continuous aggregate (#377)
    route("GET", "/api/v1/analytics/merchants/:merchantId/daily-gmv", getMerchantDailyGmvHandler),

    // Merchant revenue reports: settled volume, fees and refunds by day/week/month
    route("Get", "/api/v1/merchant/analytics/revenue", getMerchantRevenueHandler),

    // Realtime unique storefront visitors (#578)
    route("GET", "/api/v1/analytics/realtime-visitors", getRealtimeVisitorsHandler),

    // Data export
    // Issue #395: memory-efficient chunked CSV streaming of transaction history.
    route("GET", "/api/v1/analytics/export/transactions.csv", exportTransactionsCsvHandler),
    route("POST", "/api/v1/analytics/export", exportDataHandler),
  ];
}
