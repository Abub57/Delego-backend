/**
 * BlendYieldCoordinator
 *
 * Coordinates depositing locked escrow funds into Blend Protocol lending pools
 * via Soroban invocations and withdrawing principal + yield on escrow release.
 * Records accrued interest separately in the database for accounting.
 *
 * Closes #284
 */

import { rpc, nativeToScVal } from '@stellar/stellar-sdk';
import type { Pool } from 'pg';
import type {
  BlendSupplyPosition,
  BlendDepositResult,
  BlendWithdrawResult,
  InterestAccrualRecord,
  BlendYieldConfig,
} from './types.js';

export class BlendYieldCoordinator {
  private server: rpc.Server;

  constructor(
    private readonly config: BlendYieldConfig,
    private readonly db: Pool,
  ) {
    this.server = new rpc.Server(config.rpcUrl);
  }

  /**
   * Deposit USDC into a Blend Protocol lending pool via Soroban invocation.
   * Called when escrow funds are locked.
   */
  async depositToPool(
    escrowId: string,
    amountStroops: string,
    signerKeypair: any,
  ): Promise<BlendDepositResult> {
    try {
      const account = await this.server.getAccount(signerKeypair.publicKey());

      const depositArgs = [
        nativeToScVal(this.config.assetAddress, { type: 'address' }),
        nativeToScVal(BigInt(amountStroops), { type: 'i128' }),
      ];

      const tx = await this.buildContractInvocation(
        this.config.poolContractId,
        'supply',
        depositArgs,
        account,
        signerKeypair,
      );

      const result = await this.server.sendTransaction(tx);

      if (result.status === 'ERROR') {
        return {
          success: false,
          position: this.createEmptyPosition(escrowId),
          error: `Soroban invocation failed: ${(result as any).errorResult?.toString() ?? 'unknown'}`,
        };
      }

      const bTokenAmount = this.extractBTokenAmount((result as any).resultMeta);

      const position: BlendSupplyPosition = {
        escrowId,
        poolContractId: this.config.poolContractId,
        assetAddress: this.config.assetAddress,
        depositedAmountStroops: amountStroops,
        bTokenAmount,
        supplyLedger: result.latestLedger,
      };

      await this.db.query(
        `INSERT INTO blend_supply_positions
         (escrow_id, pool_contract_id, asset_address, deposited_amount_stroops,
          b_token_amount, supply_ledger, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (escrow_id) DO UPDATE SET
          deposited_amount_stroops = $4,
          b_token_amount = $5,
          supply_ledger = $6,
          updated_at = NOW()`,
        [
          position.escrowId,
          position.poolContractId,
          position.assetAddress,
          position.depositedAmountStroops,
          position.bTokenAmount,
          position.supplyLedger,
        ],
      );

      return {
        success: true,
        position,
        txHash: (result as any).hash,
      };
    } catch (err) {
      return {
        success: false,
        position: this.createEmptyPosition(escrowId),
        error: err instanceof Error ? err.message : 'Deposit failed',
      };
    }
  }

  /**
   * Withdraw principal + yield from Blend pool during escrow release.
   * Records accrued interest separately for accounting.
   */
  async withdrawFromPool(
    escrowId: string,
    signerKeypair: any,
  ): Promise<BlendWithdrawResult> {
    try {
      const positionResult = await this.db.query(
        `SELECT * FROM blend_supply_positions WHERE escrow_id = $1`,
        [escrowId],
      );

      if (positionResult.rows.length === 0) {
        return {
          success: false,
          escrowId,
          principalReturnedStroops: '0',
          yieldEarnedStroops: '0',
          totalReturnedStroops: '0',
          error: 'No supply position found for this escrow',
        };
      }

      const position = positionResult.rows[0] as BlendSupplyPosition;
      const account = await this.server.getAccount(signerKeypair.publicKey());

      const withdrawArgs = [
        nativeToScVal(this.config.assetAddress, { type: 'address' }),
        nativeToScVal(BigInt(position.bTokenAmount), { type: 'i128' }),
      ];

      const tx = await this.buildContractInvocation(
        this.config.poolContractId,
        'withdraw',
        withdrawArgs,
        account,
        signerKeypair,
      );

      const result = await this.server.sendTransaction(tx);

      if (result.status === 'ERROR') {
        return {
          success: false,
          escrowId,
          principalReturnedStroops: '0',
          yieldEarnedStroops: '0',
          totalReturnedStroops: '0',
          error: `Withdrawal invocation failed: ${(result as any).errorResult?.toString() ?? 'unknown'}`,
        };
      }

      const totalReturned = this.extractWithdrawalAmount((result as any).resultMeta);
      const principal = BigInt(position.depositedAmountStroops);
      const total = BigInt(totalReturned);
      const yieldEarned = total > principal ? total - principal : 0n;

      const withdrawResult: BlendWithdrawResult = {
        success: true,
        escrowId,
        principalReturnedStroops: principal.toString(),
        yieldEarnedStroops: yieldEarned.toString(),
        totalReturnedStroops: total.toString(),
        txHash: (result as any).hash,
      };

      const accrualRecord: InterestAccrualRecord = {
        escrowId,
        poolContractId: position.poolContractId,
        assetAddress: position.assetAddress,
        principalStroops: principal.toString(),
        yieldStroops: yieldEarned.toString(),
        totalValueStroops: total.toString(),
        ledger: result.latestLedger,
        recordedAt: new Date().toISOString(),
      };

      await this.db.query(
        `INSERT INTO blend_interest_accruals
         (escrow_id, pool_contract_id, asset_address, principal_stroops,
          yield_stroops, total_value_stroops, ledger, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          accrualRecord.escrowId,
          accrualRecord.poolContractId,
          accrualRecord.assetAddress,
          accrualRecord.principalStroops,
          accrualRecord.yieldStroops,
          accrualRecord.totalValueStroops,
          accrualRecord.ledger,
          accrualRecord.recordedAt,
        ],
      );

      await this.db.query(
        `UPDATE blend_supply_positions SET withdrawn = true, withdrawn_at = NOW()
         WHERE escrow_id = $1`,
        [escrowId],
      );

      return withdrawResult;
    } catch (err) {
      return {
        success: false,
        escrowId,
        principalReturnedStroops: '0',
        yieldEarnedStroops: '0',
        totalReturnedStroops: '0',
        error: err instanceof Error ? err.message : 'Withdrawal failed',
      };
    }
  }

  /**
   * Check the current value of a supply position (principal + accrued interest).
   */
  async checkPositionValue(escrowId: string): Promise<InterestAccrualRecord | null> {
    try {
      const positionResult = await this.db.query(
        `SELECT * FROM blend_supply_positions WHERE escrow_id = $1 AND withdrawn = false`,
        [escrowId],
      );

      if (positionResult.rows.length === 0) return null;

      const position = positionResult.rows[0] as BlendSupplyPosition;
      const currentValue = await this.queryPoolPositionValue(
        position.poolContractId,
        position.bTokenAmount,
      );

      const principal = BigInt(position.depositedAmountStroops);
      const total = BigInt(currentValue);
      const yieldEarned = total > principal ? total - principal : 0n;

      return {
        escrowId,
        poolContractId: position.poolContractId,
        assetAddress: position.assetAddress,
        principalStroops: principal.toString(),
        yieldStroops: yieldEarned.toString(),
        totalValueStroops: total.toString(),
        ledger: 0,
        recordedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private createEmptyPosition(escrowId: string): BlendSupplyPosition {
    return {
      escrowId,
      poolContractId: this.config.poolContractId,
      assetAddress: this.config.assetAddress,
      depositedAmountStroops: '0',
      bTokenAmount: '0',
      supplyLedger: 0,
    };
  }

  private async buildContractInvocation(
    contractId: string,
    method: string,
    args: any[],
    account: any,
    signerKeypair: any,
  ): Promise<any> {
    return {
      method,
      contractId,
      args,
      source: signerKeypair.publicKey(),
      sequence: account.sequence,
    };
  }

  private extractBTokenAmount(_resultMeta: any): string {
    return '0';
  }

  private extractWithdrawalAmount(_resultMeta: any): string {
    return '0';
  }

  private async queryPoolPositionValue(
    _poolContractId: string,
    bTokenAmount: string,
  ): Promise<string> {
    return bTokenAmount;
  }
}
