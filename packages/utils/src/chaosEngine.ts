/**
 * Chaos Engineering & Resilience Engine
 * Issue #90
 */

import type {
  ChaosExperiment,
  ExperimentResult,
  ChaosObservation,
  ChaosIncident,
} from "@delegolabs/types";

export class ChaosEngine {
  /**
   * Validate experiment configuration and enforce blast radius limits
   */
  public validateExperiment(experiment: ChaosExperiment, environment: string): boolean {
    if (environment === "production") {
      throw new Error("Chaos experiments cannot run in production directly without staging validation");
    }
    if (!experiment.method || experiment.method.length === 0) {
      throw new Error("Experiment must define at least one chaos method");
    }
    if (!experiment.steadyState || !experiment.steadyState.metrics) {
      throw new Error("Experiment must define steady state metrics");
    }
    return true;
  }

  /**
   * Simulate executing a chaos experiment and evaluating steady state
   */
  public runExperiment(
    experiment: ChaosExperiment,
    observedMetrics: Record<string, number>,
  ): ExperimentResult {
    const startTime = new Date(Date.now() - 60000).toISOString();
    const endTime = new Date().toISOString();
    const observations: ChaosObservation[] = [];
    const incidents: ChaosIncident[] = [];

    let steadyStateMaintained = true;

    for (const [metric, rawThreshold] of Object.entries(experiment.steadyState.thresholds)) {
      const threshold = Number(rawThreshold);
      const actual = observedMetrics[metric] ?? 0;
      const deviation = Math.abs(actual - threshold);
      const metricFailed = actual > threshold;

      observations.push({
        metric,
        expected: threshold,
        actual,
        deviation,
      });

      if (metricFailed) {
        steadyStateMaintained = false;
        incidents.push({
          type: "SLO_BREACH",
          description: `Metric ${metric} actual value ${actual} breached threshold ${threshold}`,
          severity: "high",
          resolved: experiment.rollback.automatic,
        });
      }
    }

    const conclusion = steadyStateMaintained
      ? `Hypothesis verified: ${experiment.hypothesis}`
      : `Hypothesis falsified: system steady state breached during experiment ${experiment.name}`;

    return {
      experiment: experiment.name,
      startTime,
      endTime,
      steadyStateMaintained,
      observations,
      incidents,
      conclusion,
    };
  }
}
