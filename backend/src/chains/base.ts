import { base as viemBase } from "viem/chains";
import type { ChainConfig } from "./types.js";

export const base: ChainConfig = {
  key: "base",
  label: "Base",
  chainId: 8453,
  viemChain: viemBase,
  nativeSymbol: "ETH",
  // Source: github.com/aave/aave-address-book AaveV3Base.sol — core Pool, not PoolAddressesProvider.
  aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  alchemyNetwork: "base-mainnet",
  cmcPlatform: "base",
};
