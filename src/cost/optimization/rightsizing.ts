/**
 * Resource Rightsizing Engine
 * 
 * Analyzes resource utilization metrics and generates recommendations
 * for downsizing over-provisioned resources or upgrading under-provisioned ones.
 */

import type {
  CloudProvider,
  ResourceMetrics,
  RightsizingRecommendation,
  RightsizingAnalysisResult,
  ResourceType,
} from "../types.js";

interface InstanceTypeSpec {
  name: string;
  vcpu: number;
  memory: number; // GB
  monthlyCost: number;
  hourly Cost: number;
  category: "burstable" | "general" | "compute" | "memory" | "storage";
}

/**
 * Instance type catalog for cost calculations
 * In production, fetch from cloud provider APIs
 */
const AWS_INSTANCE_TYPES: Record<string, InstanceTypeSpec> = {
  "t3.nano": { name: "t3.nano", vcpu: 2, memory: 0.5, monthlyCost: 3.80, hourlyCost: 0.0052, category: "burstable" },
  "t3.micro": { name: "t3.micro", vcpu: 2, memory: 1, monthlyCost: 7.59, hourlyCost: 0.0104, category: "burstable" },
  "t3.small": { name: "t3.small", vcpu: 2, memory: 2, monthlyCost: 15.18, hourlyCost: 0.0208, category: "burstable" },
  "t3.medium": { name: "t3.medium", vcpu: 2, memory: 4, monthlyCost: 30.37, hourlyCost: 0.0416, category: "burstable" },
  "t3.large": { name: "t3.large", vcpu: 2, memory: 8, monthlyCost: 60.74, hourlyCost: 0.0832, category: "burstable" },
  "t3.xlarge": { name: "t3.xlarge", vcpu: 4, memory: 16, monthlyCost: 121.47, hourlyCost: 0.1664, category: "burstable" },
  "t3.2xlarge": { name: "t3.2xlarge", vcpu: 8, memory: 32, monthlyCost: 242.94, hourlyCost: 0.3328, category: "burstable" },
  "m5.large": { name: "m5.large", vcpu: 2, memory: 8, monthlyCost: 70.08, hourlyCost: 0.096, category: "general" },
  "m5.xlarge": { name: "m5.xlarge", vcpu: 4, memory: 16, monthlyCost: 140.16, hourlyCost: 0.192, category: "general" },
  "m5.2xlarge": { name: "m5.2xlarge", vcpu: 8, memory: 32, monthlyCost: 280.32, hourlyCost: 0.384, category: "general" },
  "m5.4xlarge": { name: "m5.4xlarge", vcpu: 16, memory: 64, monthlyCost: 560.64, hourlyCost: 0.768, category: "general" },
  "c5.large": { name: "c5.large", vcpu: 2, memory: 4, monthlyCost: 62.64, hourlyCost: 0.085, category: "compute" },
  "c5.xlarge": { name: "c5.xlarge", vcpu: 4, memory: 8, monthlyCost: 125.28, hourlyCost: 0.17, category: "compute" },
  "c5.2xlarge": { name: "c5.2xlarge", vcpu: 8, memory: 16, monthlyCost: 250.56, hourlyCost: 0.34, category: "compute" },
  "r5.large": { name: "r5.large", vcpu: 2, memory: 16, monthlyCost: 91.98, hourlyCost: 0.126, category: "memory" },
  "r5.xlarge": { name: "r5.xlarge", vcpu: 4, memory: 32, monthlyCost: 183.96, hourlyCost: 0.252, category: "memory" },
  "r5.2xlarge": { name: "r5.2xlarge", vcpu: 8, memory: 64, monthlyCost: 367.92, hourlyCost: 0.504, category: "memory" },
};

export class RightsizingEngine {
  private provider: CloudProvider;
  private minDaysOfData: number;

  constructor(provider: CloudProvider, minDaysOfData: number = 14) {
    this.provider = provider;
    this.minDaysOfData = minDaysOfData;
  }

  /**
   * Analyze resource metrics and generate rightsizing recommendations
   */
  async analyzeResource(
    resourceId: string,
    resourceName: string,
    resourceType: ResourceType,
    currentInstanceType: string,
    metrics: ResourceMetrics[]
  ): Promise<RightsizingRecommendation | null> {
    // Validate sufficient data
    if (metrics.length < this.minDaysOfData) {
      console.log(`Insufficient data for ${resourceId}: ${metrics.length} days, need ${this.minDaysOfData}`);
      return null;
    }

    // Calculate utilization statistics
    const stats = this.calculateUtilizationStats(metrics);

    // Get current instance spec
    const currentSpec = this.getInstanceSpec(currentInstanceType);
    if (!currentSpec) {
      console.warn(`Unknown instance type: ${currentInstanceType}`);
      return null;
    }

    // Determine recommended instance type
    const recommendation = this.determineRecommendedInstance(
      currentSpec,
      stats,
      resourceType
    );

    if (!recommendation) {
      console.log(`No optimization opportunity for ${resourceId}`);
      return null;
    }

    // Calculate savings
    const monthlySavings = currentSpec.monthlyCost - recommendation.monthlyCost;
    const savingsPercentage = (monthlySavings / currentSpec.monthlyCost) * 100;

    // Only recommend if savings are significant (>10%) or cost reduction is >$10/month
    if (savingsPercentage < 10 && monthlySavings < 10) {
      return null;
    }

    // Determine confidence level
    const confidence = this.determineConfidence(stats, monthlySavings);

    // Identify risks
    const risks = this.identifyRisks(currentSpec, recommendation, stats);

    return {
      id: `rightsizing-${resourceId}-${Date.now()}`,
      resourceId,
      resourceName,
      resourceType,
      provider: this.provider,
      currentInstanceType,
      recommendedInstanceType: recommendation.name,
      currentMonthlyCost: currentSpec.monthlyCost,
      estimatedMonthlyCost: recommendation.monthlyCost,
      monthlySavings,
      savingsPercentage,
      confidence,
      reason: this.generateRecommendationReason(stats, currentSpec, recommendation),
      metrics: {
        avgCpuUtilization: stats.avgCpu,
        avgMemoryUtilization: stats.avgMemory,
        peakCpuUtilization: stats.peakCpu,
        peakMemoryUtilization: stats.peakMemory,
        daysAnalyzed: metrics.length,
      },
      risks,
      implementationSteps: this.generateImplementationSteps(
        resourceType,
        currentInstanceType,
        recommendation.name
      ),
      createdAt: new Date(),
      status: "pending",
    };
  }

  /**
   * Analyze multiple resources in batch
   */
  async analyzeResources(
    resources: Array<{
      resourceId: string;
      resourceName: string;
      resourceType: ResourceType;
      currentInstanceType: string;
      metrics: ResourceMetrics[];
    }>
  ): Promise<RightsizingAnalysisResult> {
    const recommendations: RightsizingRecommendation[] = [];
    
    for (const resource of resources) {
      const recommendation = await this.analyzeResource(
        resource.resourceId,
        resource.resourceName,
        resource.resourceType,
        resource.currentInstanceType,
        resource.metrics
      );

      if (recommendation) {
        recommendations.push(recommendation);
      }
    }

    // Calculate summary statistics
    const totalPotentialSavings = recommendations.reduce(
      (sum, rec) => sum + rec.monthlySavings,
      0
    );

    const byConfidence = recommendations.reduce(
      (acc, rec) => {
        acc[rec.confidence] = (acc[rec.confidence] || 0) + 1;
        return acc;
      },
      { high: 0, medium: 0, low: 0 }
    );

    const byResourceType = recommendations.reduce((acc, rec) => {
      acc[rec.resourceType] = (acc[rec.resourceType] || 0) + rec.monthlySavings;
      return acc;
    }, {} as Record<ResourceType, number>);

    return {
      totalRecommendations: recommendations.length,
      totalPotentialSavings,
      byConfidence,
      byResourceType,
      recommendations,
    };
  }

  /**
   * Calculate utilization statistics from metrics
   */
  private calculateUtilizationStats(metrics: ResourceMetrics[]): {
    avgCpu: number;
    avgMemory: number;
    peakCpu: number;
    peakMemory: number;
    p95Cpu: number;
    p95Memory: number;
    p99Cpu: number;
    p99Memory: number;
  } {
    const cpuValues = metrics.map((m) => m.cpuUtilization).sort((a, b) => a - b);
    const memoryValues = metrics.map((m) => m.memoryUtilization).sort((a, b) => a - b);

    const avgCpu = cpuValues.reduce((sum, val) => sum + val, 0) / cpuValues.length;
    const avgMemory = memoryValues.reduce((sum, val) => sum + val, 0) / memoryValues.length;

    const p95Index = Math.floor(cpuValues.length * 0.95);
    const p99Index = Math.floor(cpuValues.length * 0.99);

    return {
      avgCpu,
      avgMemory,
      peakCpu: Math.max(...cpuValues),
      peakMemory: Math.max(...memoryValues),
      p95Cpu: cpuValues[p95Index] || 0,
      p95Memory: memoryValues[p95Index] || 0,
      p99Cpu: cpuValues[p99Index] || 0,
      p99Memory: memoryValues[p99Index] || 0,
    };
  }

  /**
   * Determine recommended instance type based on utilization
   */
  private determineRecommendedInstance(
    currentSpec: InstanceTypeSpec,
    stats: ReturnType<typeof this.calculateUtilizationStats>,
    resourceType: ResourceType
  ): InstanceTypeSpec | null {
    // Strategy: Use p95 utilization for sizing recommendations
    // This provides headroom for spikes while avoiding over-provisioning

    const targetCpuUtilization = 70; // Target 70% CPU at p95
    const targetMemoryUtilization = 80; // Target 80% memory at p95

    // Calculate required resources based on current utilization
    const requiredVcpu = (currentSpec.vcpu * stats.p95Cpu) / targetCpuUtilization;
    const requiredMemory = (currentSpec.memory * stats.p95Memory) / targetMemoryUtilization;

    // Find best matching instance type
    const candidates = Object.values(AWS_INSTANCE_TYPES).filter((spec) => {
      // Must have sufficient CPU and memory
      const hasSufficientCpu = spec.vcpu >= requiredVcpu * 0.9; // 10% tolerance
      const hasSufficientMemory = spec.memory >= requiredMemory * 0.9;

      // Must be cheaper than current
      const isCheaper = spec.monthlyCost < currentSpec.monthlyCost;

      return hasSufficientCpu && hasSufficientMemory && isCheaper;
    });

    if (candidates.length === 0) {
      return null; // No suitable downgrade found
    }

    // Sort by cost and select cheapest that meets requirements
    candidates.sort((a, b) => a.monthlyCost - b.monthlyCost);

    // For compute-intensive workloads, prefer compute-optimized instances
    if (resourceType === "compute" && stats.avgCpu > stats.avgMemory) {
      const computeInstance = candidates.find((c) => c.category === "compute");
      if (computeInstance) return computeInstance;
    }

    // For memory-intensive workloads, prefer memory-optimized instances
    if (stats.avgMemory > stats.avgCpu * 1.5) {
      const memoryInstance = candidates.find((c) => c.category === "memory");
      if (memoryInstance) return memoryInstance;
    }

    // Default to cheapest general-purpose or burstable instance
    return candidates[0];
  }

  /**
   * Get instance specification
   */
  private getInstanceSpec(instanceType: string): InstanceTypeSpec | null {
    return AWS_INSTANCE_TYPES[instanceType] || null;
  }

  /**
   * Determine confidence level
   */
  private determineConfidence(
    stats: ReturnType<typeof this.calculateUtilizationStats>,
    savings: number
  ): "high" | "medium" | "low" {
    // High confidence: low utilization, consistent patterns, significant savings
    if (stats.avgCpu < 30 && stats.avgMemory < 40 && stats.peakCpu < 60 && savings > 50) {
      return "high";
    }

    // Medium confidence: moderate utilization or good savings
    if (stats.avgCpu < 50 && stats.avgMemory < 60 && savings > 20) {
      return "medium";
    }

    // Low confidence: higher utilization or small savings
    return "low";
  }

  /**
   * Identify potential risks
   */
  private identifyRisks(
    current: InstanceTypeSpec,
    recommended: InstanceTypeSpec,
    stats: ReturnType<typeof this.calculateUtilizationStats>
  ): string[] {
    const risks: string[] = [];

    // Check if downsize is aggressive
    const vcpuReduction = ((current.vcpu - recommended.vcpu) / current.vcpu) * 100;
    if (vcpuReduction > 50) {
      risks.push(`Significant vCPU reduction (${vcpuReduction.toFixed(0)}%) - may impact performance`);
    }

    // Check if peak utilization is high
    if (stats.peakCpu > 80) {
      risks.push(`Peak CPU utilization reached ${stats.peakCpu.toFixed(1)}% - ensure new instance can handle spikes`);
    }

    if (stats.peakMemory > 85) {
      risks.push(`Peak memory utilization reached ${stats.peakMemory.toFixed(1)}% - monitor for OOM events`);
    }

    // Check for burstable instance recommendation
    if (recommended.category === "burstable") {
      risks.push("Burstable instance may incur additional charges during sustained high CPU usage");
    }

    return risks;
  }

  /**
   * Generate human-readable recommendation reason
   */
  private generateRecommendationReason(
    stats: ReturnType<typeof this.calculateUtilizationStats>,
    current: InstanceTypeSpec,
    recommended: InstanceTypeSpec
  ): string {
    const cpuWaste = 100 - stats.avgCpu;
    const memoryWaste = 100 - stats.avgMemory;

    return `Resource is underutilized with average CPU at ${stats.avgCpu.toFixed(1)}% and memory at ${stats.avgMemory.toFixed(1)}%. ` +
      `Downsizing from ${current.name} (${current.vcpu} vCPU, ${current.memory}GB RAM) to ` +
      `${recommended.name} (${recommended.vcpu} vCPU, ${recommended.memory}GB RAM) will maintain performance ` +
      `while reducing costs by ${((current.monthlyCost - recommended.monthlyCost) / current.monthlyCost * 100).toFixed(1)}%.`;
  }

  /**
   * Generate implementation steps
   */
  private generateImplementationSteps(
    resourceType: ResourceType,
    currentType: string,
    recommendedType: string
  ): string[] {
    const steps: string[] = [
      "1. Review the recommendation and validate against your workload requirements",
      "2. Schedule the change during a maintenance window",
      "3. Create a snapshot/backup of the current resource",
      `4. Stop the ${resourceType} instance`,
      `5. Change instance type from ${currentType} to ${recommendedType}`,
      `6. Start the ${resourceType} instance`,
      "7. Monitor performance for 24-48 hours",
      "8. Verify application functionality and performance metrics",
      "9. Rollback if performance degrades (restore from snapshot)",
    ];

    return steps;
  }

  /**
   * Identify idle resources (near-zero utilization)
   */
  async identifyIdleResources(
    resources: Array<{
      resourceId: string;
      resourceName: string;
      resourceType: ResourceType;
      monthlyCost: number;
      metrics: ResourceMetrics[];
    }>
  ): Promise<Array<{
    resourceId: string;
    resourceName: string;
    resourceType: ResourceType;
    monthlyCost: number;
    avgCpuUtilization: number;
    avgMemoryUtilization: number;
    idleDurationHours: number;
    recommendation: "terminate" | "stop" | "snapshot";
  }>> {
    const idleResources = [];

    for (const resource of resources) {
      if (resource.metrics.length === 0) continue;

      const stats = this.calculateUtilizationStats(resource.metrics);

      // Consider idle if avg CPU < 5% and avg memory < 10%
      if (stats.avgCpu < 5 && stats.avgMemory < 10) {
        const idleDurationHours = resource.metrics.length * 24; // Assuming daily metrics

        idleResources.push({
          resourceId: resource.resourceId,
          resourceName: resource.resourceName,
          resourceType: resource.resourceType,
          monthlyCost: resource.monthlyCost,
          avgCpuUtilization: stats.avgCpu,
          avgMemoryUtilization: stats.avgMemory,
          idleDurationHours,
          recommendation: this.determineIdleRecommendation(
            resource.resourceType,
            stats,
            idleDurationHours
          ),
        });
      }
    }

    return idleResources;
  }

  /**
   * Determine what to do with idle resource
   */
  private determineIdleRecommendation(
    resourceType: ResourceType,
    stats: ReturnType<typeof this.calculateUtilizationStats>,
    idleHours: number
  ): "terminate" | "stop" | "snapshot" {
    // If completely idle for >7 days, recommend termination
    if (stats.peakCpu < 1 && stats.peakMemory < 5 && idleHours > 168) {
      return "terminate";
    }

    // If storage resource, recommend snapshot
    if (resourceType === "storage") {
      return "snapshot";
    }

    // Otherwise, recommend stopping
    return "stop";
  }
}
