import { mainnet } from "viem/chains";
import type { ChainConfig } from "./types.js";

export const ethereum: ChainConfig = {
  key: "ethereum",
  label: "Ethereum",
  chainId: 1,
  viemChain: mainnet,
  nativeSymbol: "ETH",
  // Verified live: getReserveData(USDC) on this pool returns a real non-zero aTokenAddress.
  aavePool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  alchemyNetwork: "eth-mainnet",
  cmcPlatform: "ethereum",
};
