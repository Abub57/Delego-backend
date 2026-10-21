export interface ContractLatencyMetric {
  contract: string;
  functionName: string;
  durationMs: number;
  success: boolean;
}
