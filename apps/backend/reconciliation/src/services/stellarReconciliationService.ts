import { sequelize } from "../db.js";
import { LedgerReconciliationDiscrepancy } from "../schemas.js";
import { rpc, Horizon, Operation, TransactionBuilder, Networks, scValToNative, nativeToScVal } from "@stellar/stellar-sdk";
import { createLogger } from "@delegolabs/utils";

const log = createLogger("reconciliation:stellar", process.env.LOG_LEVEL ?? "info");

function getStellarConfig() {
  const network = (process.env.STELLAR_NETWORK ?? "testnet").toLowerCase();
  if (network === "mainnet") {
    return {
      horizonUrl: process.env.STELLAR_HORIZON_URL ?? "https://horizon.stellar.org",
      rpcUrl: process.env.STELLAR_RPC_URL ?? "https://mainnet.sorobanrpc.com",
      networkPassphrase: Networks.PUBLIC,
    };
  }
  if (network === "futurenet") {
    return {
      horizonUrl: process.env.STELLAR_HORIZON_URL ?? "https://horizon-futurenet.stellar.org",
      rpcUrl: process.env.STELLAR_RPC_URL ?? "https://rpc-futurenet.stellar.org",
      networkPassphrase: Networks.FUTURENET,
    };
  }
  return {
    horizonUrl: process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  };
}

export class StellarReconciliationService {
  async reconcileEscrows(): Promise<{ discrepancies: LedgerReconciliationDiscrepancy[] }> {
    const discrepancies: LedgerReconciliationDiscrepancy[] = [];
    
    const [allRecords] = await sequelize.query(`
      SELECT 
        escrow_id, 
        escrow_contract_id, 
        buyer_address,
        amount_stroops, 
        released_amount_stroops, 
        refunded_amount_stroops
      FROM payment_records 
      WHERE escrow_id IS NOT NULL
    `);

    const { horizonUrl, rpcUrl, networkPassphrase } = getStellarConfig();
    const horizon = new Horizon.Server(horizonUrl);
    const rpcServer = new rpc.Server(rpcUrl);

    for (const record of allRecords as any[]) {
      const escrowId = record.escrow_id;
      const escrowContractId = record.escrow_contract_id;
      
      const dbAmount = BigInt(record.amount_stroops) 
        - BigInt(record.released_amount_stroops || '0') 
        - BigInt(record.refunded_amount_stroops || '0');

      let onChainAmount = 0n;

      try {
        const sourceAddress = process.env.ESCROW_READ_SOURCE_ADDRESS || process.env.SETTLEMENT_SOURCE_ADDRESS || record.buyer_address;
        if (!sourceAddress) {
           log.warn(`No source address for escrow ${escrowId}`);
           continue;
        }

        const account = await horizon.loadAccount(sourceAddress);
        const escrowIdNum = Number(escrowId);
        
        let tx = new TransactionBuilder(account, {
          fee: "100",
          networkPassphrase,
        })
        .addOperation(
          Operation.invokeContractFunction({
            contract: escrowContractId,
            function: "get_escrow",
            args: [nativeToScVal(escrowIdNum)],
          })
        )
        .setTimeout(30)
        .build();

        const sim = await rpcServer.simulateTransaction(tx);
        
        if (rpc.Api.isSimulationSuccess(sim) && sim.result && sim.result.retval) {
          const native = scValToNative(sim.result.retval) as any;
          onChainAmount = BigInt(native.amount);
        } else {
          onChainAmount = 0n;
        }
      } catch (err) {
        log.warn(`Error reading escrow ${escrowId} from chain`, { error: err instanceof Error ? err.message : String(err) });
        onChainAmount = 0n;
      }

      if (dbAmount !== onChainAmount) {
        const difference = dbAmount - onChainAmount;
        discrepancies.push({
          escrowId,
          dbAmount,
          onChainAmount,
          difference
        });
        
        log.warn(`Discrepancy found for escrow ${escrowId}`, { dbAmount: dbAmount.toString(), onChainAmount: onChainAmount.toString(), difference: difference.toString() });
      }
    }

    return { discrepancies };
  }
}

export const stellarReconciliationService = new StellarReconciliationService();
