/**
 * Real token discovery via Alchemy — replaces the old "native + one
 * hardcoded stablecoin per chain" scope. alchemy_getTokenBalances returns
 * every ERC20 the address has ever transacted with (verified for real: a
 * live wallet returned 5+ tokens on Base alone that the old fixed list never
 * saw); alchemy_getTokenMetadata resolves symbol/decimals for display.
 *
 * Only chains with a configured alchemyNetwork are covered — Robinhood Chain
 * confirmed unsupported by a real call ("APIs not enabled on specified
 * network: [NETWORK_AGNOSTIC]"), so it keeps using the fixed tokens list in
 * tokenRegistry.ts instead.
 */
import { createPublicClient, erc20Abi } from "viem";
import { alchemyApiKeys, getChain, rpcUrl } from "../chains/index.js";
import { alchemyHttp } from "./alchemyTransport.js";

async function rpc<T>(alchemyNetwork: string, method: string, params: unknown[]): Promise<T> {
  let lastError: Error | null = null;
  const keys = alchemyApiKeys();
  if (!keys.length) throw new Error("No Alchemy API key is configured");
  for (let attempt = 0; attempt <= 5; attempt++) {
    try {
      const key = keys[attempt % keys.length];
      const res = await fetch(`https://${alchemyNetwork}.g.alchemy.com/v2/${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable) throw new Error(`Alchemy request failed (${res.status})`);
        const retryAfter = Number(res.headers.get("retry-after"));
        lastError = new Error(`Alchemy request failed (${res.status})`);
        if (attempt === 5) break;
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`Alchemy error: ${body.error.message}`);
      if (body.result === undefined) throw new Error("Alchemy returned no result");
      return body.result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError ?? new Error("Alchemy request failed after retries");
}

export interface RawTokenBalance {
  contractAddress: `0x${string}`;
  balanceRaw: bigint;
}

interface TokenBalancesResult {
  address: string;
  tokenBalances: Array<{ contractAddress: string; tokenBalance: string | null; error?: string | null }>;
}

/** Every non-zero ERC20 balance the address has ever transacted in, on the given chain. Empty array on chains Alchemy doesn't index. */
export async function discoverTokenBalances(chainKey: string, address: `0x${string}`): Promise<RawTokenBalance[]> {
  const chain = getChain(chainKey);
  if (!chain?.alchemyNetwork) return [];
  const result = await rpc<TokenBalancesResult>(chain.alchemyNetwork, "alchemy_getTokenBalances", [address]);
  return result.tokenBalances
    .filter((t) => !t.error && t.tokenBalance && BigInt(t.tokenBalance) > 0n)
    .map((t) => ({ contractAddress: t.contractAddress.toLowerCase() as `0x${string}`, balanceRaw: BigInt(t.tokenBalance!) }));
}

export interface TokenMetadata {
  symbol: string;
  decimals: number;
  name: string;
  logo: string | null;
}

/** Symbol/decimals/name from the ERC-20 contract itself. Null for a malformed or non-standard token. */
export async function getTokenMetadata(chainKey: string, contractAddress: `0x${string}`): Promise<TokenMetadata | null> {
  const chain = getChain(chainKey);
  if (!chain) return null;
  try {
    const client = createPublicClient({ chain: chain.viemChain, transport: alchemyHttp(chainKey) });
    const [decimals, symbol, name] = await Promise.all([
      client.readContract({ address: contractAddress, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: contractAddress, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: contractAddress, abi: erc20Abi, functionName: "name" }),
    ]);
    return { symbol, decimals, name, logo: null };
  } catch {
    return null;
  }
}

/** Resolve a discovered wallet's token identities in bounded Multicall batches.
 * The values still come from each token's ERC-20 ABI; batching prevents a
 * spam-heavy wallet from turning one portfolio refresh into hundreds of
 * individual RPC requests. */
export async function getTokenMetadataBatch(chainKey: string, contractAddresses: `0x${string}`[]): Promise<Map<string, TokenMetadata | null>> {
  const out = new Map<string, TokenMetadata | null>();
  const addressesToRead = [...new Set(contractAddresses.map((address) => address.toLowerCase()))] as `0x${string}`[];
  const chain = getChain(chainKey);
  if (!chain || !addressesToRead.length) return out;
  const client = createPublicClient({ chain: chain.viemChain, transport: alchemyHttp(chainKey) });
  const batchSize = 24;
  for (let start = 0; start < addressesToRead.length; start += batchSize) {
    const addresses = addressesToRead.slice(start, start + batchSize);
    const contracts = addresses.flatMap((address) => [
      { address, abi: erc20Abi, functionName: "decimals" as const },
      { address, abi: erc20Abi, functionName: "symbol" as const },
      { address, abi: erc20Abi, functionName: "name" as const },
    ]);
    const values = (await client.multicall({ contracts, allowFailure: true })) as Array<{ status: string; result?: unknown }>;
    addresses.forEach((address, index) => {
      const decimals = values[index * 3];
      const symbol = values[index * 3 + 1];
      const name = values[index * 3 + 2];
      const metadata =
        decimals?.status === "success" && symbol?.status === "success" && name?.status === "success" &&
        (typeof decimals.result === "number" || typeof decimals.result === "bigint") &&
        typeof symbol.result === "string" && typeof name.result === "string"
          ? { symbol: symbol.result, decimals: Number(decimals.result), name: name.result, logo: null }
          : null;
      out.set(address, metadata);
    });
  }
  return out;
}
