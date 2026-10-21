/**
 * Tag Compliance Enforcement Module
 * 
 * Enforces cost allocation tag policies across multi-cloud resources
 * - Scans resources for missing/invalid tags
 * - Generates compliance reports
 * - Automated remediation actions
 * - Policy violation tracking
 */

import {
  CloudProvider,
  TagPolicy,
  ResourceTagCompliance,
  CloudResource,
  TagComplianceReport,
  TagRemediationAction
} from '../types';

/**
 * Tag Compliance Scanner
 * Scans cloud resources for tag policy violations
 */
export class TagComplianceScanner {
  private policies: Map<string, TagPolicy> = new Map();

  constructor(policies: TagPolicy[]) {
    policies.forEach(policy => this.policies.set(policy.id, policy));
  }

  /**
   * Scan all resources across providers for compliance
   */
  async scanCompliance(
    providers: CloudProvider[]
  ): Promise<TagComplianceReport> {
    const resources: CloudResource[] = [];
    
    // Fetch resources from all providers
    for (const provider of providers) {
      const providerResources = await this.fetchResources(provider);
      resources.push(...providerResources);
    }

    // Check each resource against policies
    const violations: ResourceTagCompliance[] = [];
    const compliant: ResourceTagCompliance[] = [];

    for (const resource of resources) {
      const compliance = this.checkResourceCompliance(resource);
      
      if (compliance.violations.length > 0) {
        violations.push(compliance);
      } else {
        compliant.push(compliance);
      }
    }

    const totalResources = resources.length;
    const violationCount = violations.length;
    const complianceRate = totalResources > 0 
      ? ((totalResources - violationCount) / totalResources) * 100 
      : 100;

    return {
      scanDate: new Date().toISOString(),
      totalResources,
      compliantResources: compliant.length,
      nonCompliantResources: violationCount,
      complianceRate,
      violations,
      compliant,
      summary: {
        byProvider: this.groupByProvider(violations),
        byPolicy: this.groupByPolicy(violations),
        criticalViolations: violations.filter(v => 
          v.violations.some(violation => 
            this.policies.get(violation.policyId)?.enforcement === 'BLOCK'
          )
        ).length
      }
    };
  }

  /**
   * Check single resource against all applicable policies
   */
  private checkResourceCompliance(resource: CloudResource): ResourceTagCompliance {
    const violations: Array<{
      policyId: string;
      policyName: string;
      missingTags: string[];
      invalidTags: Array<{ key: string; value: string; reason: string }>;
    }> = [];

    for (const [policyId, policy] of this.policies) {
      // Check if policy applies to this resource
      if (!this.policyApplies(policy, resource)) {
        continue;
      }

      const missingTags: string[] = [];
      const invalidTags: Array<{ key: string; value: string; reason: string }> = [];

      // Check required tags
      for (const requiredTag of policy.requiredTags) {
        const tagValue = resource.tags[requiredTag.key];

        if (!tagValue) {
          missingTags.push(requiredTag.key);
          continue;
        }

        // Validate against allowed values if specified
        if (requiredTag.allowedValues && requiredTag.allowedValues.length > 0) {
          if (!requiredTag.allowedValues.includes(tagValue)) {
            invalidTags.push({
              key: requiredTag.key,
              value: tagValue,
              reason: `Value must be one of: ${requiredTag.allowedValues.join(', ')}`
            });
          }
        }

        // Validate against pattern if specified
        if (requiredTag.pattern) {
          const regex = new RegExp(requiredTag.pattern);
          if (!regex.test(tagValue)) {
            invalidTags.push({
              key: requiredTag.key,
              value: tagValue,
              reason: `Value must match pattern: ${requiredTag.pattern}`
            });
          }
        }
      }

      if (missingTags.length > 0 || invalidTags.length > 0) {
        violations.push({
          policyId: policy.id,
          policyName: policy.name,
          missingTags,
          invalidTags
        });
      }
    }

    return {
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
      provider: resource.provider,
      region: resource.region,
      currentTags: resource.tags,
      violations,
      isCompliant: violations.length === 0,
      lastChecked: new Date().toISOString()
    };
  }

  /**
   * Check if policy applies to resource based on scope
   */
  private policyApplies(policy: TagPolicy, resource: CloudResource): boolean {
    // Check provider scope
    if (policy.scope.providers && policy.scope.providers.length > 0) {
      if (!policy.scope.providers.includes(resource.provider)) {
        return false;
      }
    }

    // Check resource type scope
    if (policy.scope.resourceTypes && policy.scope.resourceTypes.length > 0) {
      if (!policy.scope.resourceTypes.includes(resource.resourceType)) {
        return false;
      }
    }

    // Check region scope
    if (policy.scope.regions && policy.scope.regions.length > 0) {
      if (!policy.scope.regions.includes(resource.region)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Fetch resources from cloud provider
   * Mock implementation - replace with actual cloud SDK calls
   */
  private async fetchResources(provider: CloudProvider): Promise<CloudResource[]> {
    // Mock implementation
    const mockResources: CloudResource[] = [
      {
        resourceId: `${provider}-vm-001`,
        resourceType: 'VM',
        provider,
        region: provider === 'AWS' ? 'us-east-1' : provider === 'AZURE' ? 'eastus' : 'us-central1',
        tags: {
          Environment: 'production',
          CostCenter: 'engineering'
        },
        metadata: {
          size: 'large',
          state: 'running'
        }
      },
      {
        resourceId: `${provider}-db-001`,
        resourceType: 'DATABASE',
        provider,
        region: provider === 'AWS' ? 'us-east-1' : provider === 'AZURE' ? 'eastus' : 'us-central1',
        tags: {
          Environment: 'production'
          // Missing CostCenter tag
        },
        metadata: {
          engine: 'postgresql',
          state: 'available'
        }
      }
    ];

    return mockResources;
  }

  private groupByProvider(violations: ResourceTagCompliance[]): Record<CloudProvider, number> {
    const grouped: Partial<Record<CloudProvider, number>> = {};
    
    for (const violation of violations) {
      grouped[violation.provider] = (grouped[violation.provider] || 0) + 1;
    }

    return grouped as Record<CloudProvider, number>;
  }

  private groupByPolicy(violations: ResourceTagCompliance[]): Record<string, number> {
    const grouped: Record<string, number> = {};
    
    for (const violation of violations) {
      for (const v of violation.violations) {
        grouped[v.policyName] = (grouped[v.policyName] || 0) + 1;
      }
    }

    return grouped;
  }
}

/**
 * Tag Remediation Engine
 * Automatically fixes tag violations based on policy enforcement level
 */
export class TagRemediationEngine {
  private scanner: TagComplianceScanner;

  constructor(policies: TagPolicy[]) {
    this.scanner = new TagComplianceScanner(policies);
  }

  /**
   * Generate remediation actions for violations
   */
  async generateRemediationActions(
    report: TagComplianceReport
  ): Promise<TagRemediationAction[]> {
    const actions: TagRemediationAction[] = [];

    for (const violation of report.violations) {
      for (const v of violation.violations) {
        // Determine action based on enforcement level
        const action = this.createRemediationAction(violation, v);
        if (action) {
          actions.push(action);
        }
      }
    }

    return actions;
  }

  /**
   * Execute remediation actions
   */
  async executeRemediation(
    actions: TagRemediationAction[]
  ): Promise<{ successful: number; failed: number; results: Array<{ action: TagRemediationAction; success: boolean; error?: string }> }> {
    const results: Array<{ action: TagRemediationAction; success: boolean; error?: string }> = [];
    let successful = 0;
    let failed = 0;

    for (const action of actions) {
      try {
        await this.executeAction(action);
        results.push({ action, success: true });
        successful++;
      } catch (error) {
        results.push({ 
          action, 
          success: false, 
          error: error instanceof Error ? error.message : 'Unknown error' 
        });
        failed++;
      }
    }

    return { successful, failed, results };
  }

  /**
   * Create remediation action for violation
   */
  private createRemediationAction(
    violation: ResourceTagCompliance,
    policyViolation: {
      policyId: string;
      policyName: string;
      missingTags: string[];
      invalidTags: Array<{ key: string; value: string; reason: string }>;
    }
  ): TagRemediationAction | null {
    // For missing tags, propose adding default values
    if (policyViolation.missingTags.length > 0) {
      return {
        resourceId: violation.resourceId,
        resourceType: violation.resourceType,
        provider: violation.provider,
        action: 'ADD_TAGS',
        tags: this.getDefaultTags(policyViolation.missingTags),
        reason: `Missing required tags: ${policyViolation.missingTags.join(', ')}`,
        policyId: policyViolation.policyId,
        status: 'PENDING',
        createdAt: new Date().toISOString()
      };
    }

    // For invalid tags, propose corrections
    if (policyViolation.invalidTags.length > 0) {
      const tags: Record<string, string> = {};
      for (const invalid of policyViolation.invalidTags) {
        tags[invalid.key] = this.suggestCorrection(invalid.key, invalid.value);
      }

      return {
        resourceId: violation.resourceId,
        resourceType: violation.resourceType,
        provider: violation.provider,
        action: 'UPDATE_TAGS',
        tags,
        reason: `Invalid tag values: ${policyViolation.invalidTags.map(t => t.key).join(', ')}`,
        policyId: policyViolation.policyId,
        status: 'PENDING',
        createdAt: new Date().toISOString()
      };
    }

    return null;
  }

  /**
   * Execute single remediation action
   * Mock implementation - replace with actual cloud SDK calls
   */
  private async executeAction(action: TagRemediationAction): Promise<void> {
    // Mock implementation
    console.log(`[${action.provider}] ${action.action} on ${action.resourceId}:`, action.tags);
    
    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 100));

    // In production, use actual cloud SDK:
    // - AWS: ec2.createTags() or resourcegroupstaggingapi.tagResources()
    // - Azure: resourceClient.tags.createOrUpdateAtScope()
    // - GCP: compute.instances.setLabels() or resourcemanager.projects.setIamPolicy()
  }

  /**
   * Get default values for missing tags
   */
  private getDefaultTags(missingTags: string[]): Record<string, string> {
    const defaults: Record<string, string> = {
      'CostCenter': 'unallocated',
      'Environment': 'unknown',
      'Owner': 'unassigned',
      'Project': 'legacy',
      'Application': 'unknown'
    };

    const tags: Record<string, string> = {};
    for (const tag of missingTags) {
      tags[tag] = defaults[tag] || 'unknown';
    }

    return tags;
  }

  /**
   * Suggest correction for invalid tag value
   */
  private suggestCorrection(key: string, value: string): string {
    // Simple correction logic - can be enhanced with ML
    const corrections: Record<string, Record<string, string>> = {
      'Environment': {
        'prod': 'production',
        'dev': 'development',
        'stg': 'staging',
        'test': 'testing'
      }
    };

    return corrections[key]?.[value.toLowerCase()] || value;
  }
}

/**
 * Tag Compliance Service
 * Main orchestrator for tag compliance operations
 */
export class TagComplianceService {
  private scanner: TagComplianceScanner;
  private remediation: TagRemediationEngine;
  private policies: TagPolicy[];

  constructor(policies: TagPolicy[]) {
    this.policies = policies;
    this.scanner = new TagComplianceScanner(policies);
    this.remediation = new TagRemediationEngine(policies);
  }

  /**
   * Run full compliance scan and generate report
   */
  async scanAndReport(providers: CloudProvider[]): Promise<TagComplianceReport> {
    return await this.scanner.scanCompliance(providers);
  }

  /**
   * Scan, identify violations, and auto-remediate based on policy
   */
  async scanAndRemediate(
    providers: CloudProvider[],
    autoExecute: boolean = false
  ): Promise<{
    report: TagComplianceReport;
    actions: TagRemediationAction[];
    executionResults?: { successful: number; failed: number };
  }> {
    // Scan for violations
    const report = await this.scanner.scanCompliance(providers);

    // Generate remediation actions
    const actions = await this.remediation.generateRemediationActions(report);

    // Execute if requested
    let executionResults;
    if (autoExecute && actions.length > 0) {
      const results = await this.remediation.executeRemediation(actions);
      executionResults = {
        successful: results.successful,
        failed: results.failed
      };
    }

    return {
      report,
      actions,
      executionResults
    };
  }

  /**
   * Add or update tag policy
   */
  addPolicy(policy: TagPolicy): void {
    const existingIndex = this.policies.findIndex(p => p.id === policy.id);
    if (existingIndex >= 0) {
      this.policies[existingIndex] = policy;
    } else {
      this.policies.push(policy);
    }

    // Recreate scanner and remediation with updated policies
    this.scanner = new TagComplianceScanner(this.policies);
    this.remediation = new TagRemediationEngine(this.policies);
  }

  /**
   * Get compliance trend over time
   */
  async getComplianceTrend(
    providers: CloudProvider[],
    days: number = 30
  ): Promise<Array<{ date: string; complianceRate: number; violations: number }>> {
    // Mock implementation - in production, fetch from historical data
    const trend: Array<{ date: string; complianceRate: number; violations: number }> = [];
    
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      trend.push({
        date: date.toISOString().split('T')[0],
        complianceRate: 70 + Math.random() * 20, // Mock data
        violations: Math.floor(50 + Math.random() * 30) // Mock data
      });
    }

    return trend;
  }
}
