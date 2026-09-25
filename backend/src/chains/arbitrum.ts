import { arbitrum as viemArbitrum } from "viem/chains";
import type { ChainConfig } from "./types.js";

export const arbitrum: ChainConfig = {
  key: "arbitrum",
  label: "Arbitrum",
  chainId: 42161,
  viemChain: viemArbitrum,
  nativeSymbol: "ETH",
  // Source: github.com/aave/aave-address-book AaveV3Arbitrum.sol — core Pool, not PoolAddressesProvider.
  aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  alchemyNetwork: "arb-mainnet",
  cmcPlatform: "arbitrum",
};
