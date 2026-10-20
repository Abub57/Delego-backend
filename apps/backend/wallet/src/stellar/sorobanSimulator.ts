import { rpc as SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import {
  readSorobanRpcConfig,
  SorobanTransactionSimulator,
} from "../sorobanSimulator.js";

export interface SorobanSimulationResult {
  minResourceFee: string;
  cpuInstructions: number;
  memoryBytes: number;
  readOnlyFootprint: string[];
  readWriteFootprint: string[];
  success: boolean;
  simulationError?: string;
}

export type SorobanDiagnosticEvents =
  SorobanRpc.Api.SimulateTransactionResponse["events"];

export class SorobanSimulationError extends Error {
  public readonly diagnosticEvents: SorobanDiagnosticEvents;

  constructor(message: string, diagnosticEvents: SorobanDiagnosticEvents) {
    super(message);
    this.name = "SorobanSimulationError";
    this.diagnosticEvents = diagnosticEvents;
  }
}

type SimulationClient = Pick<SorobanTransactionSimulator, "simulateTransaction">;

const SAFETY_BUFFER_NUMERATOR = 115n;
const SAFETY_BUFFER_DENOMINATOR = 100n;

function applySafetyBuffer(value: number | bigint): number {
  const integerValue = BigInt(value.toString());
  const buffered =
    (integerValue * SAFETY_BUFFER_NUMERATOR + SAFETY_BUFFER_DENOMINATOR - 1n) /
    SAFETY_BUFFER_DENOMINATOR;
  const result = Number(buffered);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("Buffered Soroban resource requirement exceeds the safe integer range");
  }
  return result;
}

function applyFeeBuffer(fee: string): string {
  if (!/^\d+$/.test(fee)) {
    throw new TypeError(`Invalid Soroban minimum resource fee: ${fee}`);
  }
  const feeValue = BigInt(fee);
  return (
    (feeValue * SAFETY_BUFFER_NUMERATOR + SAFETY_BUFFER_DENOMINATOR - 1n) /
    SAFETY_BUFFER_DENOMINATOR
  ).toString();
}

function encodeFootprintKey(key: { toXDR(): Buffer }): string {
  return key.toXDR().toString("base64");
}

export class SorobanSimulationService {
  private readonly simulator: SimulationClient;

  constructor(
    simulator: SimulationClient = new SorobanTransactionSimulator(readSorobanRpcConfig()),
  ) {
    this.simulator = simulator;
  }

  public async simulateTransaction(
    transaction: Transaction,
  ): Promise<SorobanSimulationResult> {
    const response = await this.simulator.simulateTransaction(transaction);
    if (!SorobanRpc.Api.isSimulationSuccess(response)) {
      const error = SorobanRpc.Api.isSimulationError(response)
        ? response.error
        : "Soroban simulation returned an unexpected response";
      throw new SorobanSimulationError(error, response.events ?? []);
    }

    const transactionData = response.transactionData;
    const resources = transactionData.build().resources();

    return {
      minResourceFee: applyFeeBuffer(response.minResourceFee),
      cpuInstructions: applySafetyBuffer(resources.instructions()),
      memoryBytes: applySafetyBuffer(resources.writeBytes()),
      readOnlyFootprint: transactionData.getReadOnly().map(encodeFootprintKey),
      readWriteFootprint: transactionData.getReadWrite().map(encodeFootprintKey),
      success: true,
    };
  }
}
