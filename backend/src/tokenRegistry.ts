/**
 * Backward-compatible views over the chain registry (src/chains/) — every
 * existing `import {...} from "./tokenRegistry.js"` across the codebase
 * keeps working unchanged. The actual source of truth (one file per chain)
 * lives in src/chains/; this file just reshapes it into the flat
 * Record<chainKey, X> maps the rest of the codebase already expects.
 */
import { CHAINS, CHAIN_KEYS } from "./chains/index.js";

export const CHAIN_ID: Record<string, number> = Object.fromEntries(CHAIN_KEYS.map((k) => [k, CHAINS[k].chainId]));

export const VIEM_CHAIN: Record<string, (typeof CHAINS)[string]["viemChain"]> = Object.fromEntries(
  CHAIN_KEYS.map((k) => [k, CHAINS[k].viemChain])
);

export const NATIVE_SYMBOL: Record<string, string> = Object.fromEntries(CHAIN_KEYS.map((k) => [k, CHAINS[k].nativeSymbol]));

// Zero address: the native-token placeholder LI.FI (and most aggregators/DEXes) use.
export const NATIVE_PLACEHOLDER_ZERO = "0x0000000000000000000000000000000000000000" as const;
// 0xeeee...eeee: the native-token placeholder Enso uses — a different convention,
// confirmed from docs.enso.build's own Route API example. Do not conflate the two.
export const NATIVE_PLACEHOLDER_EEEE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;
