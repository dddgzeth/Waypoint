/**
 * Data models: cross-chain wallet state, parsed goal, execution plan dependency graph.
 */
import { z } from "zod";

export const TokenBalanceSchema = z.object({
  chain: z.string(),
  token: z.string(),
  amount: z.number(),
  tokenAddress: z.string().nullable(),
  // Needed by the frontend's client-side "consolidate funds" transfer flow to
  // convert the human-readable `amount` back to raw on-chain units.
  decimals: z.number(),
  // From Alchemy's token metadata — null when Alchemy has no logo cached for
  // this token (common even for legitimate tokens) or for native assets.
  logo: z.string().nullable(),
  // A receipt token represents an already-open protocol position. It is not
  // an arbitrary ERC20 that a router should attempt to swap; the plan must
  // withdraw it through its protocol first.
  position: z
    .object({ protocol: z.literal("aave"), underlyingToken: z.string() })
    .nullable()
    .optional(),
});
export type TokenBalance = z.infer<typeof TokenBalanceSchema>;

export interface WalletState {
  address: string;
  balances: TokenBalance[];
}

export function describeWalletState(state: WalletState): string {
  const lines = [`Wallet ${state.address} current holdings:`];
  if (state.balances.length === 0) {
    lines.push("  (confirmed empty — this is a real, complete balance read across every supported chain, not missing data: this wallet holds no native or token balance anywhere.)");
  }
  for (const b of state.balances) {
    lines.push(`  - ${b.chain}: ${b.amount} ${b.token}`);
  }
  return lines.join("\n");
}

/**
 * One entry in the account's known wallet list (name -> address), independent
 * of any single wallet's live balances. Lets chat resolve a user-chosen wallet
 * label to its real address (and answer questions about the mapping itself)
 * without needing a chain read at all.
 */
export interface WalletListEntry {
  label: string;
  address: string;
  kind: "linked" | "execution";
}

/** A live state annotated with the account-local name that a user sees in Waypoint. */
export interface WalletStateSnapshot extends WalletState {
  label: string;
  kind: WalletListEntry["kind"];
}

/** Whether Waypoint currently has enough chain/token metadata to quote and execute this holding. */
export function isExecutableBalance(balance: TokenBalance): boolean {
  if (balance.position) return true;
  if (balance.tokenAddress === null) return true;
  // Every displayed ERC-20 was discovered and metadata-validated through its
  // own contract ABI. Its address, not a curated symbol list, is executable.
  return true;
}

export function describeWalletList(wallets: WalletListEntry[]): string {
  if (!wallets.length) return "This account has no wallets yet.";
  const lines = ["This account's known wallets (name -> address, no live balances here):"];
  for (const w of wallets) lines.push(`  - "${w.label}" (${w.kind}): ${w.address}`);
  return lines.join("\n");
}

export function describeWalletStates(states: WalletStateSnapshot[]): string {
  if (!states.length) return "No wallet balances were available.";
  return states
    .map((state) => {
      const heading = `Wallet \"${state.label}\" (${state.kind}, ${state.address}) current holdings:`;
      const executable = state.balances.filter(isExecutableBalance);
      const omittedCount = state.balances.length - executable.length;
      if (!executable.length) {
        return `${heading}\n  (no assets currently have an executable Waypoint route${omittedCount ? `; ${omittedCount} discovered but unsupported tokens omitted` : ""})`;
      }
      const lines = [
        heading,
        ...executable.map((balance) =>
          balance.position
            ? `  - ${balance.chain}: ${balance.amount} ${balance.position.protocol} ${balance.position.underlyingToken} supply position (receipt token ${balance.token})`
            : `  - ${balance.chain}: ${balance.amount} ${balance.token}${balance.tokenAddress ? ` (ERC-20 ${balance.tokenAddress})` : ""}`
        ),
      ];
      if (omittedCount) lines.push(`  (${omittedCount} discovered tokens omitted: no executable Waypoint route)`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Goal parser (LLM) output: describes only "what the user wants", not execution details. */
export const GoalSchema = z.object({
  targetChain: z
    .string()
    .nullable()
    .describe(
      "The chain the final asset should end up on — a real chain key (e.g. 'base'), never a description. " +
        "Null when the user didn't name one and it should be decided by a live yield comparison instead " +
        "(e.g. 'highest-yielding' with no chain named) — never fill this with a phrase like " +
        "'whichever chain has the best yield', which isn't a real chain and breaks the live lookup."
    ),
  targetAsset: z.string().nullable().describe("The target asset (token symbol)"),
  action: z.string().describe("Natural-language summary of the user's goal, e.g. 'consolidate assets and deposit into the best-yielding lending protocol'. Preserve the user's own amount and unit verbatim (e.g. '~$4 of ETH', '0.01 ETH') — planner.ts reads this to know both the amount and whether it's dollar- or token-denominated."),
  constraints: z.array(z.string()).describe("Extra constraints the user stated, e.g. 'keep 0.05 ETH as a gas reserve'"),
  sourceWalletLabels: z
    .array(z.string())
    .describe("Known wallet labels explicitly named by the user as sources of funds. Empty when the user did not name a source wallet."),
  existingProtocolPositions: z
    .enum(["include", "preserve", "unspecified"])
    .describe(
      "Whether protocol positions that already existed before this goal are in scope: " +
        "'include' only when the user explicitly asks to move/consolidate all assets or positions; " +
        "'preserve' when the user says not to touch them or says to use only newly produced funds; " +
        "otherwise 'unspecified'."
    ),
  needsYieldLookup: z.boolean().describe("Whether a live on-chain yield lookup is needed to decide which protocol to use"),
});
export type Goal = z.infer<typeof GoalSchema>;

export const ActionType = z.enum(["swap", "bridge", "cross_chain_swap", "protocol_supply", "protocol_withdraw", "protocol_borrow", "transfer", "custom_call"]);
export type ActionType = z.infer<typeof ActionType>;

export const PlanStepSchema = z.object({
  id: z.string(),
  action: ActionType,
  chainFrom: z.string(),
  chainTo: z.string(),
  tokenIn: z.string(),
  tokenOut: z.string(),
  amountIn: z
    .string()
    .describe("A fixed value, 'all' for the signer's current ERC20 balance, or a symbolic reference like 'output_of(step1)' (referring to the previous step's actual output amount)"),
  protocol: z.string().nullable().describe("Protocol name when a third-party protocol is involved, e.g. 'Aave'"),
  dependsOn: z.array(z.string()),
  // For `transfer`: required — the third-party recipient address, as opposed
  // to every other action type which by default sends back to whichever
  // wallet signs the step. For any OTHER action type: OPTIONAL — set this
  // when the step's output should land on a DIFFERENT wallet than the one
  // that signs/funds it (e.g. consolidating several named execution wallets
  // into one target wallet before a final deposit — each consolidating step
  // sets transferFrom to its own source wallet and transferTo to the shared
  // target). Null for a non-transfer step means the default: output returns
  // to the step's own signer (transferFrom, or the plan's overall wallet if
  // transferFrom is also null).
  transferTo: z.string().nullable().describe("transfer: required recipient address. Other actions: optional — set only to redirect this step's output to a different wallet than its own signer, e.g. multi-wallet consolidation."),
  // Which wallet funds/signs THIS step, when the goal names a specific
  // wallet — applies to ANY action type, not just transfer (e.g. "bridge
  // execution wallet 2's ETH into execution wallet 1" names wallet 2 as this
  // bridge step's source). Resolved against the known wallet list given
  // below (e.g. a nickname) — never invent an address. Null means "whichever
  // wallet the user picks to run the plan from" — the pre-existing behavior
  // for goals like "consolidate my assets" that don't name a specific
  // source. When set, execution MUST come from this exact address — never
  // let a different wallet silently execute a step whose declared source is
  // someone else's balance.
  transferFrom: z.string().nullable().describe("The wallet that funds/signs this specific step, when the user named one — any action type, not just transfer."),
  vendorAdapter: z
    .string()
    .nullable()
    .describe("The vendor adapter expected to carry out this step, e.g. 'lifi' / 'across' / 'enso' / 'custom_aave'"),
  // custom_call only — an escape hatch for on-chain operations outside the
  // other 4 action types (arbitrary contract, arbitrary method). For these
  // steps tokenIn/tokenOut/amountIn are unused placeholders (set them to the
  // chain's native symbol / "0") — the real call is fully described here.
  customCallTarget: z.string().nullable().describe("custom_call only: the contract address being called"),
  customCallFunction: z
    .string()
    .nullable()
    .describe("custom_call only: a human-readable Solidity function signature, e.g. 'function approve(address spender, uint256 amount) returns (bool)'"),
  customCallArgs: z.array(z.string()).nullable().describe("custom_call only: arguments in order, as strings"),
  customCallValueEth: z.string().nullable().describe("custom_call only: native token value to send with the call, as a plain decimal string, e.g. '0.01' (or '0')"),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ExecutionPlanSchema = z.object({
  goal: GoalSchema,
  steps: z.array(PlanStepSchema),
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export function prettyPlan(plan: ExecutionPlan): string {
  const lines = [`Goal: ${plan.goal.action}`];
  if (plan.goal.constraints.length > 0) {
    lines.push(`Constraints: ${plan.goal.constraints.join(", ")}`);
  }
  lines.push("Execution plan:");
  for (const s of plan.steps) {
    const dep = s.dependsOn.length ? ` (depends on: ${s.dependsOn.join(", ")})` : "";
    if (s.action === "custom_call") {
      lines.push(
        `  [${s.id}] custom_call: ${s.customCallTarget}.${s.customCallFunction} (${s.customCallArgs?.join(", ")}) ` +
          `on ${s.chainFrom}, value=${s.customCallValueEth}${dep}`
      );
      continue;
    }
    if (s.action === "transfer") {
      const from = s.transferFrom ? `from ${s.transferFrom} ` : "";
      lines.push(`  [${s.id}] transfer: ${from}${s.amountIn} ${s.tokenIn} (${s.chainFrom}) -> ${s.transferTo}${dep}`);
      continue;
    }
    const proto = s.protocol ? ` via ${s.protocol}` : "";
    const from = s.transferFrom ? ` from ${s.transferFrom}` : "";
    const to = s.transferTo ? ` -> lands in ${s.transferTo}` : "";
    lines.push(
      `  [${s.id}] ${s.action}:${from} ${s.amountIn} ${s.tokenIn} (${s.chainFrom}) -> ` +
        `${s.tokenOut} (${s.chainTo})${proto} [adapter=${s.vendorAdapter}]${to}${dep}`
    );
  }
  return lines.join("\n");
}
