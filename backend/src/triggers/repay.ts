/**
 * Direct Aave V3 debt repayment — the action a health-factor trigger takes on
 * breach. Deliberately NOT routed through goalParser/planner: the trigger
 * already fully specifies what to do (repay this asset, this chain) at
 * registration time, matching plan.md's guardrail note that a triggered
 * scenario's confirmation policy is set up in advance, not asked for live.
 * Same safety discipline as orchestrator.ts: simulate before signing.
 */
import { createPublicClient, createWalletClient, erc20Abi, maxUint256 } from "viem";
import type { Account } from "viem";
import { getChain } from "../chains/index.js";
import { alchemyHttp } from "../adapters/alchemyTransport.js";
import { getAaveSupplyApy } from "../adapters/aaveYield.js";

const POOL_ABI = [
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const VARIABLE_RATE_MODE = 2n;

export interface RepayResult {
  txHash: `0x${string}`;
  repaidAmount: number;
  gasUsed: string;
}

/** Repays `amount` of `assetSymbol` debt on behalf of `account` itself, on `chainKey`. */
export async function repayAaveDebt(params: {
  chainKey: string;
  account: Account;
  assetSymbol: string;
  amount: number;
}): Promise<RepayResult> {
  const chain = getChain(params.chainKey);
  if (!chain?.aavePool) throw new Error(`No Aave V3 deployment known for ${params.chainKey}`);
  const pool = chain.aavePool;
  const reserve = await getAaveSupplyApy(params.chainKey, params.assetSymbol);
  const assetAddress = reserve.underlyingAddress;
  const decimals = reserve.decimals;
  const amountBaseUnits = BigInt(Math.round(params.amount * 10 ** decimals));

  const publicClient = createPublicClient({ chain: chain.viemChain, transport: alchemyHttp(params.chainKey) });
  const walletClient = createWalletClient({ account: params.account, chain: chain.viemChain, transport: alchemyHttp(params.chainKey) });

  const allowance = await publicClient.readContract({
    address: assetAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [params.account.address!, pool],
  });
  if (allowance < amountBaseUnits) {
    const { request } = await publicClient.simulateContract({
      account: params.account,
      address: assetAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [pool, maxUint256],
    });
    const approveTx = await walletClient.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  await publicClient.simulateContract({
    account: params.account,
    address: pool,
    abi: POOL_ABI,
    functionName: "repay",
    args: [assetAddress, amountBaseUnits, VARIABLE_RATE_MODE, params.account.address!],
  });
  const txHash = await walletClient.writeContract({
    account: params.account,
    chain: chain.viemChain,
    address: pool,
    abi: POOL_ABI,
    functionName: "repay",
    args: [assetAddress, amountBaseUnits, VARIABLE_RATE_MODE, params.account.address!],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`Repay transaction ${txHash} reverted on-chain despite passing simulation`);
  }

  return { txHash, repaidAmount: params.amount, gasUsed: receipt.gasUsed.toString() };
}
