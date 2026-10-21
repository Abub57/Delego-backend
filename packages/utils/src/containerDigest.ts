import type { ContainerDigestVerification } from "@delegolabs/types";
import { exec } from "child_process";

export class ContainerRolloutVerifier {
  public async inspectImageDigest(imageName: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(`docker inspect --format="{{index .RepoDigests 0}}" ${imageName}`, (error, stdout, _stderr) => {
        if (error) {
          reject(new Error(`Failed to inspect image digest for ${imageName}: ${error.message}`));
          return;
        }
        
        const digest = stdout.trim();
        if (!digest || digest === "<no value>") {
          reject(new Error(`No digest found for image ${imageName}`));
          return;
        }

        const parts = digest.split("@");
        resolve(parts.length > 1 ? parts[1] : digest);
      });
    });
  }

  public async verifyDigestBeforeRollout(
    imageName: string,
    expectedDigest: string
  ): Promise<ContainerDigestVerification> {
    const actualDigest = await this.inspectImageDigest(imageName);
    const verified = actualDigest === expectedDigest;

    if (!verified) {
      throw new Error(`Rollout blocked: Digest mismatch for image ${imageName}. Expected ${expectedDigest}, got ${actualDigest}`);
    }

    return {
      imageName,
      expectedDigest,
      verified,
    };
  }
}

