import { polygon as viemPolygon } from "viem/chains";
import type { ChainConfig } from "./types.js";

export const polygon: ChainConfig = {
  key: "polygon",
  label: "Polygon",
  chainId: 137,
  viemChain: viemPolygon,
  nativeSymbol: "POL",
  // Source: github.com/aave/aave-address-book AaveV3Polygon.sol — core Pool, not PoolAddressesProvider.
  // Same proxy address as Arbitrum/Base, verified real via Etherscan V2 (not assumed from the coincidence).
  aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  alchemyNetwork: "polygon-mainnet",
  cmcPlatform: "polygon",
};
