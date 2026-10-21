export interface ContainerDigestVerification {
  imageName: string;
  expectedDigest: string;
  verified: boolean;
}
