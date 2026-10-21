/**
 * Analytics API request/response schemas
 */

// #392 — Merchant Reputation Weight Calculator types live in their own file
// (schemas.merchant-quality.ts) since they have their own request/response
// siblings unrelated to the notification-funnel schemas below.
export * from "./schemas.merchant-quality.js";

export interface FunnelMetricsQuery {
  templateId?: string;
  channel?: string;
  periodStart: string;
  periodEnd: string;
  userId?: string;
}

export interface FunnelMetricsResponse {
  templateId: string;
  channel: string;
  period: {
    start: string;
    end: string;
  };
  funnel: {
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    converted: number;
    unsubscribed: number;
    bounced: number;
    complained: number;
  };
  rates: {
    deliveryRate: number;
    openRate: number;
    clickRate: number;
    conversionRate: number;
    unsubscribeRate: number;
  };
  engagement: {
    avgTimeToOpen: number;
    avgTimeToClick: number;
    repeatOpens: number;
    repeatClicks: number;
  };
}

export interface EngagementMetricsQuery {
  templateId?: string;
  channel?: string;
  periodStart: string;
  periodEnd: string;
  userId?: string;
}

export interface EngagementMetricsResponse {
  templateId: string;
  channel: string;
  opens: number;
  clicks: number;
  conversions: number;
  avgTimeToOpen: number;
  avgTimeToClick: number;
  openByChannel: Record<string, number>;
  clickByChannel: Record<string, number>;
  repeatOpens: number;
  repeatClicks: number;
  topPerformingTemplates: Array<{
    templateId: string;
    openRate: number;
    clickRate: number;
  }>;
}

export interface ABTestCreateRequest {
  name: string;
  hypothesis: string;
  variants: Array<{
    name: string;
    templateId: string;
    trafficSplit: number;
  }>;
  startDate?: string;
  metadata?: Record<string, unknown>;
}

export interface ABTestUpdateRequest {
  name?: string;
  hypothesis?: string;
  status?: "draft" | "running" | "completed" | "archived";
  endDate?: string;
  metadata?: Record<string, unknown>;
}

export interface ABTestResponse {
  id: string;
  name: string;
  hypothesis: string;
  variants: Array<{
    id: string;
    name: string;
    templateId: string;
    trafficSplit: number;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
  }>;
  status: "draft" | "running" | "completed" | "archived";
  startDate: string;
  endDate?: string;
  results?: {
    winner: string;
    significance: number;
    confidenceInterval: [number, number];
  };
  createdAt: string;
  updatedAt: string;
}

export interface CohortAnalysisResponse {
  cohort: string;
  size: number;
  periods: Array<{
    period: number;
    retained: number;
    engagementRate: number;
    revenuePerUser: number;
  }>;
}

export interface CustomEventRequest {
  eventName: string;
  userId?: string;
  sessionId?: string;
  properties?: Record<string, unknown>;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface CustomEventResponse {
  id: string;
  eventName: string;
  userId?: string;
  sessionId?: string;
  timestamp: string;
}

export interface ExportRequest {
  type: "funnel" | "engagement" | "cohorts" | "ab-tests" | "custom";
  format?: "csv" | "json" | "parquet";
  destination: string;
  filters?: {
    templateId?: string;
    channel?: string;
    periodStart?: string;
    periodEnd?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface ExportResponse {
  id: string;
  exportType: string;
  format: string;
  status: string;
  destination: string;
  fileKey?: string;
  message: string;
}
