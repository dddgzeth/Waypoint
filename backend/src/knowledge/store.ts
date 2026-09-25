/**
 * Execution knowledge base: a small factual corpus for improving on-chain
 * execution accuracy/speed, retrieved on-demand and injected as context —
 * never a code-level rule that overrides the model's own judgment (see
 * plan-finals-v2.md §1 for the full reasoning: the targetAmountUsd currency-
 * detection regex was tried and deleted for exactly this reason).
 *
 * Reuses the same FTS5 pattern as memory/store.ts's l1_atoms/l1_fts (trigram
 * tokenizer, content-linked virtual table), but this corpus is NOT scoped to
 * an account — it's one shared body of facts every account benefits from,
 * seeded once from real bugs this project actually hit (seed.ts), not
 * user-specific memory.
 */
import crypto from "node:crypto";
import { getDb } from "../accounts/store.js";

let initialized = false;
export function ensureKnowledgeSchema(): void {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_knowledge (
      record_id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      keywords TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS execution_knowledge_fts USING fts5(
      record_id UNINDEXED, title, keywords, body,
      content='execution_knowledge', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS execution_knowledge_fts_insert AFTER INSERT ON execution_knowledge BEGIN
      INSERT INTO execution_knowledge_fts(rowid, record_id, title, keywords, body)
      VALUES (new.rowid, new.record_id, new.title, new.keywords, new.body);
    END;
  `);
  initialized = true;
}

export type KnowledgeCategory = "execution_gotcha" | "data_source";

export interface KnowledgeEntry {
  recordId: string;
  category: KnowledgeCategory;
  title: string;
  keywords: string;
  body: string;
  createdAt: string;
}

/** Seed-only insert — this corpus is written once by seed.ts, never edited at runtime by the agent. */
export function insertKnowledgeEntry(
  category: KnowledgeCategory,
  title: string,
  keywords: string,
  body: string
): KnowledgeEntry {
  ensureKnowledgeSchema();
  const db = getDb();
  const entry: KnowledgeEntry = {
    recordId: `ek_${crypto.randomBytes(8).toString("hex")}`,
    category,
    title,
    keywords,
    body,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO execution_knowledge (record_id, category, title, keywords, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(entry.recordId, entry.category, entry.title, entry.keywords, entry.body, entry.createdAt);
  return entry;
}

export function countKnowledgeEntries(): number {
  ensureKnowledgeSchema();
  const db = getDb();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM execution_knowledge`).get() as { n: number };
  return row.n;
}

function buildFtsQuery(text: string): string {
  const cleaned = text.replace(/["']/g, " ").trim();
  if (!cleaned) return '""';
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

/** FTS search over the whole (unscoped) knowledge base — modeled on Cobo's `caw recipe search --keywords`: pass the small set of real keywords a caller already knows (chain/token/action), not a whole sentence. */
export function searchExecutionKnowledge(query: string, limit = 3): KnowledgeEntry[] {
  ensureKnowledgeSchema();
  const db = getDb();
  const fts = buildFtsQuery(query);
  try {
    const rows = db
      .prepare(
        `SELECT e.* FROM execution_knowledge_fts f JOIN execution_knowledge e ON e.record_id = f.record_id
         WHERE execution_knowledge_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(fts, limit) as Array<{
      record_id: string;
      category: KnowledgeCategory;
      title: string;
      keywords: string;
      body: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      recordId: r.record_id,
      category: r.category,
      title: r.title,
      keywords: r.keywords,
      body: r.body,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

/** Formats retrieved entries into a ready-to-inject prompt block — empty string when nothing matched, so callers can splice it in unconditionally. */
export function buildKnowledgeContext(query: string, limit = 3): string {
  const entries = searchExecutionKnowledge(query, limit);
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `- ${e.title}: ${e.body}`);
  return `<execution-knowledge>\n${lines.join("\n")}\n</execution-knowledge>`;
}
