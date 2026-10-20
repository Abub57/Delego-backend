export interface IpfsPinningJobData {
  productId: string;
  mediaUri: string;
  metadataJson: Record<string, unknown>;
}

export interface IpfsPinningResult {
  cid: string;
  gatewayUrl: string;
  pinnedAt: string;
}

export interface IpfsPinningClient {
  pinJson: (payload: Record<string, unknown>) => Promise<{ cid: string }>; 
  pinFile: (mediaUri: string, buffer?: Buffer) => Promise<{ cid: string }>;
}

export interface ProductRecordClient {
  updateProductIpfsMetadata(productId: string, result: IpfsPinningResult): Promise<void>;
}

export const DEFAULT_IPFS_RETRY_DELAYS_MS = [250, 1000, 4000];

export function isTransientIpfsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /timeout|timed out|ECONNRESET|429|5\d\d|gateway/i.test(message);
}

export async function withIpfsRetry<T>(
  operation: () => Promise<T>,
  retries = DEFAULT_IPFS_RETRY_DELAYS_MS
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientIpfsError(error) || attempt >= retries.length) {
        throw error;
      }

      const delayMs = retries[attempt];
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt += 1;
    }
  }
}

export function buildGatewayUrl(cid: string): string {
  const base = process.env.IPFS_GATEWAY_URL ?? "https://ipfs.io";
  return `${base.replace(/\/$/, "")}/ipfs/${cid}`;
}

export async function pinProductToIpfs(
  job: IpfsPinningJobData,
  client: IpfsPinningClient,
  productClient: ProductRecordClient
): Promise<IpfsPinningResult> {
  const metadataResult = await withIpfsRetry(() => client.pinJson(job.metadataJson));
  const mediaResult = await withIpfsRetry(() => client.pinFile(job.mediaUri));

  const cid = metadataResult.cid || mediaResult.cid;
  const result: IpfsPinningResult = {
    cid,
    gatewayUrl: buildGatewayUrl(cid),
    pinnedAt: new Date().toISOString(),
  };

  await productClient.updateProductIpfsMetadata(job.productId, result);
  return result;
}
