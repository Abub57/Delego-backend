/**
 * Resource Scheduling Engine
 * 
 * Automatically starts and stops non-production resources based on schedules
 * to reduce costs during off-hours (nights, weekends).
 */

import type {
  CloudProvider,
  Environment,
  ResourceSchedule,
  ScheduleExecution,
  SchedulingExecutionResult,
  ResourceType,
} from "../types.js";

/**
 * Cron parser for schedule expressions
 */
class CronParser {
  /**
   * Parse cron expression and get next execution time
   * Format: minute hour day-of-month month day-of-week
   * Example: "0 8 * * 1-5" = 8 AM weekdays
   */
  static getNextExecution(cronExpr: string, timezone: string = "UTC"): Date {
    // In production, use a library like 'cron-parser' or 'node-cron'
    // This is a simplified implementation
    
    const now = new Date();
    const parts = cronExpr.split(" ");
    
    if (parts.length !== 5) {
      throw new Error(`Invalid cron expression: ${cronExpr}`);
    }

    // For demo: simple parsing of hour
    const hour = parseInt(parts[1], 10);
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    
    return next;
  }

  /**
   * Check if current time matches cron schedule
   */
  static matches(cronExpr: string, time: Date): boolean {
    const parts = cronExpr.split(" ");
    const minute = parts[0];
    const hour = parts[1];
    
    const currentMinute = time.getMinutes();
    const currentHour = time.getHours();
    
    const minuteMatch = minute === "*" || parseInt(minute, 10) === currentMinute;
    const hourMatch = hour === "*" || parseInt(hour, 10) === currentHour;
    
    return minuteMatch && hourMatch;
  }
}

/**
 * Cloud-specific resource control implementations
 */
interface ResourceController {
  start(resourceId: string): Promise<boolean>;
  stop(resourceId: string): Promise<boolean>;
  getState(resourceId: string): Promise<"running" | "stopped" | "unknown">;
}

class AWSResourceController implements ResourceController {
  async start(resourceId: string): Promise<boolean> {
    try {
      console.log(`[AWS] Starting resource: ${resourceId}`);
      // In production: await ec2.startInstances({ InstanceIds: [resourceId] }).promise();
      return true;
    } catch (error) {
      console.error(`[AWS] Failed to start ${resourceId}:`, error);
      return false;
    }
  }

  async stop(resourceId: string): Promise<boolean> {
    try {
      console.log(`[AWS] Stopping resource: ${resourceId}`);
      // In production: await ec2.stopInstances({ InstanceIds: [resourceId] }).promise();
      return true;
    } catch (error) {
      console.error(`[AWS] Failed to stop ${resourceId}:`, error);
      return false;
    }
  }

  async getState(resourceId: string): Promise<"running" | "stopped" | "unknown"> {
    try {
      // In production: const result = await ec2.describeInstances({ InstanceIds: [resourceId] }).promise();
      // return result.Reservations[0].Instances[0].State.Name === 'running' ? 'running' : 'stopped';
      return Math.random() > 0.5 ? "running" : "stopped";
    } catch (error) {
      console.error(`[AWS] Failed to get state for ${resourceId}:`, error);
      return "unknown";
    }
  }
}

class AzureResourceController implements ResourceController {
  async start(resourceId: string): Promise<boolean> {
    try {
      console.log(`[Azure] Starting resource: ${resourceId}`);
      // In production: await computeClient.virtualMachines.beginStart(resourceGroup, vmName);
      return true;
    } catch (error) {
      console.error(`[Azure] Failed to start ${resourceId}:`, error);
      return false;
    }
  }

  async stop(resourceId: string): Promise<boolean> {
    try {
      console.log(`[Azure] Stopping resource: ${resourceId}`);
      // In production: await computeClient.virtualMachines.beginDeallocate(resourceGroup, vmName);
      return true;
    } catch (error) {
      console.error(`[Azure] Failed to stop ${resourceId}:`, error);
      return false;
    }
  }

  async getState(resourceId: string): Promise<"running" | "stopped" | "unknown"> {
    try {
      // In production: const vm = await computeClient.virtualMachines.get(resourceGroup, vmName);
      // return vm.powerState === 'PowerState/running' ? 'running' : 'stopped';
      return Math.random() > 0.5 ? "running" : "stopped";
    } catch (error) {
      console.error(`[Azure] Failed to get state for ${resourceId}:`, error);
      return "unknown";
    }
  }
}

class GCPResourceController implements ResourceController {
  async start(resourceId: string): Promise<boolean> {
    try {
      console.log(`[GCP] Starting resource: ${resourceId}`);
      // In production: await compute.instances.start({ project, zone, instance });
      return true;
    } catch (error) {
      console.error(`[GCP] Failed to start ${resourceId}:`, error);
      return false;
    }
  }

  async stop(resourceId: string): Promise<boolean> {
    try {
      console.log(`[GCP] Stopping resource: ${resourceId}`);
      // In production: await compute.instances.stop({ project, zone, instance });
      return true;
    } catch (error) {
      console.error(`[GCP] Failed to stop ${resourceId}:`, error);
      return false;
    }
  }

  async getState(resourceId: string): Promise<"running" | "stopped" | "unknown"> {
    try {
      // In production: const [vm] = await compute.instances.get({ project, zone, instance });
      // return vm.status === 'RUNNING' ? 'running' : 'stopped';
      return Math.random() > 0.5 ? "running" : "stopped";
    } catch (error) {
      console.error(`[GCP] Failed to get state for ${resourceId}:`, error);
      return "unknown";
    }
  }
}

/**
 * Main scheduling service
 */
export class ResourceScheduler {
  private schedules: Map<string, ResourceSchedule> = new Map();
  private controllers: Map<CloudProvider, ResourceController> = new Map();
  private executionHistory: ScheduleExecution[] = [];
  private isRunning: boolean = false;
  private checkInterval?: NodeJS.Timeout;

  constructor() {
    this.initializeControllers();
  }

  private initializeControllers(): void {
    this.controllers.set("aws", new AWSResourceController());
    this.controllers.set("azure", new AzureResourceController());
    this.controllers.set("gcp", new GCPResourceController());
  }

  /**
   * Add a resource schedule
   */
  addSchedule(schedule: ResourceSchedule): void {
    this.schedules.set(schedule.id, schedule);
    console.log(`Added schedule ${schedule.id} for resource ${schedule.resourceName}`);
  }

  /**
   * Remove a resource schedule
   */
  removeSchedule(scheduleId: string): void {
    this.schedules.delete(scheduleId);
    console.log(`Removed schedule ${scheduleId}`);
  }

  /**
   * Update an existing schedule
   */
  updateSchedule(scheduleId: string, updates: Partial<ResourceSchedule>): void {
    const existing = this.schedules.get(scheduleId);
    if (!existing) {
      throw new Error(`Schedule ${scheduleId} not found`);
    }

    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.schedules.set(scheduleId, updated);
    console.log(`Updated schedule ${scheduleId}`);
  }

  /**
   * Get all schedules
   */
  getAllSchedules(): ResourceSchedule[] {
    return Array.from(this.schedules.values());
  }

  /**
   * Get schedules for specific environment
   */
  getSchedulesByEnvironment(environment: Environment): ResourceSchedule[] {
    return Array.from(this.schedules.values()).filter(
      (s) => s.environment === environment
    );
  }

  /**
   * Execute a specific schedule action
   */
  async executeSchedule(
    scheduleId: string,
    action: "start" | "stop",
    force: boolean = false
  ): Promise<ScheduleExecution> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule ${scheduleId} not found`);
    }

    if (!schedule.enabled && !force) {
      const execution: ScheduleExecution = {
        id: `exec-${Date.now()}-${scheduleId}`,
        scheduleId,
        resourceId: schedule.resourceId,
        action,
        scheduledTime: new Date(),
        executionTime: new Date(),
        status: "skipped",
      };
      this.executionHistory.push(execution);
      return execution;
    }

    const controller = this.controllers.get(schedule.provider);
    if (!controller) {
      throw new Error(`No controller for provider ${schedule.provider}`);
    }

    const scheduledTime = new Date();
    let success = false;
    let error: string | undefined;

    try {
      // Check current state to avoid unnecessary operations
      const currentState = await controller.getState(schedule.resourceId);
      
      if (action === "start" && currentState === "running") {
        console.log(`Resource ${schedule.resourceName} already running, skipping`);
        success = true;
      } else if (action === "stop" && currentState === "stopped") {
        console.log(`Resource ${schedule.resourceName} already stopped, skipping`);
        success = true;
      } else {
        // Execute the action
        success = action === "start"
          ? await controller.start(schedule.resourceId)
          : await controller.stop(schedule.resourceId);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      success = false;
    }

    // Calculate cost saved (if stopping)
    let costSaved: number | undefined;
    if (success && action === "stop") {
      costSaved = this.calculateCostSaved(schedule);
    }

    const execution: ScheduleExecution = {
      id: `exec-${Date.now()}-${scheduleId}`,
      scheduleId,
      resourceId: schedule.resourceId,
      action,
      scheduledTime,
      executionTime: new Date(),
      status: success ? "success" : "failed",
      error,
      costSaved,
    };

    this.executionHistory.push(execution);

    // Update schedule last executed time
    schedule.lastExecuted = new Date();
    this.schedules.set(scheduleId, schedule);

    return execution;
  }

  /**
   * Start the scheduler (checks every minute for due schedules)
   */
  start(checkIntervalSeconds: number = 60): void {
    if (this.isRunning) {
      console.log("Scheduler already running");
      return;
    }

    this.isRunning = true;
    console.log(`Starting scheduler with ${checkIntervalSeconds}s check interval`);

    this.checkInterval = setInterval(async () => {
      await this.checkDueSchedules();
    }, checkIntervalSeconds * 1000);

    // Run immediately on start
    this.checkDueSchedules();
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
    this.isRunning = false;
    console.log("Scheduler stopped");
  }

  /**
   * Check for due schedules and execute them
   */
  private async checkDueSchedules(): Promise<void> {
    const now = new Date();
    const results: ScheduleExecution[] = [];

    console.log(`[${now.toISOString()}] Checking for due schedules...`);

    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;

      // Check if start time is due
      if (CronParser.matches(schedule.startCron, now)) {
        const exec = await this.executeSchedule(schedule.id, "start");
        results.push(exec);
      }

      // Check if stop time is due
      if (CronParser.matches(schedule.stopCron, now)) {
        const exec = await this.executeSchedule(schedule.id, "stop");
        results.push(exec);
      }
    }

    if (results.length > 0) {
      console.log(`Executed ${results.length} scheduled actions`);
      const succeeded = results.filter((r) => r.status === "success").length;
      const failed = results.filter((r) => r.status === "failed").length;
      console.log(`Success: ${succeeded}, Failed: ${failed}`);
    }
  }

  /**
   * Get execution history
   */
  getExecutionHistory(
    scheduleId?: string,
    limit: number = 100
  ): ScheduleExecution[] {
    let history = [...this.executionHistory];

    if (scheduleId) {
      history = history.filter((e) => e.scheduleId === scheduleId);
    }

    // Sort by execution time descending
    history.sort(
      (a, b) => b.executionTime.getTime() - a.executionTime.getTime()
    );

    return history.slice(0, limit);
  }

  /**
   * Get execution summary
   */
  getExecutionSummary(
    startDate: Date,
    endDate: Date
  ): SchedulingExecutionResult {
    const executions = this.executionHistory.filter(
      (e) =>
        e.executionTime >= startDate && e.executionTime <= endDate
    );

    const succeeded = executions.filter((e) => e.status === "success").length;
    const failed = executions.filter((e) => e.status === "failed").length;
    const skipped = executions.filter((e) => e.status === "skipped").length;
    const totalCostSaved = executions.reduce(
      (sum, e) => sum + (e.costSaved || 0),
      0
    );

    return {
      totalSchedules: this.schedules.size,
      executed: executions.length,
      succeeded,
      failed,
      skipped,
      totalCostSaved,
      executions,
    };
  }

  /**
   * Calculate estimated cost saved by stopping a resource
   */
  private calculateCostSaved(schedule: ResourceSchedule): number {
    // Simplified calculation
    // In production, fetch actual instance pricing
    
    // Assume average hourly cost based on resource type
    const hourlyCosts: Record<ResourceType, number> = {
      compute: 0.10, // ~$72/month
      database: 0.15, // ~$108/month
      container: 0.08, // ~$58/month
      storage: 0.01, // ~$7/month
      network: 0.05, // ~$36/month
      serverless: 0.02, // ~$14/month
      other: 0.05,
    };

    const hourlyCost = hourlyCosts[schedule.resourceType] || 0.05;

    // Calculate hours saved based on schedule
    // Simplified: assume resource is stopped for 12 hours/day
    const hoursSaved = 12;

    return hourlyCost * hoursSaved;
  }

  /**
   * Bulk create schedules for resources
   */
  bulkCreateSchedules(
    resources: Array<{
      resourceId: string;
      resourceName: string;
      resourceType: ResourceType;
      provider: CloudProvider;
      environment: Environment;
    }>,
    startCron: string,
    stopCron: string,
    timezone: string = "UTC"
  ): ResourceSchedule[] {
    const schedules: ResourceSchedule[] = [];

    for (const resource of resources) {
      const schedule: ResourceSchedule = {
        id: `schedule-${resource.resourceId}-${Date.now()}`,
        resourceId: resource.resourceId,
        resourceName: resource.resourceName,
        resourceType: resource.resourceType,
        provider: resource.provider,
        environment: resource.environment,
        scheduleType: "daily",
        timezone,
        startCron,
        stopCron,
        enabled: true,
        tags: {},
        estimatedMonthlySavings: this.estimateMonthlySavings(
          resource.resourceType,
          startCron,
          stopCron
        ),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      this.addSchedule(schedule);
      schedules.push(schedule);
    }

    console.log(`Bulk created ${schedules.length} schedules`);
    return schedules;
  }

  /**
   * Estimate monthly savings for a schedule
   */
  private estimateMonthlySavings(
    resourceType: ResourceType,
    startCron: string,
    stopCron: string
  ): number {
    // Parse cron to determine hours stopped per day
    const startParts = startCron.split(" ");
    const stopParts = stopCron.split(" ");

    const startHour = parseInt(startParts[1], 10);
    const stopHour = parseInt(stopParts[1], 10);

    let hoursStoppedPerDay = 0;
    if (stopHour < startHour) {
      hoursStoppedPerDay = 24 - startHour + stopHour;
    } else {
      hoursStoppedPerDay = stopHour - startHour;
    }

    // Check if weekends are included
    const startDayOfWeek = startParts[4];
    const isWeekdaysOnly = startDayOfWeek === "1-5";
    const daysPerMonth = isWeekdaysOnly ? 22 : 30;

    const totalHoursSaved = hoursStoppedPerDay * daysPerMonth;

    // Hourly costs by resource type
    const hourlyCosts: Record<ResourceType, number> = {
      compute: 0.10,
      database: 0.15,
      container: 0.08,
      storage: 0.01,
      network: 0.05,
      serverless: 0.02,
      other: 0.05,
    };

    const hourlyCost = hourlyCosts[resourceType] || 0.05;
    return totalHoursSaved * hourlyCost;
  }

  /**
   * Get recommended schedules for non-production environments
   */
  getRecommendedSchedules(): Array<{
    startCron: string;
    stopCron: string;
    description: string;
    estimatedSavings: string;
  }> {
    return [
      {
        startCron: "0 8 * * 1-5", // 8 AM weekdays
        stopCron: "0 19 * * 1-5", // 7 PM weekdays
        description: "Standard business hours (8 AM - 7 PM, Mon-Fri)",
        estimatedSavings: "~65% cost reduction",
      },
      {
        startCron: "0 6 * * 1-5", // 6 AM weekdays
        stopCron: "0 22 * * 1-5", // 10 PM weekdays
        description: "Extended hours (6 AM - 10 PM, Mon-Fri)",
        estimatedSavings: "~50% cost reduction",
      },
      {
        startCron: "0 9 * * 1-5", // 9 AM weekdays
        stopCron: "0 17 * * 1-5", // 5 PM weekdays
        description: "Core hours (9 AM - 5 PM, Mon-Fri)",
        estimatedSavings: "~75% cost reduction",
      },
      {
        startCron: "0 8 * * 1-6", // 8 AM Mon-Sat
        stopCron: "0 20 * * 1-6", // 8 PM Mon-Sat
        description: "Six-day week (8 AM - 8 PM, Mon-Sat)",
        estimatedSavings: "~55% cost reduction",
      },
    ];
  }
}
