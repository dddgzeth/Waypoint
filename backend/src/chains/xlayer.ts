import { xLayer as viemXLayer } from "viem/chains";
import type { ChainConfig } from "./types.js";

// X Layer (OKX's zkEVM L2, gas paid in OKB). Alchemy serves plain RPC on it but not the
// token-discovery API, so balances come from `knownTokens` (the Aave V3 reserves on X Layer).
export const xlayer: ChainConfig = {
  key: "xlayer",
  label: "X Layer",
  chainId: 196,
  viemChain: viemXLayer,
  nativeSymbol: "OKB",
  // Verified on-chain 2026-10: Pool.getReservesList() returns the 11 reserves below.
  aavePool: "0xE3F3Caefdd7180F884c01E57f65Df979Af84f116",
  alchemyNetwork: "xlayer-mainnet",
  knownTokens: [
    "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", // USD₮0
    "0x4ae46a509F6b1D9056937BA4500cb143933D2dc8", // USDG
    "0xB6CEceAB302E2E4948951eE7843FC24E92933061", // USDC
    "0xDe6539018B095353A40753Dc54C91C68c9487D4E", // GHO
    "0xe538905cf8410324e03A5A23C1c177a474D59b2b", // WOKB
    "0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f", // xBTC
    "0xE7B000003A45145decf8a28FC755aD5eC5EA025A", // xETH
    "0x505000008DE8748DBd4422ff4687a4FC9bEba15b", // xSOL
    "0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7", // xBETH
    "0x14a686103854DAB7b8801E31979CAA595835B25d", // xOKSOL
  ],
};
