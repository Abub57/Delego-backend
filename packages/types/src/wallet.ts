/** Stellar / Soroban wallet primitives */

export type StellarNetwork = "testnet" | "mainnet" | "futurenet";

export interface WalletAccount {
  address: string;
  network: StellarNetwork;
}

export interface Wallet {
  id: string;
  userId: string;
  address: string;
  publicKey?: string;
  network?: StellarNetwork;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface TransactionRequest {
  sourceAddress: string;
  contractId: string;
  method: string;
  args: unknown[];
  /** Optional ScVal type hints for each arg (e.g. "address", "i128", "u64"). */
  argTypes?: string[];
  /** Human-readable description for approval UI */
  memo: string;
  userId?: string;
  walletId?: string;
  delegationId?: string | null;
  amountStroops?: string;
}

export interface TransactionResult {
  hash: string;
  ledger: number;
  success: boolean;
}

export interface PermissionGrant {
  contractId: string;
  spender: string;
  limit: bigint;
  expiresAt: string | null;
}

/** Faucet dispenser request (Issue #373) */
export interface FaucetRequest {
  destinationAddress: string;
  tokenCode?: string;
  clientToken: string;
}

export interface FaucetResponse {
  success: boolean;
  destinationAddress: string;
  tokenCode: string;
  amountFunded: string;
  txHash: string;
  message?: string;
}
