/**
 * DCA buy — the action a "dca" trigger takes when its scheduled time comes
 * around. Deliberately reuses the same ExecutionPlan/runPlan() pipeline a
 * chat-driven plan uses (not a bespoke swap call): it gets the same safety
 * discipline for free — pre-send simulation, real post-trade measurement via
 * the tx's own Transfer log — instead of duplicating that logic for triggers.
 */
import type { Account } from "viem";
import type { ExecutionPlan } from "../models.js";
import { OrchestratorError, runPlan, type StepResult } from "../orchestrator.js";
import type { TriggerConfig } from "./types.js";

/** An on-chain router revert is not safely repeatable with the same calldata:
 * the next attempt always builds a completely new route and simulates it
 * again. This is intentionally bounded so an unavailable market cannot turn
 * one scheduled buy into an unbounded gas loop. */
const REQUOTE_RETRY_COUNT = Number(process.env.DCA_REQUOTE_RETRY_COUNT ?? 2);

export interface DcaRouteFailure {
  txHash: `0x${string}`;
  error: string;
}

export async function runDcaBuy(
  config: Extract<TriggerConfig, { type: "dca" }>,
  account: Account,
  onRouteFailure?: (failure: DcaRouteFailure) => void
): Promise<StepResult> {
  const plan: ExecutionPlan = {
    goal: {
      targetChain: config.chain,
      targetAsset: config.tokenOut,
      action: `DCA: buy ${config.amountPerBuy} ${config.tokenIn} worth of ${config.tokenOut} on ${config.chain}`,
      constraints: [],
      sourceWalletLabels: [],
      existingProtocolPositions: "preserve",
      needsYieldLookup: false,
    },
    steps: [
      {
        id: "dca-buy",
        action: "swap",
        chainFrom: config.chain,
        chainTo: config.chain,
        tokenIn: config.tokenIn,
        tokenOut: config.tokenOut,
        amountIn: String(config.amountPerBuy),
        protocol: null,
        dependsOn: [],
        transferTo: null,
        transferFrom: null,
        vendorAdapter: null,
        customCallTarget: null,
        customCallFunction: null,
        customCallArgs: null,
        customCallValueEth: null,
      },
    ],
  };
  const primary = process.env.SAME_CHAIN_SWAP_PRIMARY?.toLowerCase() ?? "enso";
  const providers = primary === "okx" ? ["okx", "enso"] : ["enso", "okx"];
  for (let attempt = 0; attempt <= REQUOTE_RETRY_COUNT; attempt++) {
    // If a broadcast route reverts, the next automatic DCA attempt requests
    // fresh calldata from the other provider before it simulates or sends.
    // It never replays a known-reverted transaction.
    plan.steps[0].vendorAdapter = providers[attempt % providers.length];
    try {
      const [result] = await runPlan(plan, account);
      return result;
    } catch (err) {
      // A tx hash means the transaction reached chain and reverted. Rebuild
      // the route from live liquidity; never resend the old calldata.
      if (err instanceof OrchestratorError && err.txHash && attempt < REQUOTE_RETRY_COUNT) {
        onRouteFailure?.({ txHash: err.txHash, error: err.message });
        continue;
      }
      throw err;
    }
  }
  throw new Error("DCA route retry loop ended unexpectedly");
}
