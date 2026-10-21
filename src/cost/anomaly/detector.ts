/**
 * Cost Anomaly Detection Engine
 * 
 * Detects unusual cost patterns using statistical analysis and machine learning.
 * Supports spike detection, trend analysis, and pattern recognition.
 */

import type {
  CloudProvider,
  CostAnomaly,
  AnomalyDetectionConfig,
  BillingRecord,
} from "../types.js";

interface TimeSeriesDataPoint {
  timestamp: Date;
  value: number;
  metadata?: Record<string, unknown>;
}

/**
 * Statistical anomaly detection algorithms
 */
class AnomalyDetectionAlgorithms {
  /**
   * Detect spikes using moving average and standard deviation
   * Z-score method: |value - mean| / stddev > threshold
   */
  static detectSpike(
    data: TimeSeriesDataPoint[],
    threshold: number = 3
  ): TimeSeriesDataPoint[] {
    if (data.length < 7) return []; // Need at least a week of data

    const anomalies: TimeSeriesDataPoint[] = [];
    const windowSize = Math.min(7, Math.floor(data.length / 2));

    for (let i = windowSize; i < data.length; i++) {
      const window = data.slice(i - windowSize, i);
      const mean = window.reduce((sum, p) => sum + p.value, 0) / window.length;
      const variance =
        window.reduce((sum, p) => sum + Math.pow(p.value - mean, 2), 0) /
        window.length;
      const stddev = Math.sqrt(variance);

      const current = data[i];
      const zScore = stddev > 0 ? Math.abs(current.value - mean) / stddev : 0;

      if (zScore > threshold) {
        anomalies.push(current);
      }
    }

    return anomalies;
  }

  /**
   * Detect trend changes using linear regression
   */
  static detectTrendChange(
    data: TimeSeriesDataPoint[],
    significanceThreshold: number = 0.3
  ): { hasTrendChange: boolean; oldSlope: number; newSlope: number } {
    if (data.length < 14) {
      return { hasTrendChange: false, oldSlope: 0, newSlope: 0 };
    }

    const midpoint = Math.floor(data.length / 2);
    const firstHalf = data.slice(0, midpoint);
    const secondHalf = data.slice(midpoint);

    const oldSlope = this.calculateSlope(firstHalf);
    const newSlope = this.calculateSlope(secondHalf);

    const slopeChange = Math.abs(newSlope - oldSlope);
    const hasTrendChange = slopeChange > significanceThreshold;

    return { hasTrendChange, oldSlope, newSlope };
  }

  /**
   * Calculate linear regression slope
   */
  private static calculateSlope(data: TimeSeriesDataPoint[]): number {
    const n = data.length;
    if (n < 2) return 0;

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;

    data.forEach((point, index) => {
      sumX += index;
      sumY += point.value;
      sumXY += index * point.value;
      sumX2 += index * index;
    });

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }

  /**
   * Detect seasonal patterns using autocorrelation
   */
  static detectSeasonality(
    data: TimeSeriesDataPoint[],
    period: number = 7
  ): { hasSeasonality: boolean; correlation: number } {
    if (data.length < period * 2) {
      return { hasSeasonality: false, correlation: 0 };
    }

    const values = data.map((p) => p.value);
    const correlation = this.autocorrelation(values, period);

    // Consider seasonal if correlation > 0.5
    return { hasSeasonality: correlation > 0.5, correlation };
  }

  /**
   * Calculate autocorrelation at given lag
   */
  private static autocorrelation(values: number[], lag: number): number {
    const n = values.length;
    const mean = values.reduce((sum, v) => sum + v, 0) / n;

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n - lag; i++) {
      numerator += (values[i] - mean) * (values[i + lag] - mean);
    }

    for (let i = 0; i < n; i++) {
      denominator += Math.pow(values[i] - mean, 2);
    }

    return denominator > 0 ? numerator / denominator : 0;
  }

  /**
   * Forecast next value using exponential smoothing
   */
  static forecast(
    data: TimeSeriesDataPoint[],
    alpha: number = 0.3
  ): number {
    if (data.length === 0) return 0;
    if (data.length === 1) return data[0].value;

    let smoothed = data[0].value;

    for (let i = 1; i < data.length; i++) {
      smoothed = alpha * data[i].value + (1 - alpha) * smoothed;
    }

    return smoothed;
  }
}

/**
 * Main anomaly detection service
 */
export class CostAnomalyDetector {
  private config: AnomalyDetectionConfig;
  private detectedAnomalies: Map<string, CostAnomaly> = new Map();
  private historicalData: Map<string, TimeSeriesDataPoint[]> = new Map();
  private isMonitoring: boolean = false;
  private monitorInterval?: NodeJS.Timeout;

  constructor(config: AnomalyDetectionConfig) {
    this.config = config;
  }

  /**
   * Start continuous anomaly monitoring
   */
  start(): void {
    if (this.isMonitoring) {
      console.log("Anomaly detector already running");
      return;
    }

    this.isMonitoring = true;
    console.log(
      `Starting anomaly detection (checking every ${this.config.checkIntervalMinutes} minutes)`
    );

    this.monitorInterval = setInterval(
      () => this.runDetection(),
      this.config.checkIntervalMinutes * 60 * 1000
    );

    // Run immediately
    this.runDetection();
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = undefined;
    }
    this.isMonitoring = false;
    console.log("Anomaly detector stopped");
  }

  /**
   * Run anomaly detection on current data
   */
  private async runDetection(): Promise<void> {
    console.log(`[${new Date().toISOString()}] Running anomaly detection...`);

    try {
      // In production, fetch recent billing data from database
      // const billingData = await this.fetchRecentBillingData();

      // Group data by service/resource for analysis
      const groupedData = this.groupDataForAnalysis(this.historicalData);

      for (const [key, data] of groupedData.entries()) {
        await this.analyzeTimeSeries(key, data);
      }

      const newAnomalies = Array.from(this.detectedAnomalies.values()).filter(
        (a) => a.status === "new"
      );

      if (newAnomalies.length > 0) {
        console.log(`Detected ${newAnomalies.length} new anomalies`);
        await this.sendNotifications(newAnomalies);
      }
    } catch (error) {
      console.error("Anomaly detection failed:", error);
    }
  }

  /**
   * Analyze a time series for anomalies
   */
  private async analyzeTimeSeries(
    key: string,
    data: TimeSeriesDataPoint[]
  ): Promise<void> {
    // Minimum data threshold
    if (data.length < this.config.thresholds.trendDays) {
      return;
    }

    // 1. Detect spikes
    const spikes = AnomalyDetectionAlgorithms.detectSpike(data, 3);
    for (const spike of spikes) {
      await this.createAnomalyIfSignificant(key, spike, data, "spike");
    }

    // 2. Detect trend changes
    const trendAnalysis = AnomalyDetectionAlgorithms.detectTrendChange(
      data,
      this.config.thresholds.spikePercentage / 100
    );

    if (trendAnalysis.hasTrendChange && trendAnalysis.newSlope > 0) {
      const lastPoint = data[data.length - 1];
      await this.createAnomalyIfSignificant(key, lastPoint, data, "trend");
    }

    // 3. Detect unexpected patterns
    const seasonality = AnomalyDetectionAlgorithms.detectSeasonality(data, 7);
    if (!seasonality.hasSeasonality) {
      // Cost pattern has changed
      const lastPoint = data[data.length - 1];
      const forecast = AnomalyDetectionAlgorithms.forecast(
        data.slice(0, -1),
        0.3
      );
      const deviation = Math.abs(lastPoint.value - forecast) / forecast;

      if (deviation > this.config.thresholds.spikePercentage / 100) {
        await this.createAnomalyIfSignificant(key, lastPoint, data, "pattern");
      }
    }
  }

  /**
   * Create anomaly record if cost is significant
   */
  private async createAnomalyIfSignificant(
    key: string,
    dataPoint: TimeSeriesDataPoint,
    historicalData: TimeSeriesDataPoint[],
    type: CostAnomaly["anomalyType"]
  ): Promise<void> {
    const actualCost = dataPoint.value;

    if (actualCost < this.config.thresholds.minCostThreshold) {
      return; // Ignore low-cost anomalies
    }

    // Calculate expected cost (average of previous period)
    const recentData = historicalData.slice(-this.config.thresholds.trendDays);
    const expectedCost =
      recentData.reduce((sum, p) => sum + p.value, 0) / recentData.length;

    const deviation = ((actualCost - expectedCost) / expectedCost) * 100;

    if (Math.abs(deviation) < this.config.thresholds.spikePercentage) {
      return; // Not significant enough
    }

    // Determine severity
    const severity = this.determineSeverity(deviation, actualCost);

    // Check if already detected
    const anomalyId = `${key}-${dataPoint.timestamp.toISOString()}`;
    if (this.detectedAnomalies.has(anomalyId)) {
      return;
    }

    const anomaly: CostAnomaly = {
      id: anomalyId,
      detectedAt: new Date(),
      service: key,
      provider: this.extractProvider(key),
      anomalyType: type,
      severity,
      expectedCost,
      actualCost,
      deviation,
      confidence: this.calculateConfidence(historicalData, deviation),
      timeWindow: {
        start: dataPoint.timestamp,
        end: dataPoint.timestamp,
      },
      possibleCauses: this.identifyPossibleCauses(type, deviation, key),
      recommendations: this.generateRecommendations(type, key, actualCost),
      status: "new",
    };

    this.detectedAnomalies.set(anomalyId, anomaly);
    console.log(
      `New ${severity} anomaly detected: ${key} - $${actualCost.toFixed(2)} (expected: $${expectedCost.toFixed(2)})`
    );
  }

  /**
   * Determine anomaly severity
   */
  private determineSeverity(
    deviation: number,
    cost: number
  ): CostAnomaly["severity"] {
    const absDeviation = Math.abs(deviation);

    if (absDeviation > 100 || cost > 10000) return "critical";
    if (absDeviation > 50 || cost > 5000) return "high";
    if (absDeviation > 25 || cost > 1000) return "medium";
    return "low";
  }

  /**
   * Calculate confidence score
   */
  private calculateConfidence(
    data: TimeSeriesDataPoint[],
    deviation: number
  ): number {
    // Higher confidence with more data and larger deviations
    const dataFactor = Math.min(data.length / 30, 1); // Cap at 30 days
    const deviationFactor = Math.min(Math.abs(deviation) / 100, 1);

    return (dataFactor + deviationFactor) / 2;
  }

  /**
   * Identify possible causes
   */
  private identifyPossibleCauses(
    type: CostAnomaly["anomalyType"],
    deviation: number,
    service: string
  ): string[] {
    const causes: string[] = [];

    if (type === "spike") {
      if (deviation > 0) {
        causes.push("Sudden increase in resource usage");
        causes.push("New resources deployed");
        causes.push("Traffic spike or DDoS attack");
        causes.push("Data transfer surge");
        causes.push("Inefficient code deployment");
      } else {
        causes.push("Resources stopped or terminated");
        causes.push("Traffic reduction");
        causes.push("Cost optimization applied");
      }
    }

    if (type === "trend") {
      if (deviation > 0) {
        causes.push("Gradual increase in usage over time");
        causes.push("Growing user base");
        causes.push("Data accumulation");
        causes.push("Inefficient scaling policies");
      }
    }

    if (type === "pattern") {
      causes.push("Unusual usage pattern detected");
      causes.push("Schedule or automation change");
      causes.push("Seasonal variation");
    }

    if (service.includes("compute") || service.includes("ec2")) {
      causes.push("Check for orphaned or oversized instances");
    }

    if (service.includes("storage") || service.includes("s3")) {
      causes.push("Check for unexpected data growth");
      causes.push("Review lifecycle policies");
    }

    return causes;
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    type: CostAnomaly["anomalyType"],
    service: string,
    cost: number
  ): string[] {
    const recommendations: string[] = [
      "Review recent infrastructure changes",
      "Check CloudWatch/monitoring logs for usage spikes",
      "Verify auto-scaling configurations",
    ];

    if (cost > 1000) {
      recommendations.push("Immediate investigation recommended due to high cost impact");
    }

    if (service.includes("compute")) {
      recommendations.push("Review instance rightsizing opportunities");
      recommendations.push("Check for idle or underutilized instances");
    }

    if (service.includes("database")) {
      recommendations.push("Review query performance and optimization");
      recommendations.push("Check connection pool settings");
    }

    if (service.includes("storage")) {
      recommendations.push("Implement data lifecycle policies");
      recommendations.push("Review storage class optimization");
    }

    recommendations.push("Set up budget alerts to prevent recurrence");

    return recommendations;
  }

  /**
   * Extract provider from key
   */
  private extractProvider(key: string): CloudProvider {
    if (key.includes("aws")) return "aws";
    if (key.includes("azure")) return "azure";
    if (key.includes("gcp")) return "gcp";
    return "aws"; // default
  }

  /**
   * Group data for analysis
   */
  private groupDataForAnalysis(
    data: Map<string, TimeSeriesDataPoint[]>
  ): Map<string, TimeSeriesDataPoint[]> {
    // In production, group by service, environment, resource type, etc.
    return data;
  }

  /**
   * Send notifications for new anomalies
   */
  private async sendNotifications(anomalies: CostAnomaly[]): Promise<void> {
    for (const anomaly of anomalies) {
      if (this.config.notifications.email) {
        await this.sendEmailNotification(anomaly);
      }

      if (this.config.notifications.slack) {
        await this.sendSlackNotification(anomaly);
      }

      if (this.config.notifications.pagerduty && anomaly.severity === "critical") {
        await this.sendPagerDutyAlert(anomaly);
      }

      if (this.config.notifications.webhook) {
        await this.sendWebhook(anomaly);
      }
    }
  }

  /**
   * Send email notification
   */
  private async sendEmailNotification(anomaly: CostAnomaly): Promise<void> {
    console.log(`[Email] Cost anomaly alert: ${anomaly.service}`);
    // In production, use email service (SendGrid, SES, etc.)
  }

  /**
   * Send Slack notification
   */
  private async sendSlackNotification(anomaly: CostAnomaly): Promise<void> {
    console.log(`[Slack] Cost anomaly alert: ${anomaly.service}`);
    // In production, use Slack webhook
    /*
    const message = {
      text: `🚨 Cost Anomaly Detected`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${anomaly.severity.toUpperCase()} Cost Anomaly*\n` +
                  `Service: ${anomaly.service}\n` +
                  `Expected: $${anomaly.expectedCost.toFixed(2)}\n` +
                  `Actual: $${anomaly.actualCost.toFixed(2)}\n` +
                  `Deviation: ${anomaly.deviation.toFixed(1)}%`
          }
        }
      ]
    };
    await fetch(config.notifications.webhook, { method: 'POST', body: JSON.stringify(message) });
    */
  }

  /**
   * Send PagerDuty alert
   */
  private async sendPagerDutyAlert(anomaly: CostAnomaly): Promise<void> {
    console.log(`[PagerDuty] Critical cost anomaly: ${anomaly.service}`);
    // In production, use PagerDuty Events API
  }

  /**
   * Send webhook notification
   */
  private async sendWebhook(anomaly: CostAnomaly): Promise<void> {
    if (!this.config.notifications.webhook) return;

    console.log(`[Webhook] Sending anomaly to ${this.config.notifications.webhook}`);
    // In production, HTTP POST to webhook URL
  }

  /**
   * Add historical data point
   */
  addDataPoint(key: string, timestamp: Date, value: number): void {
    if (!this.historicalData.has(key)) {
      this.historicalData.set(key, []);
    }

    const data = this.historicalData.get(key)!;
    data.push({ timestamp, value });

    // Keep only recent data (e.g., last 90 days)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    this.historicalData.set(
      key,
      data.filter((p) => p.timestamp >= ninetyDaysAgo)
    );
  }

  /**
   * Get all detected anomalies
   */
  getAnomalies(status?: CostAnomaly["status"]): CostAnomaly[] {
    const anomalies = Array.from(this.detectedAnomalies.values());

    if (status) {
      return anomalies.filter((a) => a.status === status);
    }

    return anomalies;
  }

  /**
   * Update anomaly status
   */
  updateAnomalyStatus(
    anomalyId: string,
    status: CostAnomaly["status"],
    notes?: string
  ): void {
    const anomaly = this.detectedAnomalies.get(anomalyId);
    if (!anomaly) {
      throw new Error(`Anomaly ${anomalyId} not found`);
    }

    anomaly.status = status;
    if (notes) anomaly.notes = notes;
    if (status === "resolved") anomaly.resolvedAt = new Date();

    this.detectedAnomalies.set(anomalyId, anomaly);
    console.log(`Anomaly ${anomalyId} status updated to ${status}`);
  }

  /**
   * Get anomaly summary statistics
   */
  getAnomalySummary(days: number = 30): {
    total: number;
    bySeverity: Record<CostAnomaly["severity"], number>;
    byType: Record<CostAnomaly["anomalyType"], number>;
    totalImpact: number;
    avgDetectionTime: number;
  } {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const recentAnomalies = Array.from(this.detectedAnomalies.values()).filter(
      (a) => a.detectedAt >= cutoffDate
    );

    const bySeverity = recentAnomalies.reduce(
      (acc, a) => {
        acc[a.severity] = (acc[a.severity] || 0) + 1;
        return acc;
      },
      {} as Record<CostAnomaly["severity"], number>
    );

    const byType = recentAnomalies.reduce(
      (acc, a) => {
        acc[a.anomalyType] = (acc[a.anomalyType] || 0) + 1;
        return acc;
      },
      {} as Record<CostAnomaly["anomalyType"], number>
    );

    const totalImpact = recentAnomalies.reduce(
      (sum, a) => sum + Math.abs(a.actualCost - a.expectedCost),
      0
    );

    const resolved = recentAnomalies.filter((a) => a.resolvedAt);
    const avgDetectionTime =
      resolved.length > 0
        ? resolved.reduce((sum, a) => {
            const detectionTime =
              a.resolvedAt!.getTime() - a.detectedAt.getTime();
            return sum + detectionTime;
          }, 0) /
          resolved.length /
          (1000 * 60 * 60) // Convert to hours
        : 0;

    return {
      total: recentAnomalies.length,
      bySeverity,
      byType,
      totalImpact,
      avgDetectionTime,
    };
  }
}
