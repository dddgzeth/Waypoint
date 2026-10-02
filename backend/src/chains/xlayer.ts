import { xLayer as viemXLayer } from "viem/chains";
import type { ChainConfig } from "./types.js";

// X Layer (OKX's zkEVM L2, gas paid in OKB). Alchemy serves plain RPC on it but not the
// token-discovery API, so balances are discovered from the on-chain Aave V3 reserve list.
export const xlayer: ChainConfig = {
  key: "xlayer",
  label: "X Layer",
  chainId: 196,
  viemChain: viemXLayer,
  nativeSymbol: "OKB",
  aavePool: "0xE3F3Caefdd7180F884c01E57f65Df979Af84f116",
  alchemyNetwork: "xlayer-mainnet",
  // CMC DEX API identifies this chain by its display name (verified live: "X Layer" -> pid 216).
  cmcPlatform: "X Layer",
  discoverViaAaveReserves: true,
};
