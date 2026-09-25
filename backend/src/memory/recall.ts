/**
 * Recall: assembles the memory context injected into goalParser/planner every
 * turn. L3 persona is always-on (no matching required). L1 atoms are the
 * FTS-searched fallback for specific facts relevant to the current message —
 * capped to a small count so memory never crowds out the real context.
 */
import { getPersona, searchL1Atoms } from "./store.js";

const L1_RECALL_LIMIT = 6;

export function buildMemoryContext(accountId: string, currentMessage: string): string {
  const parts: string[] = [];

  const persona = getPersona(accountId);
  if (persona) {
    parts.push(`<user-persona>\n${persona}\n</user-persona>`);
  }

  const atoms = searchL1Atoms(accountId, currentMessage, L1_RECALL_LIMIT);
  if (atoms.length > 0) {
    const lines = atoms.map((a) => `[${a.type}] ${a.content}`);
    parts.push(`<user-memory>\n${lines.join("\n")}\n</user-memory>`);
  }

  return parts.join("\n\n");
}
