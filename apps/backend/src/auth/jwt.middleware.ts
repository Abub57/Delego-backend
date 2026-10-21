import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createClient, RedisClientType } from 'redis';

/**
 * Entry stored in the Redis distributed blacklist for revoked JWTs.
 * TTL is set to the remaining token lifetime so entries expire automatically.
 */
export interface RevokedTokenEntry {
  jti: string;
  userId: string;
  revokedAt: number;
  expiresAt: number;
}

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    jti: string;
    [key: string]: unknown;
  };
}

const BLACKLIST_PREFIX = 'jwt:revoked:';

let redisClient: RedisClientType | null = null;

/**
 * Lazily initialize a shared Redis client used to synchronize the JWT
 * revocation blacklist across all API gateways / microservices.
 */
export async function getRedisClient(): Promise<RedisClientType> {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  });

  redisClient.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[jwt-blacklist] Redis client error', err);
  });

  await redisClient.connect();
  return redisClient;
}

function blacklistKey(jti: string): string {
  return `${BLACKLIST_PREFIX}${jti}`;
}

/**
 * Store a revoked token jti in Redis with a TTL matching the remaining
 * token lifetime. Once the token would have expired naturally, the entry
 * is evicted automatically.
 */
export async function revokeToken(entry: RevokedTokenEntry): Promise<void> {
  const ttlSeconds = Math.floor((entry.expiresAt - Date.now()) / 1000);
  if (ttlSeconds <= 0) {
    // Token already expired; nothing to blacklist.
    return;
  }

  const client = await getRedisClient();
  await client.set(blacklistKey(entry.jti), JSON.stringify(entry), {
    EX: ttlSeconds,
  });
}

/**
 * Check whether a token jti has been revoked. Shared by every API gateway
 * so revocation propagates immediately across microservices.
 */
export async function isTokenRevoked(jti: string): Promise<boolean> {
  const client = await getRedisClient();
  const result = await client.exists(blacklistKey(jti));
  return result === 1;
}

/**
 * JWT authentication middleware. Verifies the bearer token signature and
 * rejects any token whose jti appears in the distributed Redis blacklist.
 */
export function jwtAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'JWT secret is not configured' });
    return;
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, secret) as jwt.JwtPayload;
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  const jti = typeof payload.jti === 'string' ? payload.jti : undefined;
  const userId =
    typeof payload.sub === 'string'
      ? payload.sub
      : typeof payload.userId === 'string'
        ? payload.userId
        : undefined;

  if (!jti || !userId) {
    res.status(401).json({ error: 'Token is missing required claims' });
    return;
  }

  isTokenRevoked(jti)
    .then((revoked) => {
      if (revoked) {
        res.status(401).json({ error: 'Token has been revoked' });
        return;
      }

      req.user = { userId, jti, ...payload };
      next();
    })
    .catch((err) => {
      // Fail closed: if the blacklist cannot be consulted, reject the token.
      // eslint-disable-next-line no-console
      console.error('[jwt-blacklist] Failed to check revocation status', err);
      res.status(503).json({ error: 'Unable to verify token revocation status' });
    });
}

export default jwtAuthMiddleware;
