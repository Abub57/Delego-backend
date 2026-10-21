/**
 * Penetration Testing and Security Program Types
 * Issue #84
 */

export type PenTestSeverity = "critical" | "high" | "medium" | "low" | "info";
export type PenTestStatus =
  | "open"
  | "in_progress"
  | "fixed"
  | "verified"
  | "wont_fix"
  | "false_positive";

export interface PenTestScope {
  environments: string[];
  applications: string[];
  excludedPaths: string[];
  testTypes: ("network" | "web_app" | "api" | "mobile" | "cloud")[];
  rulesOfEngagement: string;
}

export interface PenTestFinding {
  id: string;
  title: string;
  severity: PenTestSeverity;
  cvssScore: number;
  cwe: string;
  description: string;
  impact: string;
  reproductionSteps: string[];
  remediation: string;
  status: PenTestStatus;
  discoveredAt: string;
  retestedAt?: string;
  dueDate?: string;
}

export interface PenTestSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface PenTestReport {
  id: string;
  scope: PenTestScope;
  findings: PenTestFinding[];
  summary: PenTestSummary;
  tester: string;
  assessmentType: "internal" | "external";
  startDate: string;
  endDate: string;
  retestRequired: boolean;
}

export interface BugBountyProgram {
  id: string;
  name: string;
  status: "active" | "paused" | "closed";
  rewards: Record<PenTestSeverity, { minUsd: number; maxUsd: number }>;
  policyUrl: string;
  inScopeTargets: string[];
  outOfScopeTargets: string[];
}

/** Emergency Kill-Switch Broadcast Signal (Issue #375) */
export interface EmergencyBroadcastSignal {
  action: "kill_session" | "pause_all_traffic" | "resume";
  targetId?: string;
  signedByAdmin: string;
  timestamp: number;
}
