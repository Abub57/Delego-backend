import { timingSafeEqual } from "node:crypto";
import { isValidStellarPublicKey } from "@delegolabs/utils";
import { Pool } from "pg";
import { permissionsService } from "../../permissions/index.js";
import { getRedisConnection } from "../queue/txQueue.js";

export interface EmergencyRevocationDTO {
  walletAddress: string;
  adminSecretToken?: string;
  revokeOnChain: boolean;
}

interface KillSwitchDatabase {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

interface KillSwitchRedis {
  scan(...args: any[]): Promise<any>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export interface EmergencyKillSwitchDependencies {
  database: KillSwitchDatabase;
  redis: KillSwitchRedis;
  revokePermissions: (
    walletAddress: string,
    sessionAddresses: string[],
  ) => Promise<void>;
  adminSecret?: string;
}

export interface EmergencyRevocationResult {
  cancelledProposalCount: number;
  flushedSessionCount: number;
  revokedPermissionCount: number;
}

const SESSION_KEY_PREFIX = "session_key:";
const SCAN_BATCH_SIZE = 250;
const DELETE_BATCH_SIZE = 500;

export class EmergencyKillSwitchService {
  constructor(private readonly dependencies: EmergencyKillSwitchDependencies) {}

  async execute(dto: EmergencyRevocationDTO): Promise<EmergencyRevocationResult> {
    if (!isValidStellarPublicKey(dto.walletAddress)) {
      throw new Error("A valid wallet address is required");
    }
    this.assertAuthorized(dto.adminSecretToken);

    const [cancelledProposals, userIds] = await Promise.all([
      this.dependencies.database.query<{ id: string }>(
        `WITH affected_users AS (
           SELECT id FROM users WHERE stellar_address = $1
           UNION
           SELECT user_id AS id FROM wallets WHERE stellar_address = $1
         ), cancelled AS (
           UPDATE purchase_proposals
              SET status = 'rejected', updated_at = NOW()
            WHERE user_id IN (SELECT id FROM affected_users)
              AND status IN ('pending_approval', 'auto_approved')
          RETURNING id
         )
         SELECT id FROM cancelled`,
        [dto.walletAddress],
      ),
      this.resolveUserIds(dto.walletAddress),
    ]);

    const sessions = await this.findSessions(userIds, dto.walletAddress);
    const sessionKeys = sessions.map(({ key }) => key);
    for (let offset = 0; offset < sessionKeys.length; offset += DELETE_BATCH_SIZE) {
      const batch = sessionKeys.slice(offset, offset + DELETE_BATCH_SIZE);
      if (batch.length > 0) await this.dependencies.redis.del(...batch);
    }

    const sessionAddresses = [...new Set(sessions.map(({ address }) => address))];
    if (dto.revokeOnChain && sessionAddresses.length > 0) {
      await this.dependencies.revokePermissions(dto.walletAddress, sessionAddresses);
    }

    return {
      cancelledProposalCount: cancelledProposals.rows.length,
      flushedSessionCount: sessionKeys.length,
      revokedPermissionCount: dto.revokeOnChain ? sessionAddresses.length : 0,
    };
  }

  private assertAuthorized(token?: string): void {
    const expected = this.dependencies.adminSecret;
    if (!expected) return;
    if (!token) throw new Error("Administrator authorization is required");

    const suppliedBuffer = Buffer.from(token);
    const expectedBuffer = Buffer.from(expected);
    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
      throw new Error("Invalid administrator authorization token");
    }
  }

  private async resolveUserIds(walletAddress: string): Promise<Set<string>> {
    const { rows } = await this.dependencies.database.query<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE stellar_address = $1
       UNION
       SELECT user_id::text AS id FROM wallets WHERE stellar_address = $1`,
      [walletAddress],
    );
    return new Set(rows.map(({ id }) => id));
  }

  private async findSessions(
    userIds: Set<string>,
    walletAddress: string,
  ): Promise<Array<{ key: string; address: string }>> {
    const sessions: Array<{ key: string; address: string }> = [];
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.dependencies.redis.scan(
        cursor,
        "MATCH",
        `${SESSION_KEY_PREFIX}*`,
        "COUNT",
        SCAN_BATCH_SIZE,
      );
      cursor = nextCursor;

      for (const key of keys) {
        const raw = await this.dependencies.redis.get(key);
        if (!raw) continue;
        try {
          const record = JSON.parse(raw) as { userId?: unknown; sessionPublicKey?: unknown };
          if (
            (typeof record.userId === "string" && userIds.has(record.userId)) ||
            record.userId === walletAddress
          ) {
            sessions.push({
              key,
              address: typeof record.sessionPublicKey === "string"
                ? record.sessionPublicKey
                : key.slice(SESSION_KEY_PREFIX.length),
            });
          }
        } catch {
          continue;
        }
      }
    } while (cursor !== "0");

    return sessions;
  }
}

let service: EmergencyKillSwitchService | undefined;

export function getEmergencyKillSwitchService(): EmergencyKillSwitchService {
  if (!service) {
    service = new EmergencyKillSwitchService({
      database: new Pool({ connectionString: process.env.DATABASE_URL }),
      redis: getRedisConnection(),
      revokePermissions: async (walletAddress, sessionAddresses) => {
        const contractId = process.env.SOROBAN_PERMISSIONS_CONTRACT_ID ??
          process.env.PERMISSIONS_CONTRACT_ID ?? "";
        await permissionsService.revokeBatch(contractId, sessionAddresses, walletAddress);
      },
      adminSecret: process.env.KILLSWITCH_ADMIN_SECRET,
    });
  }
  return service;
}