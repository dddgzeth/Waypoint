/**
 * Chat orchestration: the layer that makes Waypoint a real multi-turn agent
 * instead of a single-shot goal-in/plan-out form. This is the orchestrator
 * for Waypoint's real multi-agent pipeline (see plan-finals-v2.md) — it
 * doesn't do any LLM reasoning itself, it calls out to six agents, each its
 * own file with its own narrow job:
 *   1. Triage Agent      (agents/triageAgent.ts)   — needs live state or not?
 *   2. Readiness Agent    (agents/readinessAgent.ts) — enough info yet?
 *   3. Intent Agent       (goalParser.ts)            — what does the user want?
 *   4. Planning Agent     (planner.ts)                — how to do it?
 *   5/6. Review panel     (agents/reviewAgent.ts)     — a DIFFERENT model
 *        (Goal-Match + Feasibility) independently double-checking 3+4's work.
 *
 * Agents 1-4 are on this turn's critical path (the user is staring at a
 * typing indicator for each of them) and run strictly in sequence — each
 * one's output is genuinely required by the next. Memory extraction and the
 * review panel are NOT on that path: neither one's result is shown to the
 * user this turn (extraction only helps a FUTURE turn; review is advisory
 * logging only, see agents/reviewAgent.ts), so both fire in the background
 * without being awaited — a real, measured latency fix, not a guess: the
 * review panel alone (a separate, slower gateway) was adding ~19-20s to
 * every plan-producing turn for zero visible benefit.
 */
import { parseGoal } from "./goalParser.js";
import { buildPlan, PlanValidationError } from "./planner.js";
import { publicErrorMessage } from "./errors.js";
import { triageIntent } from "./agents/triageAgent.js";
import { judgeReadiness } from "./agents/readinessAgent.js";
import { runReviewPanel } from "./agents/reviewAgent.js";
import type { Goal, ExecutionPlan, WalletStateSnapshot, WalletListEntry } from "./models.js";
import type { L0Turn } from "./memory/store.js";
import { buildMemoryContext } from "./memory/recall.js";
import { extractFromTurn } from "./memory/extraction.js";
import { isAllowed } from "./customCall/allowlist.js";
import { parseAutomationIntent } from "./agents/automationIntentAgent.js";
import type { TriggerConfig } from "./triggers/types.js";
import { CHAINS } from "./chains/index.js";
import { isContractTokenReference, resolveTokenReference } from "./tokenReference.js";
import { NATIVE_PLACEHOLDER_ZERO } from "./tokenRegistry.js";

export interface HighRiskStepWarning {
  stepId: string;
  target: string;
  functionSignature: string;
  reason: string;
}

export type ChatTurnResult =
  | { kind: "question"; message: string }
  | { kind: "automation_draft"; message: string; automation: AutomationDraft }
  | {
      kind: "plan";
      message: string;
      goal: Goal;
      plan: ExecutionPlan;
      highRiskSteps: HighRiskStepWarning[];
    }
  | { kind: "plan_failed"; message: string; error: string };

/** A fully resolved but not-yet-active automation. The UI sends this back only
 * when the user performs the single final confirmation. */
export interface AutomationDraft {
  title: string;
  summary: string;
  sourceWalletAddress: string;
  sourceWalletLabel: string;
  config: TriggerConfig;
}

function normalizedChain(input: string): string {
  const chain = input.trim().toLowerCase();
  if (!CHAINS[chain]) throw new Error(`${input} is not a supported Waypoint chain`);
  return chain;
}

function resolveAutomationWallet(
  sourceWalletLabel: string | null,
  states: WalletStateSnapshot[]
): WalletStateSnapshot {
  if (!sourceWalletLabel) return states[0];
  const wallet = states.find((state) => state.label.toLowerCase() === sourceWalletLabel.trim().toLowerCase());
  if (!wallet) throw new Error(`I couldn't find execution wallet “${sourceWalletLabel}”. Choose one of the execution wallets shown in chat.`);
  return wallet;
}

/** Resolve a chat token reference without a curated token map. Contract
 * addresses are canonical; a symbol is allowed only when it is present in
 * this execution wallet's live state on that chain (or is the chain native). */
function resolveAutomationToken(chain: string, reference: string, wallet: WalletStateSnapshot, role: "funding" | "target"): string {
  const trimmed = reference.trim();
  if (isContractTokenReference(trimmed)) return resolveTokenReference(chain, trimmed, NATIVE_PLACEHOLDER_ZERO)!;
  const native = CHAINS[chain].nativeSymbol;
  if (trimmed.toUpperCase() === native.toUpperCase()) return native;
  const holding = wallet.balances.find(
    (balance) => balance.chain === chain && balance.token.toLowerCase() === trimmed.toLowerCase() && balance.tokenAddress
  );
  if (holding?.tokenAddress) return holding.tokenAddress;
  const suffix = role === "target" ? " Please give its ERC-20 contract address." : " Choose an asset visible in this wallet's live balances or give its contract address.";
  throw new Error(`I can't safely resolve ${trimmed} on ${chain} from on-chain data.${suffix}`);
}

function draftAutomation(intent: Exclude<Awaited<ReturnType<typeof parseAutomationIntent>>, { kind: "none" | "incomplete" }>, states: WalletStateSnapshot[]): AutomationDraft {
  const wallet = resolveAutomationWallet(intent.sourceWalletLabel, states);
  const chain = normalizedChain(intent.chain);
  if (intent.kind === "dca") {
    if (!intent.intervalMinutes && !intent.timeOfDayUtc) throw new Error("For a DCA automation, tell me how often it should buy (for example, every 3 minutes or daily at 09:00 UTC).");
    if (intent.startAfterMinutes && intent.timeOfDayUtc) throw new Error("Choose either a first-run delay or a UTC start time, not both.");
    const tokenIn = resolveAutomationToken(chain, intent.tokenIn, wallet, "funding");
    const tokenOut = resolveAutomationToken(chain, intent.tokenOut, wallet, "target");
    const completionCondition = intent.executionCount ? { type: "tx_count" as const, count: intent.executionCount } : null;
    const config: TriggerConfig = {
      type: "dca",
      chain,
      tokenIn,
      tokenOut,
      amountPerBuy: intent.amountPerBuy,
      ...(intent.intervalMinutes ? { intervalMinutes: intent.intervalMinutes } : {}),
      ...(intent.timeOfDayUtc ? { timeOfDayUtc: intent.timeOfDayUtc } : {}),
      ...(intent.startAfterMinutes ? { startAfterMinutes: intent.startAfterMinutes } : {}),
      completionCondition,
    };
    const cadence = intent.intervalMinutes ? `every ${intent.intervalMinutes} minutes` : `daily at ${intent.timeOfDayUtc} UTC`;
    const limit = intent.executionCount ? `, stopping after ${intent.executionCount} confirmed purchases` : "";
    return {
      title: "DCA buy",
      summary: `${intent.amountPerBuy} ${intent.tokenIn} → ${intent.tokenOut} on ${chain}, ${cadence}${limit}. First purchase is immediate unless a start time or delay was specified.`,
      sourceWalletAddress: wallet.address,
      sourceWalletLabel: wallet.label,
      config,
    };
  }
  const repayAsset = resolveAutomationToken(chain, intent.repayAsset, wallet, "funding");
  const config: TriggerConfig = {
    type: "health_factor",
    chain,
    threshold: intent.threshold,
    repayAsset,
    repayPercent: intent.repayPercent,
    completionCondition: intent.executionCount ? { type: "tx_count", count: intent.executionCount } : null,
  };
  const limit = intent.executionCount ? ` Stop after ${intent.executionCount} confirmed repayment${intent.executionCount === 1 ? "" : "s"}.` : "";
  return {
    title: "Health-factor repayment",
    summary: `On ${chain}, repay ${intent.repayPercent}% of ${intent.repayAsset} debt whenever health factor falls below ${intent.threshold}.${limit}`,
    sourceWalletAddress: wallet.address,
    sourceWalletLabel: wallet.label,
    config,
  };
}

/** custom_call steps whose (target, function) pair isn't on this account's trusted list — needs explicit confirmation, not silent execution. */
function findHighRiskSteps(accountId: string, plan: ExecutionPlan): HighRiskStepWarning[] {
  const warnings: HighRiskStepWarning[] = [];
  for (const step of plan.steps) {
    if (step.action !== "custom_call" || !step.customCallTarget || !step.customCallFunction) continue;
    if (!isAllowed(accountId, step.customCallTarget, step.customCallFunction)) {
      warnings.push({
        stepId: step.id,
        target: step.customCallTarget,
        functionSignature: step.customCallFunction,
        reason: "This calls a contract/method not on your trusted list yet. Review before confirming — confirming will trust it for future plans too.",
      });
    }
  }
  return warnings;
}

export async function runChatTurn(
  accountId: string,
  history: L0Turn[],
  userText: string,
  // Lazy — only invoked once triage decides this turn genuinely needs real
  // on-chain balances, instead of every single turn eagerly paying for a
  // multi-chain read + USD pricing before even knowing if it's relevant.
  getStates: () => Promise<WalletStateSnapshot[]>,
  wallets: WalletListEntry[],
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
  // Fires right after the goal parser produces a structured Goal, before
  // planning starts — lets a caller (server.ts's /chat/stream) show the
  // parsed goal to the user as its own step, matching the real narrative
  // ("reading balances" -> "parsed your goal" -> "planning...") instead of
  // only surfacing the final plan.
  onGoal?: (goal: Goal) => void,
  // Fires right before getState() resolves, once triage has decided this
  // turn actually needs it — lets a caller show a "reading balances" step
  // only when it's genuinely about to happen, not unconditionally.
  onReadingBalances?: (states: WalletStateSnapshot[]) => void | Promise<void>,
  // Fires right before each critical-path agent call starts (triage /
  // readiness / intent / planning) — real-time, so a caller can show what's
  // actually happening right now instead of a static "..." for the several
  // seconds each LLM call genuinely takes. Purely informational, never
  // awaited by this function itself.
  onStage?: (stage: "triage" | "readiness" | "parsing_goal" | "parsing_automation" | "planning") => void
): Promise<ChatTurnResult> {
  const memoryContext = buildMemoryContext(accountId, userText);

  onStage?.("triage");
  const triage = await triageIntent(history, userText, wallets, model);
  if (!triage.needsWalletState) {
    return { kind: "question", message: triage.directAnswer ?? "Could you say more about what you'd like to do?" };
  }

  const states = await getStates();
  await onReadingBalances?.(states);

  onStage?.("readiness");
  const decision = await judgeReadiness(history, userText, states, wallets, model);
  if (!decision.ready) {
    // A clarifying question doesn't carry much durable signal — extraction runs
    // on plan-producing turns, where the user has actually stated something concrete.
    return { kind: "question", message: decision.message };
  }

  onStage?.("parsing_automation");
  const automationIntent = await parseAutomationIntent(history, userText, states, wallets, model);
  if (automationIntent.kind === "incomplete") return { kind: "question", message: automationIntent.question };
  if (automationIntent.kind !== "none") {
    try {
      const automation = draftAutomation(automationIntent, states);
      return { kind: "automation_draft", message: "I turned that recurring/conditional request into an automation. Review it once; after confirmation it will appear in Automations and run on its own.", automation };
    } catch (err) {
      return { kind: "question", message: err instanceof Error ? err.message : String(err) };
    }
  }

  onStage?.("parsing_goal");
  const conversationText = [...history.map((h) => `${h.role}: ${h.content}`), `user: ${userText}`].join("\n");
  const goal = await parseGoal(conversationText, states, wallets, model, memoryContext);
  onGoal?.(goal);
  try {
    onStage?.("planning");
    const plan = await buildPlan(goal, states, wallets, model, memoryContext);

    // Fire-and-forget: neither of these affects what this turn returns to the
    // user (extraction only helps a FUTURE turn; review is advisory logging
    // only — see the file-level comment for why both were moved off the
    // critical path). Errors are still logged, just not awaited.
    extractFromTurn(accountId, userText, decision.message, model).catch((err) => {
      console.error("[memory] extraction failed:", err instanceof Error ? err.message : err);
    });

    runReviewPanel(goal, plan, states, wallets)
      .then((review) => {
        console.log("[review] goalMatch:", review.goalMatch, "feasibility:", review.feasibility);
      })
      .catch((err) => {
        console.error("[review] panel failed:", err instanceof Error ? err.message : err);
      });

    return { kind: "plan", message: decision.message, goal, plan, highRiskSteps: findHighRiskSteps(accountId, plan) };
  } catch (err) {
    const message = publicErrorMessage(err);
    return { kind: "plan_failed", message: decision.message, error: message };
  }
}
