/**
 * Goal parser: natural language + current on-chain state -> structured Goal.
 *
 * Design principle (from plan.md's architecture): this layer only "understands
 * what the user wants" — it never emits executable transaction details.
 * That keeps an LLM hallucination away from directly causing a bad fund
 * movement. Generating executable steps is planner.ts's job.
 */
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { GoalSchema, type Goal, type WalletStateSnapshot, type WalletListEntry, describeWalletStates, describeWalletList } from "./models.js";
import { buildKnowledgeContext } from "./knowledge/store.js";

const SYSTEM_PROMPT = `You are Waypoint's goal parser module.
Your only job: turn the user's natural-language input, combined with their real cross-chain
asset state, into a structured goal description.

Strict rules:
- Only describe the target end state and constraints the user wants. Do not generate
  specific transaction steps, and do not pick a specific bridge/DEX/protocol to call.
- If the user didn't explicitly say which protocol has the best yield, set
  needsYieldLookup to true — never guess a protocol name yourself.
- The same applies to targetChain when the user asked for "the best/highest-yielding"
  option without naming a specific chain: set needsYieldLookup to true AND leave
  targetChain null, so a live on-chain comparison across chains can decide it. Never
  put a description like "whichever chain has the best yield" into targetChain — that
  is not a real chain and breaks the live lookup, silently turning a "compare real
  yields" request into an unverified guess.
- Put any constraint the user explicitly mentioned (e.g. "keep some for gas") into
  constraints; return an empty array if there are none.
- sourceWalletLabels is for wallet labels named as the source of assets, not a
  destination or recipient. Copy each matching label exactly as it appears in
  the known wallet list. Do not invent labels; return [] when no source was named.
- existingProtocolPositions describes scope, not an execution step. Set it to
  "include" only when the user explicitly includes all existing assets or
  protocol positions in the operation. Set it to "preserve" when the user says
  not to touch existing positions, or limits the operation to newly created,
  received, bridged, swapped, or borrowed output. Otherwise use "unspecified".`;

function client(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable not found. Run `export OPENAI_API_KEY=sk-...` first.");
  }
  return new OpenAI({ apiKey });
}

function normalizeNullable(value: string | null): string | null {
  const normalized = value?.replace(/^[\s:/]+|[\s:/]+$/g, "") ?? "";
  return !normalized || normalized.toLowerCase() === "null" ? null : normalized;
}

export async function parseGoal(
  userText: string,
  states: WalletStateSnapshot[],
  wallets: WalletListEntry[] = [],
  model = process.env.OPENAI_MODEL || "gpt-4o-mini",
  memoryContext?: string
): Promise<Goal> {
  const openai = client();

  // Lighter-weight knowledge hook than planner.ts's — at this stage there's
  // no structured Goal yet to pull keywords from, so this searches on the
  // raw user text itself (e.g. catches the currency-slang entry when the
  // user writes something like "4U" before any parsing has happened).
  const knowledgeNote = buildKnowledgeContext(userText);

  const systemPrompt = memoryContext ? `${SYSTEM_PROMPT}\n\n${memoryContext}` : SYSTEM_PROMPT;
  const completion = await openai.beta.chat.completions.parse({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Wallet states:\n${describeWalletStates(states)}\n\n${describeWalletList(wallets)}\n\nUser input: ${userText}${
          knowledgeNote ? `\n\n${knowledgeNote}` : ""
        }`,
      },
    ],
    response_format: zodResponseFormat(GoalSchema, "goal"),
  });

  const parsed = completion.choices[0].message.parsed;
  if (!parsed) {
    throw new Error("Goal parsing failed: the model did not return a parseable structured output");
  }

  const knownLabels = new Set(wallets.map((wallet) => wallet.label.toLowerCase()));
  return {
    ...parsed,
    targetChain: normalizeNullable(parsed.targetChain),
    targetAsset: normalizeNullable(parsed.targetAsset),
    // Structured-output models occasionally emit empty array placeholders for
    // labels. A label is only meaningful when it identifies an account wallet;
    // discard malformed entries here so the planner can use its normal
    // account-wide execution-wallet default instead of failing on "".
    sourceWalletLabels: parsed.sourceWalletLabels.filter((label) => knownLabels.has(label.trim().toLowerCase())),
  };
}
