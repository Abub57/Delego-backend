/**
 * Multi-Cloud Billing Ingestion Service
 * 
 * Handles billing data ingestion from AWS, Azure, and GCP.
 * Supports Cost Explorer, Azure Cost Management, and GCP Billing Export.
 */

import type {
  CloudProvider,
  BillingRecord,
  BillingIngestionResult,
  CostOptimizationConfig,
} from "../types.js";

export interface BillingProvider {
  name: CloudProvider;
  fetchBillingData(startDate: Date, endDate: Date): Promise<BillingRecord[]>;
  validateCredentials(): Promise<boolean>;
}

/**
 * AWS Billing Provider
 * Uses AWS Cost Explorer API
 */
export class AWSBillingProvider implements BillingProvider {
  name: CloudProvider = "aws";
  
  private config: NonNullable<CostOptimizationConfig["providers"]["aws"]>;

  constructor(config: NonNullable<CostOptimizationConfig["providers"]["aws"]>) {
    this.config = config;
  }

  async validateCredentials(): Promise<boolean> {
    try {
      // In production, use AWS SDK to verify credentials
      // Example: await sts.getCallerIdentity()
      
      if (!this.config.credentials.accessKeyId && !this.config.credentials.roleArn) {
        throw new Error("AWS credentials not configured");
      }
      
      return true;
    } catch (error) {
      console.error("AWS credential validation failed:", error);
      return false;
    }
  }

  async fetchBillingData(startDate: Date, endDate: Date): Promise<BillingRecord[]> {
    const records: BillingRecord[] = [];
    
    try {
      // In production, use AWS Cost Explorer API
      // const costExplorer = new AWS.CostExplorer();
      // const response = await costExplorer.getCostAndUsage({ ... }).promise();
      
      // Mock implementation for demonstration
      const mockData = this.generateMockAWSData(startDate, endDate);
      records.push(...mockData);
      
      console.log(`Fetched ${records.length} AWS billing records`);
      return records;
    } catch (error) {
      console.error("AWS billing ingestion failed:", error);
      throw error;
    }
  }

  private generateMockAWSData(startDate: Date, endDate: Date): BillingRecord[] {
    // Mock data generator for testing
    const services = ["EC2", "RDS", "S3", "Lambda", "CloudFront", "ECS"];
    const regions = ["us-east-1", "us-west-2", "eu-west-1"];
    const records: BillingRecord[] = [];
    
    for (const accountId of this.config.accountIds) {
      for (const service of services) {
        const cost = Math.random() * 1000;
        
        records.push({
          id: `aws-${accountId}-${service}-${Date.now()}`,
          provider: "aws",
          accountId,
          serviceCategory: this.mapServiceToCategory(service),
          serviceName: service,
          resourceId: `arn:aws:${service.toLowerCase()}:${regions[0]}:${accountId}:resource/id`,
          resourceType: this.mapServiceToResourceType(service),
          usageType: "BoxUsage",
          operation: "RunInstances",
          region: regions[Math.floor(Math.random() * regions.length)],
          cost,
          currency: "USD",
          usageAmount: Math.random() * 100,
          usageUnit: "Hours",
          startTime: startDate,
          endTime: endDate,
          tags: {
            Environment: Math.random() > 0.5 ? "production" : "development",
            Team: `Team-${Math.floor(Math.random() * 5) + 1}`,
            Project: `Project-${String.fromCharCode(65 + Math.floor(Math.random() * 3))}`,
          },
          metadata: {
            instanceType: "t3.medium",
            availabilityZone: `${regions[0]}a`,
          },
        });
      }
    }
    
    return records;
  }

  private mapServiceToCategory(service: string): string {
    const mapping: Record<string, string> = {
      EC2: "compute",
      RDS: "database",
      S3: "storage",
      Lambda: "serverless",
      CloudFront: "network",
      ECS: "container",
    };
    return mapping[service] || "other";
  }

  private mapServiceToResourceType(service: string): BillingRecord["resourceType"] {
    const mapping: Record<string, BillingRecord["resourceType"]> = {
      EC2: "compute",
      RDS: "database",
      S3: "storage",
      Lambda: "serverless",
      CloudFront: "network",
      ECS: "container",
    };
    return mapping[service] || "other";
  }
}

/**
 * Azure Billing Provider
 * Uses Azure Cost Management API
 */
export class AzureBillingProvider implements BillingProvider {
  name: CloudProvider = "azure";
  
  private config: NonNullable<CostOptimizationConfig["providers"]["azure"]>;

  constructor(config: NonNullable<CostOptimizationConfig["providers"]["azure"]>) {
    this.config = config;
  }

  async validateCredentials(): Promise<boolean> {
    try {
      // In production, use Azure SDK to verify credentials
      // Example: await credential.getToken(["https://management.azure.com/.default"])
      
      if (!this.config.credentials.clientId || !this.config.credentials.tenantId) {
        throw new Error("Azure credentials not configured");
      }
      
      return true;
    } catch (error) {
      console.error("Azure credential validation failed:", error);
      return false;
    }
  }

  async fetchBillingData(startDate: Date, endDate: Date): Promise<BillingRecord[]> {
    const records: BillingRecord[] = [];
    
    try {
      // In production, use Azure Cost Management API
      // const client = new CostManagementClient(credential, subscriptionId);
      // const response = await client.query.usage(...);
      
      // Mock implementation
      const mockData = this.generateMockAzureData(startDate, endDate);
      records.push(...mockData);
      
      console.log(`Fetched ${records.length} Azure billing records`);
      return records;
    } catch (error) {
      console.error("Azure billing ingestion failed:", error);
      throw error;
    }
  }

  private generateMockAzureData(startDate: Date, endDate: Date): BillingRecord[] {
    const services = ["Virtual Machines", "SQL Database", "Storage", "App Service", "AKS"];
    const regions = ["eastus", "westus2", "northeurope"];
    const records: BillingRecord[] = [];
    
    for (const subscriptionId of this.config.subscriptionIds) {
      for (const service of services) {
        const cost = Math.random() * 800;
        
        records.push({
          id: `azure-${subscriptionId}-${service}-${Date.now()}`,
          provider: "azure",
          accountId: subscriptionId,
          serviceCategory: this.mapServiceToCategory(service),
          serviceName: service,
          resourceId: `/subscriptions/${subscriptionId}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01`,
          resourceType: this.mapServiceToResourceType(service),
          usageType: "Compute",
          operation: "VM.Standard",
          region: regions[Math.floor(Math.random() * regions.length)],
          cost,
          currency: "USD",
          usageAmount: Math.random() * 100,
          usageUnit: "Hours",
          startTime: startDate,
          endTime: endDate,
          tags: {
            Environment: Math.random() > 0.5 ? "production" : "staging",
            CostCenter: `CC-${Math.floor(Math.random() * 1000)}`,
            Owner: `owner-${Math.floor(Math.random() * 10)}`,
          },
          metadata: {
            vmSize: "Standard_D2s_v3",
            resourceGroup: "rg-prod",
          },
        });
      }
    }
    
    return records;
  }

  private mapServiceToCategory(service: string): string {
    const mapping: Record<string, string> = {
      "Virtual Machines": "compute",
      "SQL Database": "database",
      Storage: "storage",
      "App Service": "compute",
      AKS: "container",
    };
    return mapping[service] || "other";
  }

  private mapServiceToResourceType(service: string): BillingRecord["resourceType"] {
    const mapping: Record<string, BillingRecord["resourceType"]> = {
      "Virtual Machines": "compute",
      "SQL Database": "database",
      Storage: "storage",
      "App Service": "compute",
      AKS: "container",
    };
    return mapping[service] || "other";
  }
}

/**
 * GCP Billing Provider
 * Uses BigQuery Billing Export
 */
export class GCPBillingProvider implements BillingProvider {
  name: CloudProvider = "gcp";
  
  private config: NonNullable<CostOptimizationConfig["providers"]["gcp"]>;

  constructor(config: NonNullable<CostOptimizationConfig["providers"]["gcp"]>) {
    this.config = config;
  }

  async validateCredentials(): Promise<boolean> {
    try {
      // In production, use GCP SDK to verify credentials
      // Example: await auth.getProjectId()
      
      if (!this.config.credentials.project_id || !this.config.billingAccountId) {
        throw new Error("GCP credentials not configured");
      }
      
      return true;
    } catch (error) {
      console.error("GCP credential validation failed:", error);
      return false;
    }
  }

  async fetchBillingData(startDate: Date, endDate: Date): Promise<BillingRecord[]> {
    const records: BillingRecord[] = [];
    
    try {
      // In production, use BigQuery to query billing export table
      // const bigquery = new BigQuery();
      // const query = `SELECT * FROM \`project.dataset.gcp_billing_export_v1_XXXXX\` WHERE ...`;
      // const [rows] = await bigquery.query({ query });
      
      // Mock implementation
      const mockData = this.generateMockGCPData(startDate, endDate);
      records.push(...mockData);
      
      console.log(`Fetched ${records.length} GCP billing records`);
      return records;
    } catch (error) {
      console.error("GCP billing ingestion failed:", error);
      throw error;
    }
  }

  private generateMockGCPData(startDate: Date, endDate: Date): BillingRecord[] {
    const services = ["Compute Engine", "Cloud SQL", "Cloud Storage", "Cloud Functions", "GKE"];
    const regions = ["us-central1", "us-east1", "europe-west1"];
    const records: BillingRecord[] = [];
    
    for (const projectId of this.config.projectIds) {
      for (const service of services) {
        const cost = Math.random() * 600;
        
        records.push({
          id: `gcp-${projectId}-${service}-${Date.now()}`,
          provider: "gcp",
          accountId: projectId,
          serviceCategory: this.mapServiceToCategory(service),
          serviceName: service,
          resourceId: `projects/${projectId}/zones/${regions[0]}/instances/instance-1`,
          resourceType: this.mapServiceToResourceType(service),
          usageType: "Compute",
          operation: "compute.instances.run",
          region: regions[Math.floor(Math.random() * regions.length)],
          cost,
          currency: "USD",
          usageAmount: Math.random() * 100,
          usageUnit: "Hours",
          startTime: startDate,
          endTime: endDate,
          tags: {
            env: Math.random() > 0.5 ? "prod" : "dev",
            team: `team-${Math.floor(Math.random() * 3) + 1}`,
            application: `app-${String.fromCharCode(97 + Math.floor(Math.random() * 3))}`,
          },
          metadata: {
            machineType: "n1-standard-2",
            zone: `${regions[0]}-a`,
          },
        });
      }
    }
    
    return records;
  }

  private mapServiceToCategory(service: string): string {
    const mapping: Record<string, string> = {
      "Compute Engine": "compute",
      "Cloud SQL": "database",
      "Cloud Storage": "storage",
      "Cloud Functions": "serverless",
      GKE: "container",
    };
    return mapping[service] || "other";
  }

  private mapServiceToResourceType(service: string): BillingRecord["resourceType"] {
    const mapping: Record<string, BillingRecord["resourceType"]> = {
      "Compute Engine": "compute",
      "Cloud SQL": "database",
      "Cloud Storage": "storage",
      "Cloud Functions": "serverless",
      GKE: "container",
    };
    return mapping[service] || "other";
  }
}

/**
 * Multi-Cloud Billing Ingestion Orchestrator
 */
export class BillingIngestionService {
  private providers: Map<CloudProvider, BillingProvider> = new Map();
  private config: CostOptimizationConfig;

  constructor(config: CostOptimizationConfig) {
    this.config = config;
    this.initializeProviders();
  }

  private initializeProviders(): void {
    // Initialize AWS provider
    if (this.config.providers.aws?.enabled && this.config.providers.aws) {
      const awsProvider = new AWSBillingProvider(this.config.providers.aws);
      this.providers.set("aws", awsProvider);
    }

    // Initialize Azure provider
    if (this.config.providers.azure?.enabled && this.config.providers.azure) {
      const azureProvider = new AzureBillingProvider(this.config.providers.azure);
      this.providers.set("azure", azureProvider);
    }

    // Initialize GCP provider
    if (this.config.providers.gcp?.enabled && this.config.providers.gcp) {
      const gcpProvider = new GCPBillingProvider(this.config.providers.gcp);
      this.providers.set("gcp", gcpProvider);
    }

    console.log(`Initialized ${this.providers.size} billing providers`);
  }

  async validateAllCredentials(): Promise<Record<CloudProvider, boolean>> {
    const results: Partial<Record<CloudProvider, boolean>> = {};

    for (const [provider, instance] of this.providers) {
      results[provider] = await instance.validateCredentials();
    }

    return results as Record<CloudProvider, boolean>;
  }

  async ingestBillingData(
    provider: CloudProvider,
    startDate: Date,
    endDate: Date
  ): Promise<BillingIngestionResult> {
    const startTime = Date.now();
    const providerInstance = this.providers.get(provider);

    if (!providerInstance) {
      throw new Error(`Provider ${provider} not initialized`);
    }

    try {
      const records = await providerInstance.fetchBillingData(startDate, endDate);
      
      // In production, persist records to database
      // await this.persistRecords(records);
      
      const totalCost = records.reduce((sum, record) => sum + record.cost, 0);
      const duration = Date.now() - startTime;

      return {
        provider,
        recordsIngested: records.length,
        totalCost,
        startDate,
        endDate,
        duration,
        errors: [],
      };
    } catch (error) {
      return {
        provider,
        recordsIngested: 0,
        totalCost: 0,
        startDate,
        endDate,
        duration: Date.now() - startTime,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  async ingestAllProviders(
    startDate: Date,
    endDate: Date
  ): Promise<BillingIngestionResult[]> {
    const results: BillingIngestionResult[] = [];

    // Ingest from all providers in parallel
    const promises = Array.from(this.providers.keys()).map((provider) =>
      this.ingestBillingData(provider, startDate, endDate)
    );

    const settled = await Promise.allSettled(promises);

    settled.forEach((result) => {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        console.error("Billing ingestion failed:", result.reason);
      }
    });

    return results;
  }

  async schedulePeriodicIngestion(intervalHours: number = 24): Promise<void> {
    console.log(`Scheduling periodic billing ingestion every ${intervalHours} hours`);

    const runIngestion = async () => {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - intervalHours * 60 * 60 * 1000);

      console.log(`Running scheduled billing ingestion: ${startDate.toISOString()} to ${endDate.toISOString()}`);

      const results = await this.ingestAllProviders(startDate, endDate);

      const summary = results.map((r) => ({
        provider: r.provider,
        records: r.recordsIngested,
        cost: r.totalCost.toFixed(2),
        duration: `${r.duration}ms`,
      }));

      console.log("Billing ingestion completed:", JSON.stringify(summary, null, 2));
    };

    // Run immediately on start
    await runIngestion();

    // Schedule periodic execution
    setInterval(runIngestion, intervalHours * 60 * 60 * 1000);
  }

  private async persistRecords(records: BillingRecord[]): Promise<void> {
    // In production, batch insert to database
    // Example using PostgreSQL:
    // await db.billingRecords.createMany({ data: records });
    console.log(`Persisting ${records.length} billing records to database`);
  }
}
