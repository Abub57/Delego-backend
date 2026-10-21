/**
 * Cloud Cost Optimization Engine
 * Main Orchestrator Module
 * 
 * Integrates all cost optimization services:
 * - Multi-cloud billing ingestion
 * - Resource rightsizing recommendations
 * - Schedule-based resource cycling
 * - Cost anomaly detection
 * - Budget management and alerting
 * - Tag compliance enforcement
 */

import { BillingIngestionService } from './billing/ingestion';
import { RightsizingEngine } from './optimization/rightsizing';
import { ResourceScheduler } from './scheduling/scheduler';
import { CostAnomalyDetector } from './anomaly/detector';
import { BudgetManager } from './budget/manager';
import { TagComplianceService } from './tags/compliance';
import {
  CloudProvider,
  BillingConfig,
  ResourceSchedule,
  Budget,
  TagPolicy,
  CostOptimizationReport
} from './types';

/**
 * Configuration for the cost optimization engine
 */
export interface CostEngineConfig {
  // Billing configuration per provider
  billingConfigs: BillingConfig[];
  
  // Resource schedules for non-prod environments
  resourceSchedules: ResourceSchedule[];
  
  // Budget definitions
  budgets: Budget[];
  
  // Tag compliance policies
  tagPolicies: TagPolicy[];
  
  // Feature flags
  features: {
    billingIngestion: boolean;
    rightsizing: boolean;
    scheduling: boolean;
    anomalyDetection: boolean;
    budgetAlerts: boolean;
    tagCompliance: boolean;
  };
  
  // Execution intervals (cron expressions)
  intervals: {
    billingIngestion: string;  // Default: "0 */6 * * *" (every 6 hours)
    rightsizing: string;        // Default: "0 2 * * *" (daily at 2 AM)
    anomalyDetection: string;   // Default: "0 * * * *" (hourly)
    budgetCheck: string;        // Default: "0 */4 * * *" (every 4 hours)
    tagCompliance: string;      // Default: "0 3 * * *" (daily at 3 AM)
  };
}

/**
 * Main Cloud Cost Optimization Engine
 */
export class CostOptimizationEngine {
  private billingService: BillingIngestionService;
  private rightsizingEngine: RightsizingEngine;
  private scheduler: ResourceScheduler;
  private anomalyDetector: CostAnomalyDetector;
  private budgetManager: BudgetManager;
  private tagComplianceService: TagComplianceService;
  private config: CostEngineConfig;
  private isRunning: boolean = false;

  constructor(config: CostEngineConfig) {
    this.config = config;

    // Initialize services
    this.billingService = new BillingIngestionService(config.billingConfigs);
    this.rightsizingEngine = new RightsizingEngine();
    this.scheduler = new ResourceScheduler(config.resourceSchedules);
    this.anomalyDetector = new CostAnomalyDetector();
    this.budgetManager = new BudgetManager(config.budgets);
    this.tagComplianceService = new TagComplianceService(config.tagPolicies);
  }

  /**
   * Start the cost optimization engine
   * Begins all background processes based on configured intervals
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Cost optimization engine is already running');
      return;
    }

    console.log('Starting Cloud Cost Optimization Engine...');
    this.isRunning = true;

    // Run initial scans immediately
    await this.runInitialScans();

    // Schedule periodic tasks
    this.schedulePeriodicTasks();

    console.log('Cost optimization engine started successfully');
  }

  /**
   * Stop the cost optimization engine
   */
  stop(): void {
    if (!this.isRunning) {
      console.log('Cost optimization engine is not running');
      return;
    }

    console.log('Stopping Cloud Cost Optimization Engine...');
    this.isRunning = false;

    // In production, clear all intervals/timers here
    console.log('Cost optimization engine stopped');
  }

  /**
   * Run initial scans on startup
   */
  private async runInitialScans(): Promise<void> {
    const tasks: Promise<void>[] = [];

    if (this.config.features.billingIngestion) {
      tasks.push(this.runBillingIngestion());
    }

    if (this.config.features.rightsizing) {
      tasks.push(this.runRightsizingAnalysis());
    }

    if (this.config.features.anomalyDetection) {
      tasks.push(this.runAnomalyDetection());
    }

    if (this.config.features.budgetAlerts) {
      tasks.push(this.runBudgetCheck());
    }

    if (this.config.features.tagCompliance) {
      tasks.push(this.runTagCompliance());
    }

    await Promise.allSettled(tasks);
  }

  /**
   * Schedule periodic tasks based on configured intervals
   */
  private schedulePeriodicTasks(): void {
    // In production, use node-cron or similar for cron expression parsing
    // Mock implementation using setInterval

    if (this.config.features.billingIngestion) {
      setInterval(() => this.runBillingIngestion(), 6 * 60 * 60 * 1000); // 6 hours
    }

    if (this.config.features.rightsizing) {
      setInterval(() => this.runRightsizingAnalysis(), 24 * 60 * 60 * 1000); // 24 hours
    }

    if (this.config.features.anomalyDetection) {
      setInterval(() => this.runAnomalyDetection(), 60 * 60 * 1000); // 1 hour
    }

    if (this.config.features.budgetAlerts) {
      setInterval(() => this.runBudgetCheck(), 4 * 60 * 60 * 1000); // 4 hours
    }

    if (this.config.features.tagCompliance) {
      setInterval(() => this.runTagCompliance(), 24 * 60 * 60 * 1000); // 24 hours
    }

    if (this.config.features.scheduling) {
      // Resource scheduling runs more frequently to handle cron schedules
      setInterval(() => this.runResourceScheduling(), 5 * 60 * 1000); // 5 minutes
    }
  }

  /**
   * Run billing data ingestion
   */
  private async runBillingIngestion(): Promise<void> {
    try {
      console.log('[Billing] Starting ingestion...');
      const records = await this.billingService.ingestAllProviders();
      console.log(`[Billing] Ingested ${records.length} records`);
    } catch (error) {
      console.error('[Billing] Ingestion failed:', error);
    }
  }

  /**
   * Run rightsizing analysis
   */
  private async runRightsizingAnalysis(): Promise<void> {
    try {
      console.log('[Rightsizing] Starting analysis...');
      
      // Get all resources from billing data
      const records = await this.billingService.ingestAllProviders();
      const resources = this.extractResourcesFromBilling(records);
      
      // Analyze each resource
      const recommendations = [];
      for (const resource of resources) {
        const rec = await this.rightsizingEngine.analyzeResource(
          resource,
          'VM' // In production, determine from resource metadata
        );
        if (rec) {
          recommendations.push(rec);
        }
      }

      // Identify idle resources
      const idleResources = await this.rightsizingEngine.identifyIdleResources(resources);

      console.log(`[Rightsizing] Generated ${recommendations.length} recommendations`);
      console.log(`[Rightsizing] Found ${idleResources.length} idle resources`);
      
      // In production, store recommendations in database for dashboard
    } catch (error) {
      console.error('[Rightsizing] Analysis failed:', error);
    }
  }

  /**
   * Run resource scheduling
   */
  private async runResourceScheduling(): Promise<void> {
    try {
      const executed = await this.scheduler.executeSchedules();
      if (executed > 0) {
        console.log(`[Scheduling] Executed ${executed} schedules`);
      }
    } catch (error) {
      console.error('[Scheduling] Execution failed:', error);
    }
  }

  /**
   * Run anomaly detection
   */
  private async runAnomalyDetection(): Promise<void> {
    try {
      console.log('[Anomaly] Starting detection...');
      
      const records = await this.billingService.ingestAllProviders();
      const anomalies = await this.anomalyDetector.detectAnomalies(records);

      if (anomalies.length > 0) {
        console.log(`[Anomaly] Detected ${anomalies.length} anomalies`);
        
        // Send alerts for high/critical anomalies
        const critical = anomalies.filter(a => a.severity === 'HIGH' || a.severity === 'CRITICAL');
        if (critical.length > 0) {
          console.log(`[Anomaly] ALERT: ${critical.length} critical anomalies detected!`);
          // In production, send to alerting system
        }
      }
    } catch (error) {
      console.error('[Anomaly] Detection failed:', error);
    }
  }

  /**
   * Run budget checks
   */
  private async runBudgetCheck(): Promise<void> {
    try {
      console.log('[Budget] Checking budgets...');
      
      const records = await this.billingService.ingestAllProviders();
      const alerts = await this.budgetManager.checkBudgets(records);

      if (alerts.length > 0) {
        console.log(`[Budget] Generated ${alerts.length} alerts`);
        
        // In production, send alerts via configured channels
        for (const alert of alerts) {
          console.log(`[Budget] ${alert.severity}: ${alert.message}`);
        }
      }
    } catch (error) {
      console.error('[Budget] Check failed:', error);
    }
  }

  /**
   * Run tag compliance scan
   */
  private async runTagCompliance(): Promise<void> {
    try {
      console.log('[Tags] Starting compliance scan...');
      
      const providers: CloudProvider[] = this.config.billingConfigs.map(c => c.provider);
      const result = await this.tagComplianceService.scanAndRemediate(providers, true);

      console.log(`[Tags] Compliance rate: ${result.report.complianceRate.toFixed(2)}%`);
      console.log(`[Tags] Generated ${result.actions.length} remediation actions`);
      
      if (result.executionResults) {
        console.log(`[Tags] Executed: ${result.executionResults.successful} successful, ${result.executionResults.failed} failed`);
      }
    } catch (error) {
      console.error('[Tags] Compliance scan failed:', error);
    }
  }

  /**
   * Generate comprehensive cost optimization report
   */
  async generateReport(): Promise<CostOptimizationReport> {
    console.log('[Report] Generating comprehensive cost optimization report...');

    const providers: CloudProvider[] = this.config.billingConfigs.map(c => c.provider);
    
    // Gather data from all services
    const [
      billingRecords,
      tagComplianceReport
    ] = await Promise.all([
      this.billingService.ingestAllProviders(),
      this.tagComplianceService.scanAndReport(providers)
    ]);

    // Extract resources and analyze
    const resources = this.extractResourcesFromBilling(billingRecords);
    const rightsizingRecommendations = [];
    for (const resource of resources.slice(0, 100)) { // Limit for performance
      const rec = await this.rightsizingEngine.analyzeResource(resource, 'VM');
      if (rec) {
        rightsizingRecommendations.push(rec);
      }
    }

    const idleResources = await this.rightsizingEngine.identifyIdleResources(resources);
    const anomalies = await this.anomalyDetector.detectAnomalies(billingRecords);
    const budgetAlerts = await this.budgetManager.checkBudgets(billingRecords);

    // Calculate total costs
    const totalCost = billingRecords.reduce((sum, r) => sum + r.cost, 0);
    const potentialSavings = rightsizingRecommendations.reduce((sum, r) => 
      sum + r.estimatedMonthlySavings, 0
    ) + idleResources.reduce((sum, r) => sum + r.estimatedMonthlySavings, 0);

    const report: CostOptimizationReport = {
      generatedAt: new Date().toISOString(),
      period: {
        start: this.getStartOfMonth(),
        end: new Date().toISOString()
      },
      summary: {
        totalCost,
        potentialSavings,
        savingsPercentage: totalCost > 0 ? (potentialSavings / totalCost) * 100 : 0,
        activeRecommendations: rightsizingRecommendations.length + idleResources.length,
        criticalAnomalies: anomalies.filter(a => a.severity === 'CRITICAL').length,
        budgetAlerts: budgetAlerts.filter(a => a.severity === 'CRITICAL' || a.severity === 'HIGH').length,
        complianceRate: tagComplianceReport.complianceRate
      },
      billing: {
        totalRecords: billingRecords.length,
        costsByProvider: this.groupCostsByProvider(billingRecords),
        costsByService: this.groupCostsByService(billingRecords),
        topCostResources: this.getTopCostResources(billingRecords, 10)
      },
      rightsizing: {
        totalRecommendations: rightsizingRecommendations.length,
        estimatedMonthlySavings: rightsizingRecommendations.reduce((sum, r) => 
          sum + r.estimatedMonthlySavings, 0
        ),
        recommendations: rightsizingRecommendations.slice(0, 10), // Top 10
        idleResources: idleResources.slice(0, 10) // Top 10
      },
      anomalies: {
        totalDetected: anomalies.length,
        bySeverity: {
          CRITICAL: anomalies.filter(a => a.severity === 'CRITICAL').length,
          HIGH: anomalies.filter(a => a.severity === 'HIGH').length,
          MEDIUM: anomalies.filter(a => a.severity === 'MEDIUM').length,
          LOW: anomalies.filter(a => a.severity === 'LOW').length
        },
        recent: anomalies.slice(0, 10) // Most recent 10
      },
      budgets: {
        totalBudgets: this.config.budgets.length,
        alertsGenerated: budgetAlerts.length,
        budgetsAtRisk: budgetAlerts.filter(a => 
          a.severity === 'CRITICAL' || a.severity === 'HIGH'
        ).length,
        alerts: budgetAlerts.slice(0, 10) // Top 10
      },
      tagCompliance: {
        complianceRate: tagComplianceReport.complianceRate,
        totalResources: tagComplianceReport.totalResources,
        violations: tagComplianceReport.nonCompliantResources,
        topViolations: tagComplianceReport.violations.slice(0, 10) // Top 10
      }
    };

    console.log('[Report] Report generated successfully');
    return report;
  }

  // Helper methods

  private extractResourcesFromBilling(records: any[]): any[] {
    // Mock implementation - extract unique resources from billing records
    const resourceMap = new Map();
    
    for (const record of records) {
      if (!resourceMap.has(record.resourceId)) {
        resourceMap.set(record.resourceId, {
          resourceId: record.resourceId,
          provider: record.provider,
          region: record.region,
          tags: record.tags || {},
          metadata: {},
          metrics: {
            cpu: { average: 40, p95: 65, max: 85 },
            memory: { average: 50, p95: 70, max: 85 },
            network: { average: 100, p95: 200, max: 500 }
          },
          currentSize: 'large',
          monthlyCost: 0
        });
      }
      
      const resource = resourceMap.get(record.resourceId);
      resource.monthlyCost += record.cost;
    }

    return Array.from(resourceMap.values());
  }

  private groupCostsByProvider(records: any[]): Record<CloudProvider, number> {
    const grouped: Partial<Record<CloudProvider, number>> = {};
    
    for (const record of records) {
      grouped[record.provider] = (grouped[record.provider] || 0) + record.cost;
    }

    return grouped as Record<CloudProvider, number>;
  }

  private groupCostsByService(records: any[]): Record<string, number> {
    const grouped: Record<string, number> = {};
    
    for (const record of records) {
      const service = record.tags?.Service || 'Unknown';
      grouped[service] = (grouped[service] || 0) + record.cost;
    }

    return grouped;
  }

  private getTopCostResources(records: any[], limit: number): Array<{ resourceId: string; cost: number; provider: CloudProvider }> {
    const resourceCosts = new Map<string, { cost: number; provider: CloudProvider }>();
    
    for (const record of records) {
      const existing = resourceCosts.get(record.resourceId);
      if (existing) {
        existing.cost += record.cost;
      } else {
        resourceCosts.set(record.resourceId, {
          cost: record.cost,
          provider: record.provider
        });
      }
    }

    return Array.from(resourceCosts.entries())
      .map(([resourceId, data]) => ({ resourceId, ...data }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, limit);
  }

  private getStartOfMonth(): string {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }
}

/**
 * Create default configuration
 */
export function createDefaultConfig(): CostEngineConfig {
  return {
    billingConfigs: [],
    resourceSchedules: [],
    budgets: [],
    tagPolicies: [],
    features: {
      billingIngestion: true,
      rightsizing: true,
      scheduling: true,
      anomalyDetection: true,
      budgetAlerts: true,
      tagCompliance: true
    },
    intervals: {
      billingIngestion: '0 */6 * * *',
      rightsizing: '0 2 * * *',
      anomalyDetection: '0 * * * *',
      budgetCheck: '0 */4 * * *',
      tagCompliance: '0 3 * * *'
    }
  };
}

/**
 * Example usage:
 * 
 * const engine = new CostOptimizationEngine({
 *   billingConfigs: [
 *     { provider: 'AWS', credentials: {...}, options: {...} }
 *   ],
 *   resourceSchedules: [
 *     { scheduleId: 'dev-shutdown', resourceIds: [...], action: 'STOP', cronExpression: '0 18 * * 1-5' }
 *   ],
 *   budgets: [
 *     { id: 'eng-monthly', name: 'Engineering Monthly', ...}
 *   ],
 *   tagPolicies: [
 *     { id: 'required-tags', name: 'Required Cost Tags', ...}
 *   ],
 *   features: { ...all enabled... },
 *   intervals: { ...defaults... }
 * });
 * 
 * await engine.start();
 * const report = await engine.generateReport();
 */
