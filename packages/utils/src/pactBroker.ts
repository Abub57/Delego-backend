/**
 * Pact Contract Testing & Verification Harness
 * Issue #88
 */

import type {
  PactContract,
  ContractVerificationResult,
  CanIDeployResult,
} from "@delegolabs/types";

export class PactBrokerManager {
  private contracts: Map<string, PactContract> = new Map();
  private verifications: Map<string, ContractVerificationResult[]> = new Map();

  /**
   * Register a contract between consumer and provider
   */
  public registerContract(contract: PactContract): void {
    const key = `${contract.consumer}->${contract.provider}`;
    this.contracts.set(key, contract);
  }

  /**
   * Verify all interactions in a contract for a specific provider version
   */
  public verifyContract(
    consumer: string,
    provider: string,
    providerVersion: string,
  ): ContractVerificationResult {
    const key = `${consumer}->${provider}`;
    const contract = this.contracts.get(key);

    if (!contract) {
      throw new Error(`Contract not found for ${key}`);
    }

    const failedInteractions: Array<{ interaction: string; error: string }> = [];
    let verifiedCount = 0;

    for (const interaction of contract.interactions) {
      // Validate request / response matching
      if (!interaction.request.method || !interaction.request.path) {
        failedInteractions.push({
          interaction: interaction.description,
          error: "Invalid request specification",
        });
      } else if (interaction.response.status < 100 || interaction.response.status >= 600) {
        failedInteractions.push({
          interaction: interaction.description,
          error: `Invalid response status: ${interaction.response.status}`,
        });
      } else {
        verifiedCount++;
      }
    }

    const success = failedInteractions.length === 0;
    const result: ContractVerificationResult = {
      provider,
      version: providerVersion,
      success,
      verifiedInteractions: verifiedCount,
      failedInteractions,
      verificationDate: new Date().toISOString(),
    };

    const existing = this.verifications.get(key) ?? [];
    existing.push(result);
    this.verifications.set(key, existing);

    return result;
  }

  /**
   * Check if a specific service version is safe to deploy
   */
  public canIDeploy(
    serviceName: string,
    version: string,
    role: "consumer" | "provider",
  ): CanIDeployResult {
    const missingVerifications: Array<{ consumer: string; consumerVersion: string }> = [];

    for (const [key, contract] of this.contracts.entries()) {
      if (role === "provider" && contract.provider === serviceName) {
        const history = this.verifications.get(key) ?? [];
        const valid = history.some((h) => h.version === version && h.success);
        if (!valid) {
          missingVerifications.push({
            consumer: contract.consumer,
            consumerVersion: "latest",
          });
        }
      }
    }

    return {
      version,
      canDeploy: missingVerifications.length === 0,
      missingVerifications,
    };
  }

  /**
   * Generate contract documentation
   */
  public generateDocumentation(consumer: string, provider: string): string {
    const key = `${consumer}->${provider}`;
    const contract = this.contracts.get(key);
    if (!contract) return `No contract found for ${key}`;

    return [
      `# Contract: ${contract.consumer} -> ${contract.provider}`,
      `**Specification:** ${contract.metadata.pactSpecification}`,
      `**Generated:** ${contract.metadata.timestamp}`,
      ``,
      `## Interactions`,
      ...contract.interactions.map(
        (i: any, idx: number) => `### ${idx + 1}. ${i.description}
- **Request:** \`${i.request.method} ${i.request.path}\`
- **Response Status:** \`${i.response.status}\``,
      ),
    ].join("\n");
  }
}
