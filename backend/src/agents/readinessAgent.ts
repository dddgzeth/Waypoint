/**
 * Readiness Agent — second in Waypoint's multi-agent pipeline (see
 * plan-finals-v2.md). Its one job: given the conversation and real wallet
 * state, decide whether there's enough information to state ONE complete,
 * unambiguous on-chain goal yet, or whether a clarifying question is needed
 * first. This is a genuinely separate judgment from "what does the user
 * want" (that's the Intent Agent's job, goalParser.ts) — readiness is purely
 * "do we have enough to hand off to intent parsing at all."
 */
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { WalletStateSnapshot, WalletListEntry } from "../models.js";
import { describeWalletStates, describeWalletList } from "../models.js";
import type { L0Turn } from "../memory/store.js";

const ReadinessSchema = z.object({
  ready: z.boolean().describe("True if there's enough information to state one complete, unambiguous on-chain goal"),
  message: z
    .string()
    .describe(
      "If ready=false: one short, specific clarifying question. If ready=true: a brief natural-language acknowledgment of what you understood, e.g. 'Got it — planning that now.'"
    ),
});
export type ReadinessResult = z.infer<typeof ReadinessSchema>;

const READINESS_SYSTEM_PROMPT = `You are Waypoint's conversation-readiness judge.

Given the conversation so far, the user's real current wallet state, and the account's
known wallet list (label -> address), decide whether there is enough information to
state ONE complete, unambiguous on-chain goal (a target end state — which asset, which
chain, what to do with it).

The FIRST wallet state is the wallet currently selected in chat. If the user names a
recipient but omits a source (for example "give execution wallet 2 1U"), treat that
selected wallet as the default source; do not ask where to obtain the funds when it
already has a suitable executable balance.

Default to ready=true. Only set ready=false if something the plan genuinely cannot
proceed without is missing or ambiguous (e.g. which of several very different assets
they mean, an amount when it matters and isn't "all of it"). Do NOT ask about things
that have a reasonable default or get resolved later in the pipeline — "which protocol
has the best yield" is fine to leave open, that's what live yield lookup is for. If the
user names a recipient by a wallet's label (e.g. a nickname they set) and that label is
in the known wallet list, that already fully identifies the address — do NOT ask for it;
only ask if the named wallet genuinely isn't in that list.

If ready=false, ask exactly ONE short, specific clarifying question — not a list of
questions, not a restatement of everything that's unclear.

For a consolidation goal naming several of the account's execution wallets,
never ask which one should become the destination. The planner can select one
of those named execution wallets as the consolidation destination and present
that choice in the single final confirmation.`;

function client(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable not found");
  }
  return new OpenAI({ apiKey });
}

export async function judgeReadiness(
  history: L0Turn[],
  userText: string,
  states: WalletStateSnapshot[],
  wallets: WalletListEntry[],
  model: string
): Promise<ReadinessResult> {
  const openai = client();
  const conversation = [...history.map((h) => `${h.role}: ${h.content}`), `user: ${userText}`].join("\n");

  const completion = await openai.beta.chat.completions.parse({
    model,
    messages: [
      { role: "system", content: READINESS_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Selected chat wallet / default payment source when the user omits a source: ${
          states[0] ? `"${states[0].label}" (${states[0].address})` : "none"
        }\n\nCurrent wallet states:\n${describeWalletStates(states)}\n\n${describeWalletList(wallets)}\n\nConversation so far:\n${conversation}`,
      },
    ],
    response_format: zodResponseFormat(ReadinessSchema, "readiness"),
  });

  const parsed = completion.choices[0].message.parsed;
  if (!parsed) {
    throw new Error("Readiness judgment failed: the model did not return a parseable structured output");
  }
  return parsed;
}
