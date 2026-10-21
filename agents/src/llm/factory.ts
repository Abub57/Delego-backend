/**
 * LLM client factory and provider failover.
 * Issue #261: switch provider via LLM_PROVIDER env var; auto-failover on error.
 */

import type {
  LLMClient,
  LLMClientConfig,
  LLMProviderMetrics,
  LLMProviderName,
  LLMRequestOptions,
  LLMResponse,
} from "./types.js";
import { OpenAIClient } from "./openai.js";
import { AnthropicClient } from "./anthropic.js";
import { GeminiClient } from "./gemini.js";

const ALL_PROVIDERS: LLMProviderName[] = ["openai", "anthropic", "gemini"];

export interface FailoverLLMClientOptions {
  preferredProvider?: LLMProviderName;
  fallbackChain?: LLMProviderName[];
  providerConfigs?: Partial<Record<LLMProviderName, Partial<LLMClientConfig>>>;
}

export function resolveFallbackChain(
  preferredProvider?: LLMProviderName,
  fallbackChain?: LLMProviderName[]
): LLMProviderName[] {
  const orderedProviders = fallbackChain && fallbackChain.length > 0
    ? fallbackChain
    : [
        preferredProvider ?? "openai",
        ...ALL_PROVIDERS.filter((provider) => provider !== (preferredProvider ?? "openai")),
      ];

  const deduped: LLMProviderName[] = [];
  for (const provider of orderedProviders) {
    if (!deduped.includes(provider)) {
      deduped.push(provider);
    }
  }

  return deduped;
}

export class FailoverLLMClient implements LLMClient {
  readonly provider: LLMProviderName;

  private readonly clients = new Map<LLMProviderName, LLMClient>();
  private readonly metrics = new Map<LLMProviderName, LLMProviderMetrics>();
  private readonly fallbackChain: LLMProviderName[];

  constructor(options: FailoverLLMClientOptions = {}) {
    this.provider = options.preferredProvider ?? "openai";
    this.fallbackChain = resolveFallbackChain(this.provider, options.fallbackChain);

    for (const provider of this.fallbackChain) {
      const config = mergeProviderConfig(provider, options.providerConfigs?.[provider]);
      this.clients.set(provider, createLLMClient(provider, config));
      this.metrics.set(provider, {
        provider,
        requests: 0,
        failures: 0,
        errors: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        errorRate: 0,
      });
    }
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const chain = resolveFallbackChain(
      options.preferredProvider ?? this.provider,
      options.fallbackChain ?? this.fallbackChain
    );

    let lastError: Error | undefined;
    for (const provider of chain) {
      const client = this.clients.get(provider) ?? createLLMClient(provider, {
        apiKey: requireProviderApiKey(provider),
        maxRetries: 0,
        baseDelayMs: 0,
      });
      const metric = this.metrics.get(provider) ?? createMetric(provider);
      const startedAt = Date.now();
      metric.requests += 1;
      this.metrics.set(provider, metric);

      try {
        const response = await client.chat({
          ...options,
          preferredProvider: provider,
          fallbackChain: chain,
        });
        metric.totalLatencyMs += Date.now() - startedAt;
        metric.avgLatencyMs = metric.totalLatencyMs / metric.requests;
        metric.errorRate = metric.failures / metric.requests;
        return response;
      } catch (error) {
        const err = toError(error);
        const latencyMs = Date.now() - startedAt;
        metric.totalLatencyMs += latencyMs;
        metric.errors += 1;
        metric.failures += 1;
        metric.avgLatencyMs = metric.totalLatencyMs / metric.requests;
        metric.errorRate = metric.failures / metric.requests;
        this.metrics.set(provider, metric);
        lastError = err;

        if (!isProviderFailoverError(err) || provider === chain[chain.length - 1]) {
          throw err;
        }
      }
    }

    throw lastError ?? new Error("LLM request failed across all providers");
  }

  getMetrics(): LLMProviderMetrics[] {
    return Array.from(this.metrics.values()).map((metric) => ({ ...metric }));
  }
}

export function createFailoverLLMClient(
  options: FailoverLLMClientOptions = {}
): FailoverLLMClient {
  return new FailoverLLMClient(options);
}

/**
 * Instantiate the appropriate LLM client for a given provider name.
 * API key is read from the environment when not supplied via config.
 */
export function createLLMClient(
  provider: LLMProviderName,
  config?: Partial<LLMClientConfig>
): LLMClient {
  const resolvedConfig = resolveConfig(provider, config);
  switch (provider) {
    case "openai":
      return new OpenAIClient(resolvedConfig);
    case "anthropic":
      return new AnthropicClient(resolvedConfig);
    case "gemini":
      return new GeminiClient(resolvedConfig);
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown LLM provider: ${_exhaustive}`);
    }
  }
}

/**
 * Create a client driven by the LLM_PROVIDER environment variable.
 * Falls back to "openai" when the variable is not set.
 */
export function createDefaultLLMClient(config?: Partial<LLMClientConfig>): LLMClient {
  const provider = (process.env["LLM_PROVIDER"] ?? "openai") as LLMProviderName;
  return createLLMClient(provider, config);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mergeProviderConfig(
  provider: LLMProviderName,
  config?: Partial<LLMClientConfig>
): Partial<LLMClientConfig> {
  return {
    apiKey: config?.apiKey ?? readEnvApiKey(provider),
    maxRetries: config?.maxRetries ?? 0,
    baseDelayMs: config?.baseDelayMs ?? 0,
    timeoutMs: config?.timeoutMs,
  };
}

function createMetric(provider: LLMProviderName): LLMProviderMetrics {
  return {
    provider,
    requests: 0,
    failures: 0,
    errors: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    errorRate: 0,
  };
}

function isProviderFailoverError(error: Error): boolean {
  return /429|5\d{2}/.test(error.message);
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function resolveConfig(
  provider: LLMProviderName,
  overrides?: Partial<LLMClientConfig>
): LLMClientConfig {
  const apiKey = overrides?.apiKey ?? readEnvApiKey(provider);

  if (!apiKey) {
    throw new Error(
      `LLM API key for provider "${provider}" is not set. ` +
        `Configure ${apiKeyEnvVar(provider)} or pass it via config.`
    );
  }

  return {
    apiKey,
    maxRetries: overrides?.maxRetries ?? 3,
    baseDelayMs: overrides?.baseDelayMs ?? 1_000,
    timeoutMs: overrides?.timeoutMs ?? 30_000,
  };
}

function apiKeyEnvVar(provider: LLMProviderName): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
  }
}

function readEnvApiKey(provider: LLMProviderName): string | undefined {
  return process.env[apiKeyEnvVar(provider)];
}

function requireProviderApiKey(provider: LLMProviderName): string {
  const apiKey = readEnvApiKey(provider);
  if (!apiKey) {
    throw new Error(
      `LLM API key for provider "${provider}" is not set. Configure ${apiKeyEnvVar(provider)} or pass it via config.`
    );
  }
  return apiKey;
}
