#!/usr/bin/env tsx
/**
 * Runs state reading -> goal parsing -> planning end to end without starting
 * a server, printing the results.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npm run demo -- "Consolidate these assets into ETH and deposit into the best-yielding lending protocol on Arbitrum"
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { parseGoal } from "./goalParser.js";
import { buildPlan } from "./planner.js";
import { getMockWalletState, getWalletState } from "./stateReader.js";
import { describeWalletState, prettyPlan, type WalletStateSnapshot } from "./models.js";

const DEFAULT_GOAL_TEXT =
  "Consolidate these assets into ETH and deposit into the best-yielding lending protocol on Arbitrum";

async function main() {
  const goalText = process.argv[2] ?? DEFAULT_GOAL_TEXT;

  const pk = process.env.EXECUTOR_PRIVATE_KEY;
  let state;
  if (pk) {
    const account = privateKeyToAccount(`0x${pk.replace(/^0x/, "")}`);
    console.log(`Reading real on-chain state for: ${account.address}`);
    state = await getWalletState(account.address);
  } else {
    state = getMockWalletState();
  }
  console.log(describeWalletState(state));
  console.log(`\nUser input: ${goalText}\n`);

  console.log("=== Goal parser output ===");
  const snapshot: WalletStateSnapshot = { ...state, label: "Demo wallet", kind: "execution" };
  const goal = await parseGoal(goalText, [snapshot]);
  console.log(JSON.stringify(goal, null, 2));

  console.log("\n=== Planner output ===");
  const plan = await buildPlan(goal, [snapshot]);
  console.log(prettyPlan(plan));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
