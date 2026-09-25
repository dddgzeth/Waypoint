/**
 * Review panel — the last two agents in Waypoint's multi-agent pipeline (see
 * plan-finals-v2.md section 2). Deliberately a DIFFERENT model/provider from
 * every agent above (Claude Sonnet 5, via REVIEW_AGENT_* env vars, an
 * OpenAI-compatible gateway) — not for show, but because a genuinely
 * different model doesn't share the planning agents' blind spots the way
 * asking the same model to re-check its own work would.
 *
 * Two narrow, separate reviewers instead of one do-everything reviewer:
 *   - Goal-Match Agent: does the plan actually match the stated goal?
 *   - Feasibility Agent: does the plan hold up against real on-chain state?
 * Each gets a focused prompt and a focused job, same reasoning as splitting
 * the "understand -> plan" pipeline into Triage/Readiness/Intent/Planning
 * agents instead of one monolithic call.
 *
 * Advisory only, never a silent gate — see plan-finals-v2.md's explicit
 * "flexibility over restriction" stance. A concern here shows up alongside
 * the plan for the human to weigh, exactly like the existing highRiskSteps
 * warning; it never blocks or auto-retries the plan on its own. This gateway
 * also doesn't support the strict-JSON-schema `.beta.chat.completions.parse`
 * path the other agents use (confirmed by real testing — it returns prose,
 * not JSON, when asked that way) — these calls use plain
 * `chat.completions.create` with a JSON-only instruction and a manual
 * markdown-fence-stripping parse instead, validated against zod after.
 */
import OpenAI from "openai";
import { z } from "zod";
import type { Goal, ExecutionPlan, WalletState, WalletListEntry } from "../models.js";
import { describeWalletState, describeWalletList } from "../models.js";

const ReviewResultSchema = z.object({
  approved: z.boolean().describe("True if you found no real, specific issue — default to true"),
  concerns: z
    .array(z.string())
    .describe("Specific, concrete issues only — empty array if none. Never stylistic nitpicks."),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

function reviewClient(): OpenAI {
  const apiKey = process.env.REVIEW_AGENT_API_KEY;
  const baseURL = process.env.REVIEW_AGENT_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new Error("REVIEW_AGENT_API_KEY / REVIEW_AGENT_BASE_URL environment variables not found");
  }
  return new OpenAI({ apiKey, baseURL });
}

function reviewModel(): string {
  const model = process.env.REVIEW_AGENT_MODEL;
  if (!model) throw new Error("REVIEW_AGENT_MODEL environment variable not found");
  return model;
}

/** Strips a ```json ... ``` (or bare ```) fence the model wraps its answer in despite being told not to — confirmed real behavior of this gateway/model, not hypothetical. */
function stripFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

async function callReviewer(systemPrompt: string, userContent: string): Promise<ReviewResult> {
  const completion = await reviewClient().chat.completions.create({
    model: reviewModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });
  const raw = completion.choices[0].message.content;
  if (!raw) throw new Error("Review agent returned no content");
  const parsedJson: unknown = JSON.parse(stripFence(raw));
  return ReviewResultSchema.parse(parsedJson);
}

const GOAL_MATCH_SYSTEM_PROMPT = `You are Waypoint's Goal-Match Review Agent — a SEPARATE model from the one
that proposed this plan, reviewing independently so you don't share its blind spots.

Your only question: does this execution plan actually accomplish the stated goal? Check the
asset, the chain, the source/destination wallets, and whether the amount is in the right
ballpark. You are not re-planning and not enforcing a permission policy — you are catching
real mismatches a different model might have made: wrong asset, wrong chain, wrong wallet,
a step that's missing, or a step that does something the goal never asked for.

Default to approved=true. Only raise a concern that is specific and would genuinely cause
this plan to do the wrong thing — never a stylistic preference or a hypothetical "could add
more detail" note.

Respond with ONLY a JSON object matching {"approved": boolean, "concerns": string[]}. No
other text, no markdown code fences.`;

/** Checks the plan against the stated goal — resolved wallet labels included so a mismatched address is actually legible, not just a raw 0x string. */
export async function reviewGoalMatch(goal: Goal, plan: ExecutionPlan, wallets: WalletListEntry[]): Promise<ReviewResult> {
  const userContent = `Goal:\n${JSON.stringify(goal, null, 2)}\n\n${describeWalletList(wallets)}\n\nProposed plan:\n${JSON.stringify(plan, null, 2)}`;
  return callReviewer(GOAL_MATCH_SYSTEM_PROMPT, userContent);
}

const FEASIBILITY_SYSTEM_PROMPT = `You are Waypoint's Feasibility Review Agent — a SEPARATE model from the one
that proposed this plan, reviewing independently so you don't share its blind spots.

Your only question: does this execution plan hold up against the REAL current on-chain
balances of every wallet it actually touches (each one given below, by address), and does it
respect anything in the given execution knowledge (if any)? Check that each step's source has
enough of the asset it's spending, and enough of the chain's native token left over to
actually pay for its own gas — a step that would drain a wallet's only native balance for its
own transfer, leaving nothing for the gas that same transfer needs, is exactly the kind of
concrete, catchable mistake to flag. Match each step to the wallet state with the SAME address
— a step whose source address has no wallet state listed below at all means you were not given
that data, not that the wallet is empty; say so explicitly rather than assuming a zero balance.

Default to approved=true. Only raise a concern that is specific and tied to the real numbers
you were given — never a hypothetical ("gas prices might rise") with nothing concrete behind
it.

Respond with ONLY a JSON object matching {"approved": boolean, "concerns": string[]}. No
other text, no markdown code fences.`;

/**
 * Checks the plan against real balances (and, once wired up, retrieved execution-knowledge
 * facts — knowledgeContext is optional and empty until plan-finals-v2.md section 1 lands).
 *
 * Takes one WalletState per wallet the plan actually references, not just the currently
 * active chat wallet — a plan whose transferFrom names a different wallet (e.g. an execution
 * wallet) needs THAT wallet's real balance to judge feasibility at all, see chat.ts's caller.
 */
export async function reviewFeasibility(
  goal: Goal,
  plan: ExecutionPlan,
  states: WalletState[],
  knowledgeContext = ""
): Promise<ReviewResult> {
  const statesText = states.map(describeWalletState).join("\n\n");
  const userContent = `Goal:\n${JSON.stringify(goal, null, 2)}\n\nReal current wallet state (one or more wallets, only these — no other wallet's balance is known):\n${statesText}${
    knowledgeContext ? `\n\n${knowledgeContext}` : ""
  }\n\nProposed plan:\n${JSON.stringify(plan, null, 2)}`;
  return callReviewer(FEASIBILITY_SYSTEM_PROMPT, userContent);
}

export interface ReviewPanelResult {
  goalMatch: ReviewResult;
  feasibility: ReviewResult;
}

/** Runs both reviewers in parallel — they're independent questions, no reason to serialize them. Either failing (e.g. the gateway is down) shouldn't take down the whole turn — see chat.ts's caller, which catches this and treats a failed review as "no review available" rather than blocking the plan. */
export async function runReviewPanel(
  goal: Goal,
  plan: ExecutionPlan,
  states: WalletState[],
  wallets: WalletListEntry[],
  knowledgeContext = ""
): Promise<ReviewPanelResult> {
  const [goalMatch, feasibility] = await Promise.all([
    reviewGoalMatch(goal, plan, wallets),
    reviewFeasibility(goal, plan, states, knowledgeContext),
  ]);
  return { goalMatch, feasibility };
}
