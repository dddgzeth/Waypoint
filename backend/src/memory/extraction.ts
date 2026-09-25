/**
 * L1 extraction + L3 persona regeneration. Runs after a completed turn (not
 * every turn produces something — most don't, and that's expected). Adapted
 * from TencentDB Agent Memory's Chat Memory design (see plan-finals.md §2):
 * strict typed-JSON output per atom, one LLM call, empty result is valid.
 */
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { L1_ATOM_TYPES, insertL1Atom, upsertScenario, setPersona, getAllL1Atoms } from "./store.js";

const ExtractionSchema = z.object({
  scenario: z
    .string()
    .describe("Short theme name for this conversation, e.g. 'consolidating yield across Arbitrum and Base'"),
  atoms: z
    .array(
      z.object({
        type: z.enum(L1_ATOM_TYPES),
        content: z.string().describe("A complete, standalone statement — must make sense with no other context"),
      })
    )
    .describe("Durable facts/preferences/constraints worth remembering across future sessions. Empty if none."),
});

const EXTRACTION_SYSTEM_PROMPT = `You are Waypoint's memory extraction module.

From the latest turn of a conversation, extract only information that is worth
remembering ACROSS FUTURE SESSIONS — not one-off details specific to just this
request. Filter hard: most turns produce zero atoms, and that's correct, not a
failure.

Allowed types:
- gas_reserve: a standing amount/policy the user wants kept for gas (e.g. "always keep 0.05 ETH on Arbitrum for gas")
- protocol_preference: a lasting preference or aversion for a specific protocol
- chain_preference: a lasting preference for where they like to hold/settle assets
- risk_tolerance: how conservative or aggressive they are about protocol risk
- recurring_goal: something they do or want done repeatedly, not just this once
- execution_outcome: an operational fact worth remembering about how something went (e.g. typical bridge duration)

Do NOT extract: the specific amount/asset/chain of THIS one request (that's the
goal, not a memory), pleasantries, or anything that only makes sense in the
context of this single conversation.

Also give the conversation a short scenario/theme name (e.g. "consolidating
yield across Arbitrum and Base") — reused across turns on the same theme.`;

function client(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable not found");
  return new OpenAI({ apiKey });
}

const PERSONA_RELEVANT_TYPES = new Set(["risk_tolerance", "protocol_preference", "chain_preference", "gas_reserve"]);

export async function extractFromTurn(
  accountId: string,
  userText: string,
  assistantText: string,
  model = process.env.OPENAI_MODEL || "gpt-4o-mini"
): Promise<{ atomsExtracted: number; scenario: string | null }> {
  const openai = client();
  const completion = await openai.beta.chat.completions.parse({
    model,
    messages: [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: `user: ${userText}\nassistant: ${assistantText}` },
    ],
    response_format: zodResponseFormat(ExtractionSchema, "extraction"),
  });

  const parsed = completion.choices[0].message.parsed;
  if (!parsed || parsed.atoms.length === 0) {
    return { atomsExtracted: 0, scenario: null };
  }

  for (const atom of parsed.atoms) {
    insertL1Atom(accountId, atom.type, atom.content, parsed.scenario);
  }
  upsertScenario(accountId, parsed.scenario, describeScenarioAtoms(parsed.atoms.map((a) => a.content)));

  const touchedPersonaType = parsed.atoms.some((a) => PERSONA_RELEVANT_TYPES.has(a.type));
  if (touchedPersonaType) {
    await regeneratePersona(accountId, model);
  }

  return { atomsExtracted: parsed.atoms.length, scenario: parsed.scenario };
}

function describeScenarioAtoms(contents: string[]): string {
  return contents.join(" "); // scenario block: a running plain-text summary, refined further as more atoms land
}

const PersonaSchema = z.object({
  summary: z.string().describe("A short 2-4 sentence persona summary of how this user operates"),
});

async function regeneratePersona(accountId: string, model: string): Promise<void> {
  const atoms = getAllL1Atoms(accountId).filter((a) => PERSONA_RELEVANT_TYPES.has(a.type));
  if (atoms.length === 0) return;

  const openai = client();
  const completion = await openai.beta.chat.completions.parse({
    model,
    messages: [
      {
        role: "system",
        content:
          "Given these facts about how a user operates their on-chain assets, write a short 2-4 sentence persona summary of their operating style (risk tolerance, protocol/chain habits, standing constraints). Be concrete, not generic.",
      },
      { role: "user", content: atoms.map((a) => `[${a.type}] ${a.content}`).join("\n") },
    ],
    response_format: zodResponseFormat(PersonaSchema, "persona"),
  });

  const parsed = completion.choices[0].message.parsed;
  if (parsed) setPersona(accountId, parsed.summary);
}
