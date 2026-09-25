/**
 * The chain registry — the single source of truth for "which chains does
 * Waypoint support." To add a new chain: create chains/<name>.ts (copy an
 * existing one as a template) and add it to CHAINS below. Everything else
 * (tokenRegistry.ts's derived exports, planner.ts's SUPPORTED_CHAINS,
 * the Aave adapters, the GET /chains API route, the frontend's chain list)
 * reads from this registry — nothing else needs hand-editing.
 */
import { ethereum } from "./ethereum.js";
import { base } from "./base.js";
import { arbitrum } from "./arbitrum.js";
import { polygon } from "./polygon.js";
import type { ChainConfig } from "./types.js";

export type { ChainConfig };

// A chain is active in Waypoint only when every read, quote validation and
// transaction confirmation can use the same Alchemy-backed RPC service. Keep
// an unsupported chain's definition in its own file for future enablement,
// but do not advertise it as a supported execution target.
export const CHAINS: Record<string, ChainConfig> = { ethereum, base, arbitrum, polygon };

export const CHAIN_KEYS: string[] = Object.keys(CHAINS);

export function getChain(key: string): ChainConfig | undefined {
  return CHAINS[key];
}

/** Chains with a known Aave V3 Pool deployment — derived, not hand-maintained. */
export function chainsWithAave(): ChainConfig[] {
  return CHAIN_KEYS.map((k) => CHAINS[k]).filter((c): c is ChainConfig & { aavePool: `0x${string}` } => Boolean(c.aavePool));
}

/**
 * Every real on-chain read/write goes through Alchemy. There is deliberately
 * no public-RPC or per-chain fallback: switching providers invisibly makes
 * planning, monitoring and execution behave differently under load.
 */
export function alchemyApiKeys(): string[] {
  return [process.env.ALCHEMY_API_KEY, process.env.ALCHEMY_API_KEY_2, process.env.ALCHEMY_API_KEY_3]
    .filter((key): key is string => Boolean(key))
    .filter((key, index, keys) => keys.indexOf(key) === index);
}

export function rpcUrl(chainKey: string, keyIndex = 0): string {
  const chain = getChain(chainKey);
  const keys = alchemyApiKeys();
  const alchemyKey = keys[keyIndex];
  if (!chain?.alchemyNetwork) throw new Error(`${chainKey} is not an Alchemy-backed Waypoint chain`);
  if (!alchemyKey) throw new Error("No Alchemy API key is configured");
  return `https://${chain.alchemyNetwork}.g.alchemy.com/v2/${alchemyKey}`;
}
