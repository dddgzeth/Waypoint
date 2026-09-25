import { defineChain } from "viem";
import type { ChainConfig } from "./types.js";

// Robinhood Chain (an Arbitrum Orbit L2 settling to Ethereum, gas paid in ETH)
// isn't in viem's built-in chain list, so it's defined manually. Chain id / RPC
// from the official docs: docs.robinhood.com/chain/run-a-full-node/.
const viemRobinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
});

export const robinhood: ChainConfig = {
  key: "robinhood",
  label: "Robinhood Chain",
  chainId: 4663,
  viemChain: viemRobinhood,
  nativeSymbol: "ETH",
  // No aavePool — verified (2026-08) Aave V3 has no deployment on Robinhood Chain yet.
  // Leave unset rather than guessing; findBestAaveYield/health-factor triggers correctly
  // exclude this chain from Aave candidates as a result.
};
