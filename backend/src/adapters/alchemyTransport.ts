/** Shared Alchemy-only viem transport. Retrying is deliberately provider-wide
 * rather than owned by DCA: reads, simulations, receipt waits and writes all
 * see the same bounded exponential-backoff behavior. viem honors Alchemy's
 * Retry-After header when present. */
import { fallback, http, type Transport } from "viem";
import { alchemyApiKeys, rpcUrl } from "../chains/index.js";

const nextRequestAt = new Map<string, number>();

async function waitForAlchemyTurn(chainKey: string): Promise<void> {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextRequestAt.get(chainKey) ?? now);
  nextRequestAt.set(chainKey, scheduledAt + 125);
  if (scheduledAt > now) await new Promise((resolve) => setTimeout(resolve, scheduledAt - now));
}

function pacedHttp(chainKey: string, keyIndex: number): Transport {
  const base = http(rpcUrl(chainKey, keyIndex), { retryCount: 1, retryDelay: 1_000, timeout: 20_000 });
  return ((config) => {
    const transport = base(config);
    return {
      ...transport,
      request: async (args, options) => {
        await waitForAlchemyTurn(chainKey);
        return transport.request(args, options);
      },
    };
  }) as Transport;
}

export function alchemyHttp(chainKey: string): Transport {
  const keys = alchemyApiKeys();
  if (!keys.length) throw new Error("No Alchemy API key is configured");
  return fallback(keys.map((_, index) => pacedHttp(chainKey, index)), { rank: false, retryCount: 0 });
}

/** One specific configured Alchemy endpoint. Cross-chain destination state is
 * produced outside our own RPC path; dependent execution waits until every
 * configured endpoint has incorporated that block, otherwise a successful
 * but stale primary response can make the next simulation falsely revert. */
export function alchemyHttpForKey(chainKey: string, keyIndex: number): Transport {
  const keys = alchemyApiKeys();
  if (!keys[keyIndex]) throw new Error(`No Alchemy API key at index ${keyIndex}`);
  return pacedHttp(chainKey, keyIndex);
}
