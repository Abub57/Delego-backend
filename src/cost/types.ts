/**
 * Cloud Cost Optimization Engine - Type Definitions
 * 
 * Comprehensive type system for multi-cloud cost management,
 * resource optimization, and budget tracking.
 */

// ─── Cloud Provider Types ───────────────────────────────────────────────────

export type CloudProvider = "aws" | "azure" | "gcp";

export type ResourceType =
  | "compute"
  | "database"
  | "storage"
  | "network"
  | "container"
  | "serverless"
  | "other";

export type Environment = "production" | "staging" | "development" | "test";

// ─── Billing & Cost Types ───────────────────────────────────────────────────

export interface BillingRecord {
  id: string;
  provider: CloudProvider;
  accountId: string;
  serviceCategory: string;
  serviceName: string;
  resourceId: string;
  resourceType: ResourceType;
  usageType: string;
  operation: string;
  region: string;
  cost: number;
  currency: string;
  usageAmount: number;
  usageUnit: string;
  startTime: Date;
  endTime: Date;
  tags: Record<string, string>;
  metadata: Record<string, unknown>;
}

export interface CostBreakdown {
  total: number;
  currency: string;
  byProvider: Record<CloudProvider, number>;
  byService: Record<string, number>;
  byEnvironment: Record<Environment, number>;
  byResourceType: Record<ResourceType, number>;
  byRegion: Record<string, number>;
  byTag: Record<string, number>;
  trend: {
    daily: number[];
    weekly: number[];
    monthly: number[];
  };
}

// ─── Resource Optimization Types ────────────────────────────────────────────

export interface ResourceMetrics {
  resourceId: string;
  resourceType: ResourceType;
  provider: CloudProvider;
  cpuUtilization: number; // percentage 0-100
  memoryUtilization: number; // percentage 0-100
  networkIn: number; // bytes
  networkOut: number; // bytes
  diskIOPS: number;
  diskThroughput: number; // MB/s
  requestCount?: number;
  errorRate?: number;
  timestamp: Date;
}

export interface RightsizingRecommendation {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: ResourceType;
  provider: CloudProvider;
  currentInstanceType: string;
  recommendedInstanceType: string;
  currentMonthlyCost: number;
  estimatedMonthlyCost: number;
  monthlySavings: number;
  savingsPercentage: number;
  confidence: "high" | "medium" | "low";
  reason: string;
  metrics: {
    avgCpuUtilization: number;
    avgMemoryUtilization: number;
    peakCpuUtilization: number;
    peakMemoryUtilization: number;
    daysAnalyzed: number;
  };
  risks: string[];
  implementationSteps: string[];
  createdAt: Date;
  status: "pending" | "approved" | "applied" | "rejected";
}

export interface IdleResource {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: ResourceType;
  provider: CloudProvider;
  monthlyCost: number;
  idleDurationHours: number;
  lastActivityTime: Date;
  reason: string;
  recommendation: "terminate" | "stop" | "snapshot" | "review";
  confidence: number;
  createdAt: Date;
}

// ─── Resource Scheduling Types ──────────────────────────────────────────────

export interface ResourceSchedule {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: ResourceType;
  provider: CloudProvider;
  environment: Environment;
  scheduleType: "daily" | "weekly" | "custom";
  timezone: string;
  startCron: string; // Cron expression for start time
  stopCron: string; // Cron expression for stop time
  enabled: boolean;
  tags: Record<string, string>;
  estimatedMonthlySavings: number;
  createdAt: Date;
  updatedAt: Date;
  lastExecuted?: Date;
}

export interface ScheduleExecution {
  id: string;
  scheduleId: string;
  resourceId: string;
  action: "start" | "stop";
  scheduledTime: Date;
  executionTime: Date;
  status: "success" | "failed" | "skipped";
  error?: string;
  costSaved?: number;
}

// ─── Anomaly Detection Types ────────────────────────────────────────────────

export interface CostAnomaly {
  id: string;
  detectedAt: Date;
  resourceId?: string;
  resourceName?: string;
  service: string;
  provider: CloudProvider;
  anomalyType: "spike" | "trend" | "pattern" | "unexpected";
  severity: "critical" | "high" | "medium" | "low";
  expectedCost: number;
  actualCost: number;
  deviation: number; // percentage
  confidence: number; // 0-1
  timeWindow: {
    start: Date;
    end: Date;
  };
  possibleCauses: string[];
  recommendations: string[];
  status: "new" | "investigating" | "resolved" | "false_positive";
  assignedTo?: string;
  resolvedAt?: Date;
  notes?: string;
}

export interface AnomalyDetectionConfig {
  enabled: boolean;
  checkIntervalMinutes: number;
  thresholds: {
    spikePercentage: number; // e.g., 50 for 50% increase
    trendDays: number; // Number of days to analyze for trends
    minCostThreshold: number; // Ignore anomalies below this cost
  };
  notifications: {
    email: boolean;
    slack: boolean;
    pagerduty: boolean;
    webhook?: string;
  };
  excludeServices: string[];
  excludeEnvironments: Environment[];
}

// ─── Budget Management Types ────────────────────────────────────────────────

export interface Budget {
  id: string;
  name: string;
  amount: number;
  currency: string;
  period: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
  startDate: Date;
  endDate?: Date;
  scope: {
    providers?: CloudProvider[];
    services?: string[];
    environments?: Environment[];
    tags?: Record<string, string>;
    resourceTypes?: ResourceType[];
  };
  thresholds: {
    percentage: number; // e.g., 80 for 80%
    alertChannels: ("email" | "slack" | "sms" | "webhook")[];
  }[];
  currentSpend: number;
  forecasted: number;
  variance: number; // actual - budget
  status: "on_track" | "warning" | "exceeded";
  alerts: BudgetAlert[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetAlert {
  id: string;
  budgetId: string;
  timestamp: Date;
  thresholdPercentage: number;
  actualSpend: number;
  budgetAmount: number;
  message: string;
  severity: "info" | "warning" | "critical";
  notificationsSent: {
    channel: string;
    timestamp: Date;
    success: boolean;
  }[];
}

// ─── Tag Compliance Types ───────────────────────────────────────────────────

export interface TagPolicy {
  id: string;
  name: string;
  description: string;
  requiredTags: {
    key: string;
    allowedValues?: string[];
    regex?: string;
    description: string;
  }[];
  scope: {
    providers: CloudProvider[];
    resourceTypes: ResourceType[];
    environments?: Environment[];
  };
  enforcement: "audit" | "enforce" | "quarantine";
  createdAt: Date;
  updatedAt: Date;
}

export interface TagComplianceReport {
  id: string;
  generatedAt: Date;
  totalResources: number;
  compliantResources: number;
  nonCompliantResources: number;
  compliancePercentage: number;
  violations: TagViolation[];
  byProvider: Record<CloudProvider, {
    total: number;
    compliant: number;
    nonCompliant: number;
  }>;
  byResourceType: Record<ResourceType, {
    total: number;
    compliant: number;
    nonCompliant: number;
  }>;
  estimatedUntaggedCost: number;
}

export interface TagViolation {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: ResourceType;
  provider: CloudProvider;
  missingTags: string[];
  invalidTags: {
    key: string;
    value: string;
    reason: string;
  }[];
  monthlyCost: number;
  owner?: string;
  detectedAt: Date;
  status: "new" | "remediated" | "exception_granted";
}

// ─── Commitment & Savings Plans Types ───────────────────────────────────────

export interface ReservedInstanceRecommendation {
  id: string;
  provider: CloudProvider;
  service: string;
  instanceType: string;
  region: string;
  term: "1year" | "3year";
  paymentOption: "no_upfront" | "partial_upfront" | "all_upfront";
  quantity: number;
  onDemandMonthlyCost: number;
  reservedMonthlyCost: number;
  monthlySavings: number;
  totalSavings: number;
  breakEvenMonths: number;
  utilizationBasedOn: {
    daysAnalyzed: number;
    avgUtilization: number;
  };
  confidence: "high" | "medium" | "low";
  createdAt: Date;
}

export interface SavingsPlan {
  id: string;
  planId: string;
  provider: CloudProvider;
  planType: "compute" | "ec2_instance" | "sagemaker";
  commitment: number;
  term: "1year" | "3year";
  paymentOption: "no_upfront" | "partial_upfront" | "all_upfront";
  startDate: Date;
  endDate: Date;
  utilizationPercentage: number;
  savings: number;
  status: "active" | "expired" | "pending";
}

// ─── Cost Allocation Types ──────────────────────────────────────────────────

export interface CostAllocation {
  id: string;
  period: Date;
  allocations: {
    department: string;
    team: string;
    project: string;
    environment: Environment;
    cost: number;
    percentage: number;
  }[];
  unallocatedCost: number;
  unallocatedPercentage: number;
  totalCost: number;
  allocationMethod: "tags" | "proportional" | "custom";
  generatedAt: Date;
}

// ─── Reporting Types ────────────────────────────────────────────────────────

export interface CostReport {
  id: string;
  reportType:
    | "monthly_summary"
    | "savings_opportunities"
    | "budget_performance"
    | "tag_compliance"
    | "anomaly_summary"
    | "custom";
  period: {
    start: Date;
    end: Date;
  };
  totalCost: number;
  currency: string;
  breakdown: CostBreakdown;
  insights: {
    category: string;
    message: string;
    impact: "high" | "medium" | "low";
    action?: string;
  }[];
  recommendations: {
    type: string;
    description: string;
    estimatedSavings: number;
    effort: "low" | "medium" | "high";
    priority: number;
  }[];
  generatedAt: Date;
  format: "json" | "pdf" | "csv" | "html";
  recipients?: string[];
}

// ─── Configuration Types ────────────────────────────────────────────────────

export interface CostOptimizationConfig {
  providers: {
    aws?: {
      enabled: boolean;
      accountIds: string[];
      regions: string[];
      costExplorerEnabled: boolean;
      trustedAdvisorEnabled: boolean;
      credentials: {
        accessKeyId?: string;
        secretAccessKey?: string;
        roleArn?: string;
      };
    };
    azure?: {
      enabled: boolean;
      subscriptionIds: string[];
      credentials: {
        clientId?: string;
        clientSecret?: string;
        tenantId?: string;
      };
    };
    gcp?: {
      enabled: boolean;
      projectIds: string[];
      billingAccountId: string;
      credentials: {
        type: string;
        project_id?: string;
        private_key?: string;
        client_email?: string;
      };
    };
  };
  features: {
    billingIngestion: {
      enabled: boolean;
      syncIntervalHours: number;
    };
    rightsizing: {
      enabled: boolean;
      analysisIntervalHours: number;
      minDaysOfData: number;
      autoApply: boolean;
    };
    scheduling: {
      enabled: boolean;
      environments: Environment[];
      defaultTimezone: string;
    };
    anomalyDetection: AnomalyDetectionConfig;
    budgetManagement: {
      enabled: boolean;
      checkIntervalMinutes: number;
    };
    tagCompliance: {
      enabled: boolean;
      policies: string[]; // Policy IDs
      scanIntervalHours: number;
    };
  };
  notifications: {
    email: {
      enabled: boolean;
      from: string;
      smtp: {
        host: string;
        port: number;
        secure: boolean;
        auth?: {
          user: string;
          pass: string;
        };
      };
    };
    slack: {
      enabled: boolean;
      webhookUrl?: string;
      channel?: string;
    };
    pagerduty: {
      enabled: boolean;
      apiKey?: string;
      serviceId?: string;
    };
  };
  database: {
    connectionString: string;
    poolSize: number;
  };
  cache: {
    enabled: boolean;
    ttlSeconds: number;
    redis?: {
      host: string;
      port: number;
      password?: string;
    };
  };
}

// ─── API Response Types ─────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  metadata?: {
    timestamp: Date;
    requestId: string;
    processingTime: number;
  };
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ─── Service Layer Types ────────────────────────────────────────────────────

export interface BillingIngestionResult {
  provider: CloudProvider;
  recordsIngested: number;
  totalCost: number;
  startDate: Date;
  endDate: Date;
  duration: number;
  errors: string[];
}

export interface RightsizingAnalysisResult {
  totalRecommendations: number;
  totalPotentialSavings: number;
  byConfidence: {
    high: number;
    medium: number;
    low: number;
  };
  byResourceType: Record<ResourceType, number>;
  recommendations: RightsizingRecommendation[];
}

export interface SchedulingExecutionResult {
  totalSchedules: number;
  executed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  totalCostSaved: number;
  executions: ScheduleExecution[];
}

// ─── Event Types ────────────────────────────────────────────────────────────

export type CostEventType =
  | "anomaly_detected"
  | "budget_threshold_reached"
  | "budget_exceeded"
  | "rightsizing_opportunity"
  | "idle_resource_detected"
  | "tag_violation"
  | "schedule_executed"
  | "commitment_expiring";

export interface CostEvent {
  id: string;
  type: CostEventType;
  timestamp: Date;
  provider: CloudProvider;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  metadata: Record<string, unknown>;
  actionRequired: boolean;
  actionUrl?: string;
}
