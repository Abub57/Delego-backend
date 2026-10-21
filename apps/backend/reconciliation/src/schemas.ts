/**
 * Reconciliation API schemas
 */

export interface Address {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface ReconciliationJob {
  id: string;
  type: "daily" | "intraday" | "monthly" | "on_demand";
  status: "pending" | "running" | "completed" | "failed" | "partial";
  startDate: string;
  endDate: string;
  accounts: string[];
  totalRecords: number;
  matchedRecords: number;
  discrepancies: number;
  startedAt: string;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateReconciliationJobRequest {
  type: "daily" | "intraday" | "monthly" | "on_demand";
  startDate: string;
  endDate: string;
  accounts: string[];
  currency?: string;
}

export interface ReconciliationRecord {
  id: string;
  jobId: string;
  internalRecordId: string;
  externalRecordId?: string;
  status: "matched" | "unmatched_internal" | "unmatched_external" | "discrepancy";
  internalAmount: string;
  externalAmount?: string;
  currency: string;
  discrepancyType?: "amount" | "date" | "reference" | "fee" | "missing";
  discrepancyAmount?: string;
  resolution?: "auto_resolved" | "manual_resolved" | "investigating" | "write_off";
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResolveDiscrepancyRequest {
  resolution: "auto_resolved" | "manual_resolved" | "investigating" | "write_off";
  notes?: string;
  resolvedBy: string;
}

export interface ReconciliationReport {
  jobId: string;
  summary: {
    total: number;
    matched: number;
    discrepancies: number;
    unresolved: number;
    matchRate: number;
  };
  byType: Record<string, { count: number; amount: string }>;
  byCurrency: Record<string, { count: number; amount: string }>;
  topDiscrepancies: Array<{
    type: string;
    count: number;
    totalAmount: string;
  }>;
}

export interface ReconciliationSummary {
  totalJobs: number;
  completedJobs: number;
  pendingJobs: number;
  failedJobs: number;
  totalMatched: number;
  totalDiscrepancies: number;
  averageMatchRate: number;
  lastRun: string;
  nextRun?: string;
}

export interface DiscrepancyQuery {
  status?: "discrepancy" | "investigating" | "unresolved";
  type?: "amount" | "date" | "reference" | "fee" | "missing";
  currency?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

export interface ExchangeRate {
  from: string;
  to: string;
  rate: number;
  timestamp: string;
}

export interface AuditLog {
  id: string;
  jobId?: string;
  recordId?: string;
  action: string;
  details: Record<string, unknown>;
  userId?: string;
  timestamp: string;
}

export interface LedgerReconciliationDiscrepancy { escrowId: string; dbAmount: bigint; onChainAmount: bigint; difference: bigint; }

