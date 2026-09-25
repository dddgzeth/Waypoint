import type { Chain as ViemChain } from "viem";

/**
 * Everything the app needs to know about one chain, in one place. To add a
 * new chain: create chains/<name>.ts exporting one of these, then add it to
 * the CHAINS registry in chains/index.ts — nothing else needs to change,
 * every other file (planner.ts, the /chains API route,
 * the frontend chain list) derives from that registry.
 */
export interface ChainConfig {
  /** Internal key used everywhere in plans/state/URLs, e.g. "base". */
  key: string;
  /** Human-readable name for UI display, e.g. "Robinhood Chain". */
  label: string;
  chainId: number;
  viemChain: ViemChain;
  nativeSymbol: string;
  /** Aave V3 core Pool contract address, only if Aave is actually deployed on this chain — omit rather than guess. */
  aavePool?: `0x${string}`;
  /**
   * Alchemy's network slug for this chain (e.g. "base-mainnet"), used for
   * real token discovery (alchemy_getTokenBalances). ERC-20 metadata and
   * balances are then read from each discovered contract through its ABI.
   */
  alchemyNetwork?: string;
  /** CoinMarketCap DEX API "platform" id for this chain (e.g. "base"), used to price arbitrary discovered tokens by contract address via /v1/dex/token/price — verified real per chain via a live call, not assumed. */
  cmcPlatform?: string;
}
