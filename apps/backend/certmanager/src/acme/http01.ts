import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * #597 — HTTP-01 challenge completion.
 *
 * Let's Encrypt validates `http://<customDomain>/.well-known/acme-challenge/<token>`
 * and expects the challenge's key authorization as the response body. The
 * worker publishes each challenge here; the Delego edge server (which owns the
 * merchant domains) reverse-proxies that path to `Http01ChallengeServer`, so
 * the certificate manager never has to terminate merchant traffic itself.
 */
export interface Http01Challenge {
  domain: string;
  /** The challenge token from the ACME order — the last URL path segment. */
  token: string;
  /** The key authorization the CA expects as the response body. */
  keyAuthorization: string;
}

export interface Http01ChallengeResponder {
  present(challenge: Http01Challenge): Promise<void>;
  cleanup(challenge: Http01Challenge): Promise<void>;
}

export const HTTP01_CHALLENGE_PREFIX = "/.well-known/acme-challenge/";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Process-local challenge store. The edge must forward challenge traffic to
 * the same certmanager instance that is driving the ACME order (sticky routing
 * by merchant/domain), or a shared responder implementation must be supplied.
 */
export class InMemoryHttp01ChallengeResponder implements Http01ChallengeResponder {
  private readonly challenges = new Map<string, Http01Challenge>();

  async present(challenge: Http01Challenge): Promise<void> {
    if (!TOKEN_PATTERN.test(challenge.token)) {
      throw new Error(`invalid http-01 challenge token: ${challenge.token}`);
    }
    this.challenges.set(challenge.token, challenge);
  }

  async cleanup(challenge: Http01Challenge): Promise<void> {
    this.challenges.delete(challenge.token);
  }

  /** Returns the key authorization for a token, or undefined if not pending. */
  getKeyAuthorization(token: string): string | undefined {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    return this.challenges.get(token)?.keyAuthorization;
  }

  get size(): number {
    return this.challenges.size;
  }
}

export interface Http01ChallengeServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export interface Http01ChallengeServerOptions {
  host?: string;
  /** Port the edge proxies `/.well-known/acme-challenge/` to. */
  port?: number;
}

/**
 * Minimal plain-HTTP server for challenge responses. It intentionally serves
 * nothing else so it can be safely exposed to the edge network.
 */
export async function startHttp01ChallengeServer(
  responder: InMemoryHttp01ChallengeResponder,
  options: Http01ChallengeServerOptions = {},
): Promise<Http01ChallengeServer> {
  const host = options.host ?? process.env.CERT_HTTP01_HOST ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.CERT_HTTP01_PORT ?? 8089);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const token = tokenFromUrl(req.url);
    const keyAuthorization = token ? responder.getKeyAuthorization(token) : undefined;
    if (!keyAuthorization) {
      res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Content-Length": Buffer.byteLength(keyAuthorization),
      "Cache-Control": "no-store",
    });
    res.end(keyAuthorization);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    url: `http://${host}:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function tokenFromUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  const path = rawUrl.split("?")[0];
  if (!path.startsWith(HTTP01_CHALLENGE_PREFIX)) return undefined;
  const token = path.slice(HTTP01_CHALLENGE_PREFIX.length);
  return TOKEN_PATTERN.test(token) ? token : undefined;
}
