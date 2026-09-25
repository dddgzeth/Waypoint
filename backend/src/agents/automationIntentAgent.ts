/**
 * Automation intent agent. It recognizes durable, self-running requests in
 * chat and turns them into a typed draft. A draft is deliberately not a
 * trigger: the user gets one final confirmation before it can make any
 * on-chain transaction or start monitoring a position.
 */
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { WalletListEntry, WalletStateSnapshot } from "../models.js";
import { describeWalletList, describeWalletStates } from "../models.js";
import type { L0Turn } from "../memory/store.js";

const AutomationIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("incomplete"),
    automationType: z.enum(["dca", "health_factor"]),
    question: z.string(),
  }),
  z.object({
    kind: z.literal("dca"),
    chain: z.string(),
    tokenIn: z.string(),
    tokenOut: z.string(),
    amountPerBuy: z.number(),
    intervalMinutes: z.number().int().positive().nullable(),
    timeOfDayUtc: z.string().nullable(),
    startAfterMinutes: z.number().int().positive().nullable(),
    executionCount: z.number().int().positive().nullable(),
    sourceWalletLabel: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("health_factor"),
    chain: z.string(),
    threshold: z.number().positive(),
    repayAsset: z.string(),
    repayPercent: z.number().positive().max(100),
    executionCount: z.number().int().positive().nullable(),
    sourceWalletLabel: z.string().nullable(),
  }),
]);

export type AutomationIntent = z.infer<typeof AutomationIntentSchema>;
const AutomationIntentResponseSchema = z.object({ intent: AutomationIntentSchema });

const SYSTEM_PROMPT = `You are Waypoint's automation-intent agent.
Recognize only requests that should keep running without the user returning:
- DCA / recurring purchase / scheduled periodic swap.
- A health-factor safety rule that repays debt when a threshold is crossed.

Return kind="none" for a one-off swap, transfer, deposit, withdrawal, or any
ordinary execution goal. Do not invent a schedule, a token, an amount, a
chain, or a wallet. For an automation request that is missing an indispensable
field, return kind="incomplete" with exactly one short question. For DCA,
intervalMinutes is required unless the user specified a daily UTC clock time.
Use a contract address exactly as supplied when the user names an arbitrary
ERC-20. executionCount is the requested number of successful on-chain actions:
successful purchases for DCA, or successful repayments for a health-factor
rule. Set it whenever the user says to stop after a number of confirmed
actions. Omit timeOfDayUtc and startAfterMinutes unless explicitly requested:
a DCA starts with an immediate first purchase by default.`;

function client(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable not found");
  return new OpenAI({ apiKey });
}

export async function parseAutomationIntent(
  history: L0Turn[],
  userText: string,
  states: WalletStateSnapshot[],
  wallets: WalletListEntry[],
  model: string
): Promise<AutomationIntent> {
  const conversation = [...history.map((turn) => `${turn.role}: ${turn.content}`), `user: ${userText}`].join("\n");
  const completion = await client().beta.chat.completions.parse({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Selected chat wallet is first in the state list.\n\n${describeWalletStates(states)}\n\n${describeWalletList(wallets)}\n\nConversation:\n${conversation}`,
      },
    ],
    response_format: zodResponseFormat(AutomationIntentResponseSchema, "automation_intent"),
  });
  const parsed = completion.choices[0].message.parsed;
  if (!parsed) throw new Error("Automation intent parsing failed: the model did not return a parseable result");
  return parsed.intent;
}
