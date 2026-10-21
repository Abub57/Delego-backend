/**
 * Budget Management System
 * 
 * Manages budgets with threshold-based alerting, forecasting, and multi-channel notifications.
 * Supports budgets scoped by provider, service, environment, tags, and resource types.
 */

import type {
  Budget,
  BudgetAlert,
  CloudProvider,
  Environment,
  ResourceType,
  BillingRecord,
} from "../types.js";

export class BudgetManager {
  private budgets: Map<string, Budget> = new Map();
  private isMonitoring: boolean = false;
  private checkInterval?: NodeJS.Timeout;

  /**
   * Create a new budget
   */
  createBudget(params: {
    name: string;
    amount: number;
    currency: string;
    period: Budget["period"];
    startDate: Date;
    endDate?: Date;
    scope?: Budget["scope"];
    thresholds?: Array<{
      percentage: number;
      alertChannels: ("email" | "slack" | "sms" | "webhook")[];
    }>;
  }): Budget {
    const budget: Budget = {
      id: `budget-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: params.name,
      amount: params.amount,
      currency: params.currency,
      period: params.period,
      startDate: params.startDate,
      endDate: params.endDate,
      scope: params.scope || {},
      thresholds: params.thresholds || [
        { percentage: 50, alertChannels: ["email"] },
        { percentage: 80, alertChannels: ["email", "slack"] },
        { percentage: 90, alertChannels: ["email", "slack", "sms"] },
        { percentage: 100, alertChannels: ["email", "slack", "sms", "webhook"] },
      ],
      currentSpend: 0,
      forecasted: 0,
      variance: 0,
      status: "on_track",
      alerts: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.budgets.set(budget.id, budget);
    console.log(`Created budget: ${budget.name} ($${budget.amount} ${budget.currency})`);

    return budget;
  }

  /**
   * Update an existing budget
   */
  updateBudget(
    budgetId: string,
    updates: Partial<Omit<Budget, "id" | "createdAt" | "alerts">>
  ): Budget {
    const budget = this.budgets.get(budgetId);
    if (!budget) {
      throw new Error(`Budget ${budgetId} not found`);
    }

    const updated = {
      ...budget,
      ...updates,
      updatedAt: new Date(),
    };

    this.budgets.set(budgetId, updated);
    console.log(`Updated budget: ${updated.name}`);

    return updated;
  }

  /**
   * Delete a budget
   */
  deleteBudget(budgetId: string): void {
    const budget = this.budgets.get(budgetId);
    if (!budget) {
      throw new Error(`Budget ${budgetId} not found`);
    }

    this.budgets.delete(budgetId);
    console.log(`Deleted budget: ${budget.name}`);
  }

  /**
   * Get budget by ID
   */
  getBudget(budgetId: string): Budget | undefined {
    return this.budgets.get(budgetId);
  }

  /**
   * Get all budgets
   */
  getAllBudgets(): Budget[] {
    return Array.from(this.budgets.values());
  }

  /**
   * Start budget monitoring
   */
  startMonitoring(checkIntervalMinutes: number = 60): void {
    if (this.isMonitoring) {
      console.log("Budget monitoring already running");
      return;
    }

    this.isMonitoring = true;
    console.log(`Starting budget monitoring (checking every ${checkIntervalMinutes} minutes)`);

    this.checkInterval = setInterval(
      () => this.checkAllBudgets(),
      checkIntervalMinutes * 60 * 1000
    );

    // Run immediately
    this.checkAllBudgets();
  }

  /**
   * Stop budget monitoring
   */
  stopMonitoring(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
    this.isMonitoring = false;
    console.log("Budget monitoring stopped");
  }

  /**
   * Check all budgets for threshold violations
   */
  private async checkAllBudgets(): Promise<void> {
    console.log(`[${new Date().toISOString()}] Checking budgets...`);

    for (const budget of this.budgets.values()) {
      await this.checkBudget(budget.id);
    }
  }

  /**
   * Check a specific budget
   */
  async checkBudget(budgetId: string): Promise<void> {
    const budget = this.budgets.get(budgetId);
    if (!budget) return;

    // In production, fetch actual spend from database
    // const billingData = await this.fetchBillingData(budget);
    // const currentSpend = this.calculateCurrentSpend(billingData, budget);

    // Mock current spend for demonstration
    const mockSpend = this.getMockCurrentSpend(budget);
    budget.currentSpend = mockSpend;

    // Calculate forecast
    budget.forecasted = this.forecastSpend(budget);

    // Calculate variance
    budget.variance = budget.currentSpend - budget.amount;

    // Update status
    const percentageUsed = (budget.currentSpend / budget.amount) * 100;
    if (percentageUsed >= 100) {
      budget.status = "exceeded";
    } else if (percentageUsed >= 80) {
      budget.status = "warning";
    } else {
      budget.status = "on_track";
    }

    // Check thresholds and send alerts
    await this.checkThresholds(budget);

    budget.updatedAt = new Date();
    this.budgets.set(budget.id, budget);
  }

  /**
   * Mock current spend (in production, query from database)
   */
  private getMockCurrentSpend(budget: Budget): number {
    // Generate realistic mock spend based on budget period
    const now = new Date();
    const start = budget.startDate;
    const periodDays = this.getPeriodDays(budget.period);
    const elapsedDays = Math.floor(
      (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
    );
    const progressPercentage = Math.min(elapsedDays / periodDays, 1);

    // Add some variance (80-120% of expected)
    const expectedSpend = budget.amount * progressPercentage;
    const variance = 0.8 + Math.random() * 0.4; // 0.8 to 1.2
    return expectedSpend * variance;
  }

  /**
   * Get number of days in budget period
   */
  private getPeriodDays(period: Budget["period"]): number {
    switch (period) {
      case "daily":
        return 1;
      case "weekly":
        return 7;
      case "monthly":
        return 30;
      case "quarterly":
        return 90;
      case "yearly":
        return 365;
      default:
        return 30;
    }
  }

  /**
   * Forecast spend for remaining period
   */
  private forecastSpend(budget: Budget): number {
    const now = new Date();
    const start = budget.startDate;
    const periodDays = this.getPeriodDays(budget.period);
    
    const elapsedDays = Math.max(
      1,
      Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    );

    if (elapsedDays >= periodDays) {
      return budget.currentSpend;
    }

    // Linear forecast based on current burn rate
    const dailyBurnRate = budget.currentSpend / elapsedDays;
    const remainingDays = periodDays - elapsedDays;
    const forecastedRemaining = dailyBurnRate * remainingDays;

    return budget.currentSpend + forecastedRemaining;
  }

  /**
   * Check budget thresholds and generate alerts
   */
  private async checkThresholds(budget: Budget): Promise<void> {
    const percentageUsed = (budget.currentSpend / budget.amount) * 100;

    // Get already alerted thresholds
    const alertedThresholds = new Set(
      budget.alerts.map((a) => a.thresholdPercentage)
    );

    for (const threshold of budget.thresholds) {
      if (
        percentageUsed >= threshold.percentage &&
        !alertedThresholds.has(threshold.percentage)
      ) {
        await this.createAndSendAlert(budget, threshold);
      }
    }
  }

  /**
   * Create and send budget alert
   */
  private async createAndSendAlert(
    budget: Budget,
    threshold: Budget["thresholds"][0]
  ): Promise<void> {
    const percentageUsed = (budget.currentSpend / budget.amount) * 100;
    const severity =
      percentageUsed >= 100
        ? "critical"
        : percentageUsed >= 90
        ? "warning"
        : "info";

    const alert: BudgetAlert = {
      id: `alert-${budget.id}-${threshold.percentage}-${Date.now()}`,
      budgetId: budget.id,
      timestamp: new Date(),
      thresholdPercentage: threshold.percentage,
      actualSpend: budget.currentSpend,
      budgetAmount: budget.amount,
      message: this.formatAlertMessage(budget, threshold, percentageUsed),
      severity,
      notificationsSent: [],
    };

    // Send notifications
    for (const channel of threshold.alertChannels) {
      const success = await this.sendNotification(channel, budget, alert);
      alert.notificationsSent.push({
        channel,
        timestamp: new Date(),
        success,
      });
    }

    budget.alerts.push(alert);
    console.log(`Budget alert: ${budget.name} reached ${threshold.percentage}% threshold`);
  }

  /**
   * Format alert message
   */
  private formatAlertMessage(
    budget: Budget,
    threshold: Budget["thresholds"][0],
    percentageUsed: number
  ): string {
    const forecastMessage =
      budget.forecasted > budget.amount
        ? ` and is forecasted to exceed budget by ${((budget.forecasted / budget.amount - 1) * 100).toFixed(1)}%`
        : "";

    return (
      `Budget "${budget.name}" has reached ${threshold.percentage}% of allocated amount. ` +
      `Current spend: ${budget.currency} ${budget.currentSpend.toFixed(2)} / ${budget.amount.toFixed(2)} ` +
      `(${percentageUsed.toFixed(1)}%)${forecastMessage}.`
    );
  }

  /**
   * Send notification via specified channel
   */
  private async sendNotification(
    channel: "email" | "slack" | "sms" | "webhook",
    budget: Budget,
    alert: BudgetAlert
  ): Promise<boolean> {
    try {
      switch (channel) {
        case "email":
          await this.sendEmailNotification(budget, alert);
          break;
        case "slack":
          await this.sendSlackNotification(budget, alert);
          break;
        case "sms":
          await this.sendSMSNotification(budget, alert);
          break;
        case "webhook":
          await this.sendWebhookNotification(budget, alert);
          break;
      }
      return true;
    } catch (error) {
      console.error(`Failed to send ${channel} notification:`, error);
      return false;
    }
  }

  /**
   * Send email notification
   */
  private async sendEmailNotification(
    budget: Budget,
    alert: BudgetAlert
  ): Promise<void> {
    console.log(`[Email] Budget alert: ${budget.name} - ${alert.message}`);
    // In production: use SendGrid, AWS SES, etc.
  }

  /**
   * Send Slack notification
   */
  private async sendSlackNotification(
    budget: Budget,
    alert: BudgetAlert
  ): Promise<void> {
    console.log(`[Slack] Budget alert: ${budget.name}`);
    // In production: POST to Slack webhook
    /*
    const color = alert.severity === 'critical' ? '#FF0000' : 
                  alert.severity === 'warning' ? '#FFA500' : '#00FF00';
    
    const message = {
      attachments: [{
        color,
        title: `Budget Alert: ${budget.name}`,
        text: alert.message,
        fields: [
          { title: 'Current Spend', value: `${budget.currency} ${budget.currentSpend.toFixed(2)}`, short: true },
          { title: 'Budget Amount', value: `${budget.currency} ${budget.amount.toFixed(2)}`, short: true },
          { title: 'Forecasted', value: `${budget.currency} ${budget.forecasted.toFixed(2)}`, short: true },
          { title: 'Status', value: budget.status.toUpperCase(), short: true }
        ],
        timestamp: alert.timestamp.getTime() / 1000
      }]
    };
    */
  }

  /**
   * Send SMS notification
   */
  private async sendSMSNotification(
    budget: Budget,
    alert: BudgetAlert
  ): Promise<void> {
    console.log(`[SMS] Budget alert: ${budget.name}`);
    // In production: use Twilio, AWS SNS, etc.
  }

  /**
   * Send webhook notification
   */
  private async sendWebhookNotification(
    budget: Budget,
    alert: BudgetAlert
  ): Promise<void> {
    console.log(`[Webhook] Budget alert: ${budget.name}`);
    // In production: POST to webhook URL
  }

  /**
   * Get budget summary
   */
  getBudgetSummary(): {
    totalBudgets: number;
    totalAllocated: number;
    totalSpent: number;
    onTrack: number;
    warning: number;
    exceeded: number;
    forecastedOverrun: number;
  } {
    const budgets = Array.from(this.budgets.values());

    return {
      totalBudgets: budgets.length,
      totalAllocated: budgets.reduce((sum, b) => sum + b.amount, 0),
      totalSpent: budgets.reduce((sum, b) => sum + b.currentSpend, 0),
      onTrack: budgets.filter((b) => b.status === "on_track").length,
      warning: budgets.filter((b) => b.status === "warning").length,
      exceeded: budgets.filter((b) => b.status === "exceeded").length,
      forecastedOverrun: budgets
        .filter((b) => b.forecasted > b.amount)
        .reduce((sum, b) => sum + (b.forecasted - b.amount), 0),
    };
  }

  /**
   * Get budgets by status
   */
  getBudgetsByStatus(status: Budget["status"]): Budget[] {
    return Array.from(this.budgets.values()).filter((b) => b.status === status);
  }

  /**
   * Calculate remaining budget
   */
  getRemainingBudget(budgetId: string): number {
    const budget = this.budgets.get(budgetId);
    if (!budget) return 0;

    return Math.max(0, budget.amount - budget.currentSpend);
  }

  /**
   * Get budget utilization percentage
   */
  getBudgetUtilization(budgetId: string): number {
    const budget = this.budgets.get(budgetId);
    if (!budget) return 0;

    return (budget.currentSpend / budget.amount) * 100;
  }

  /**
   * Predict when budget will be exhausted
   */
  predictBudgetExhaustion(budgetId: string): Date | null {
    const budget = this.budgets.get(budgetId);
    if (!budget || budget.forecasted <= budget.amount) {
      return null; // Budget won't be exhausted
    }

    const now = new Date();
    const start = budget.startDate;
    const periodDays = this.getPeriodDays(budget.period);
    const elapsedDays = Math.max(
      1,
      Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
    );

    const dailyBurnRate = budget.currentSpend / elapsedDays;
    const remainingBudget = budget.amount - budget.currentSpend;
    const daysUntilExhaustion = remainingBudget / dailyBurnRate;

    const exhaustionDate = new Date();
    exhaustionDate.setDate(exhaustionDate.getDate() + Math.ceil(daysUntilExhaustion));

    return exhaustionDate;
  }

  /**
   * Generate budget recommendations
   */
  generateRecommendations(): Array<{
    budgetId: string;
    budgetName: string;
    recommendation: string;
    priority: "high" | "medium" | "low";
    estimatedImpact: number;
  }> {
    const recommendations: Array<{
      budgetId: string;
      budgetName: string;
      recommendation: string;
      priority: "high" | "medium" | "low";
      estimatedImpact: number;
    }> = [];

    for (const budget of this.budgets.values()) {
      const utilization = (budget.currentSpend / budget.amount) * 100;

      // Budget exceeded
      if (budget.status === "exceeded") {
        recommendations.push({
          budgetId: budget.id,
          budgetName: budget.name,
          recommendation: `Budget has been exceeded. Review and optimize resources, or increase budget allocation.`,
          priority: "high",
          estimatedImpact: budget.variance,
        });
      }

      // Forecasted to exceed
      if (budget.forecasted > budget.amount && budget.status !== "exceeded") {
        const overrun = budget.forecasted - budget.amount;
        recommendations.push({
          budgetId: budget.id,
          budgetName: budget.name,
          recommendation: `Budget is forecasted to exceed by ${budget.currency} ${overrun.toFixed(2)}. Consider cost optimization or budget adjustment.`,
          priority: "high",
          estimatedImpact: overrun,
        });
      }

      // Significantly underutilized
      if (utilization < 50 && budget.currentSpend > 100) {
        const waste = budget.amount - budget.forecasted;
        if (waste > 100) {
          recommendations.push({
            budgetId: budget.id,
            budgetName: budget.name,
            recommendation: `Budget is underutilized (${utilization.toFixed(1)}% used). Consider reallocating ${budget.currency} ${waste.toFixed(2)} to other budgets.`,
            priority: "low",
            estimatedImpact: waste,
          });
        }
      }

      // Approaching rapidly
      const exhaustionDate = this.predictBudgetExhaustion(budget.id);
      if (exhaustionDate) {
        const daysUntilExhaustion = Math.ceil(
          (exhaustionDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysUntilExhaustion <= 7) {
          recommendations.push({
            budgetId: budget.id,
            budgetName: budget.name,
            recommendation: `Budget will be exhausted in ${daysUntilExhaustion} days. Immediate action required to reduce costs or increase budget.`,
            priority: "high",
            estimatedImpact: budget.forecasted - budget.amount,
          });
        }
      }
    }

    // Sort by priority and impact
    recommendations.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return b.estimatedImpact - a.estimatedImpact;
    });

    return recommendations;
  }
}
