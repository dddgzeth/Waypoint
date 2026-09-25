/**
 * Real-time Aave V3 health factor reader — same core Pool contract and ABI
 * discipline as aaveYield.ts (verified against the live deployed contract,
 * not assumed from docs). getUserAccountData's healthFactor is WAD-scaled
 * (1e18); a position with no debt returns type(uint256).max, which we
 * surface as Infinity — verified live against a real zero-debt position on
 * Arbitrum before wiring this up.
 */
import { createPublicClient } from "viem";
import { getChain } from "../chains/index.js";
import { alchemyHttp } from "./alchemyTransport.js";

const POOL_ABI = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

const WAD = 10n ** 18n;
const MAX_UINT256 = 2n ** 256n - 1n;

export interface HealthFactorSnapshot {
  chain: string;
  healthFactor: number; // Infinity when there's no debt
  totalCollateralBase: number; // Aave "base currency" units (8 decimals, effectively USD)
  totalDebtBase: number;
}

export async function getHealthFactor(chainKey: string, userAddress: `0x${string}`): Promise<HealthFactorSnapshot> {
  const chain = getChain(chainKey);
  if (!chain?.aavePool) {
    throw new Error(`No Aave V3 deployment known for ${chainKey}`);
  }
  const client = createPublicClient({ chain: chain.viemChain, transport: alchemyHttp(chainKey) });
  const [totalCollateralBase, totalDebtBase, , , , healthFactorRaw] = await client.readContract({
    address: chain.aavePool,
    abi: POOL_ABI,
    functionName: "getUserAccountData",
    args: [userAddress],
  });

  return {
    chain: chainKey,
    healthFactor: healthFactorRaw === MAX_UINT256 ? Infinity : Number(healthFactorRaw) / Number(WAD),
    totalCollateralBase: Number(totalCollateralBase) / 1e8,
    totalDebtBase: Number(totalDebtBase) / 1e8,
  };
}
