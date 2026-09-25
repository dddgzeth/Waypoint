/**
 * Memory store: L0 (raw turns) -> L1 (typed atoms) -> L2 (scenario blocks) ->
 * L3 (persona). Modeled on Tencent/TencentDB-Agent-Memory's Chat Memory asset
 * design (see plan-finals.md §2) — L2/L3 are the always-on context bootstrap
 * injected every turn, L1/L0 are the FTS-searched fallback for specific facts.
 */
import crypto from "node:crypto";
import { getDb } from "../accounts/store.js";

let initialized = false;
function ensureSchema(): void {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS l0_conversations (
      record_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_l0_session ON l0_conversations(account_id, session_id, timestamp);

    CREATE TABLE IF NOT EXISTS l1_atoms (
      record_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      scenario TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_l1_account ON l1_atoms(account_id, timestamp DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
      record_id UNINDEXED, account_id UNINDEXED, content,
      content='l1_atoms', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS l1_fts_insert AFTER INSERT ON l1_atoms BEGIN
      INSERT INTO l1_fts(rowid, record_id, account_id, content) VALUES (new.rowid, new.record_id, new.account_id, new.content);
    END;

    CREATE TABLE IF NOT EXISTS l2_scenarios (
      scenario TEXT NOT NULL,
      account_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, scenario)
    );

    CREATE TABLE IF NOT EXISTS l3_persona (
      account_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // l0_conversations predates metadata (structured goal/plan data alongside
  // an assistant turn's plain-text summary) — add rather than recreate, same
  // pattern as accounts/store.ts's email/google_sub migration.
  const l0Cols = db.prepare(`PRAGMA table_info(l0_conversations)`).all() as Array<{ name: string }>;
  if (!l0Cols.some((c) => c.name === "metadata")) {
    db.exec(`ALTER TABLE l0_conversations ADD COLUMN metadata TEXT`);
  }
  initialized = true;
}

export interface L0Turn {
  recordId: string;
  accountId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  timestamp: number;
  // Structured data behind an assistant turn's plain-text summary (a parsed
  // Goal + ExecutionPlan + highRiskSteps, JSON-stringified) — lets a restored
  // past session re-render the same rich goal table / plan step cards the
  // live turn showed, instead of falling back to a wall of escaped plain
  // text. Null for user turns and for assistant turns with nothing structured
  // behind them (plain questions/answers).
  metadata: string | null;
}

export function appendTurn(
  accountId: string,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  metadata?: unknown
): L0Turn {
  ensureSchema();
  const db = getDb();
  const turn: L0Turn = {
    recordId: `l0_${crypto.randomBytes(8).toString("hex")}`,
    accountId,
    sessionId,
    role,
    content,
    createdAt: new Date().toISOString(),
    timestamp: Date.now(),
    metadata: metadata !== undefined ? JSON.stringify(metadata) : null,
  };
  db.prepare(
    `INSERT INTO l0_conversations (record_id, account_id, session_id, role, content, created_at, timestamp, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(turn.recordId, turn.accountId, turn.sessionId, turn.role, turn.content, turn.createdAt, turn.timestamp, turn.metadata);
  return turn;
}

export function getSessionHistory(accountId: string, sessionId: string, limit = 50): L0Turn[] {
  ensureSchema();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT record_id, account_id, session_id, role, content, created_at, timestamp, metadata
       FROM l0_conversations WHERE account_id = ? AND session_id = ?
       ORDER BY timestamp ASC LIMIT ?`
    )
    .all(accountId, sessionId, limit) as Array<{
    record_id: string;
    account_id: string;
    session_id: string;
    role: "user" | "assistant";
    content: string;
    created_at: string;
    timestamp: number;
    metadata: string | null;
  }>;
  return rows.map((r) => ({
    recordId: r.record_id,
    accountId: r.account_id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
    timestamp: r.timestamp,
    metadata: r.metadata,
  }));
}

/** Finds the thread that produced an automation draft. This is a recovery
 * path for an older browser tab that confirms a persisted draft without
 * sending its session id; normal confirmations pass the id directly. */
export function findAutomationDraftSession(accountId: string, automation: unknown): string | undefined {
  ensureSchema();
  const rows = getDb()
    .prepare(
      `SELECT session_id, metadata FROM l0_conversations
       WHERE account_id = ? AND role = 'assistant' AND metadata IS NOT NULL
       ORDER BY timestamp DESC LIMIT 100`
    )
    .all(accountId) as Array<{ session_id: string; metadata: string }>;
  for (const row of rows) {
    try {
      const metadata = JSON.parse(row.metadata) as { kind?: string; automation?: unknown };
      if (metadata.kind === "automation_draft" && JSON.stringify(metadata.automation) === JSON.stringify(automation)) {
        return row.session_id;
      }
    } catch {
      // Ignore malformed historic metadata; it cannot safely identify a draft.
    }
  }
  return undefined;
}

export interface SessionSummary {
  sessionId: string;
  title: string; // derived from the first user message in the session
  lastMessageAt: string;
  messageCount: number;
}

function deriveSessionTitle(firstUserMsg: string | null): string {
  if (!firstUserMsg) return "New chat";
  const cleaned = firstUserMsg.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New chat";
  return cleaned.length > 48 ? `${cleaned.slice(0, 48)}…` : cleaned;
}

/**
 * Lists this account's past chat sessions, newest first — there's no
 * separate sessions table, the existence of l0_conversations rows for a
 * session_id IS the session (same design as Synapse's chat sidebar). A
 * session with zero messages was never sent, so it never shows up here.
 */
export function listSessionsForAccount(accountId: string, limit = 50): SessionSummary[] {
  ensureSchema();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         session_id,
         MAX(created_at) AS last_at,
         COUNT(*) AS msg_count,
         (SELECT content FROM l0_conversations
          WHERE session_id = c.session_id AND account_id = c.account_id AND role = 'user'
          ORDER BY timestamp ASC LIMIT 1) AS first_user_msg
       FROM l0_conversations c
       WHERE account_id = ?
       GROUP BY session_id
       ORDER BY last_at DESC
       LIMIT ?`
    )
    .all(accountId, limit) as Array<{ session_id: string; last_at: string; msg_count: number; first_user_msg: string | null }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    title: deriveSessionTitle(r.first_user_msg),
    lastMessageAt: r.last_at,
    messageCount: r.msg_count,
  }));
}

/** Deletes every turn in one session. Ownership-scoped by accountId — a session_id from a different account is silently a no-op. */
export function deleteSession(accountId: string, sessionId: string): number {
  ensureSchema();
  const db = getDb();
  const result = db.prepare(`DELETE FROM l0_conversations WHERE account_id = ? AND session_id = ?`).run(accountId, sessionId);
  return result.changes;
}

// ============================
// L1: typed atoms (facts, preferences, constraints, events)
// ============================

export const L1_ATOM_TYPES = [
  "gas_reserve",
  "protocol_preference",
  "chain_preference",
  "risk_tolerance",
  "recurring_goal",
  "execution_outcome",
] as const;
export type L1AtomType = (typeof L1_ATOM_TYPES)[number];

export interface L1Atom {
  recordId: string;
  accountId: string;
  type: L1AtomType;
  content: string;
  scenario: string;
  createdAt: string;
  timestamp: number;
}

function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

const DEDUP_JACCARD = 0.75;

/** True if an atom of the same type with near-identical content already exists for this account. */
function isNearDuplicate(accountId: string, type: L1AtomType, content: string): boolean {
  const db = getDb();
  const existing = db
    .prepare(`SELECT content FROM l1_atoms WHERE account_id = ? AND type = ?`)
    .all(accountId, type) as Array<{ content: string }>;
  const grams = bigrams(content);
  return existing.some((e) => jaccard(grams, bigrams(e.content)) >= DEDUP_JACCARD);
}

export function insertL1Atom(accountId: string, type: L1AtomType, content: string, scenario = ""): L1Atom | null {
  ensureSchema();
  if (isNearDuplicate(accountId, type, content)) return null;
  const db = getDb();
  const atom: L1Atom = {
    recordId: `l1_${crypto.randomBytes(8).toString("hex")}`,
    accountId,
    type,
    content,
    scenario,
    createdAt: new Date().toISOString(),
    timestamp: Date.now(),
  };
  db.prepare(
    `INSERT INTO l1_atoms (record_id, account_id, type, content, scenario, created_at, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(atom.recordId, atom.accountId, atom.type, atom.content, atom.scenario, atom.createdAt, atom.timestamp);
  return atom;
}

export function getAllL1Atoms(accountId: string, limit = 200): L1Atom[] {
  ensureSchema();
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM l1_atoms WHERE account_id = ? ORDER BY timestamp DESC LIMIT ?`)
    .all(accountId, limit) as Array<{
    record_id: string;
    account_id: string;
    type: L1AtomType;
    content: string;
    scenario: string;
    created_at: string;
    timestamp: number;
  }>;
  return rows.map((r) => ({
    recordId: r.record_id,
    accountId: r.account_id,
    type: r.type,
    content: r.content,
    scenario: r.scenario,
    createdAt: r.created_at,
    timestamp: r.timestamp,
  }));
}

function buildFtsQuery(text: string): string {
  const cleaned = text.replace(/["']/g, " ").trim();
  if (!cleaned) return '""';
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length >= 3 || /^[a-zA-Z0-9]+$/.test(t))
    .slice(0, 6);
  if (tokens.length === 0) return cleaned.length >= 3 ? `"${cleaned.replace(/"/g, "")}"` : '""';
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

/** FTS search over one account's L1 atoms — the "fallback for specific facts" layer. */
export function searchL1Atoms(accountId: string, query: string, limit = 8): L1Atom[] {
  ensureSchema();
  const db = getDb();
  const fts = buildFtsQuery(query);
  try {
    const rows = db
      .prepare(
        `SELECT a.* FROM l1_fts f JOIN l1_atoms a ON a.record_id = f.record_id
         WHERE l1_fts MATCH ? AND a.account_id = ? ORDER BY rank LIMIT ?`
      )
      .all(fts, accountId, limit) as Array<{
      record_id: string;
      account_id: string;
      type: L1AtomType;
      content: string;
      scenario: string;
      created_at: string;
      timestamp: number;
    }>;
    return rows.map((r) => ({
      recordId: r.record_id,
      accountId: r.account_id,
      type: r.type,
      content: r.content,
      scenario: r.scenario,
      createdAt: r.created_at,
      timestamp: r.timestamp,
    }));
  } catch {
    return [];
  }
}

// ============================
// L2: scenario blocks
// ============================

export function upsertScenario(accountId: string, scenario: string, summary: string): void {
  ensureSchema();
  const db = getDb();
  db.prepare(
    `INSERT INTO l2_scenarios (account_id, scenario, summary, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, scenario) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`
  ).run(accountId, scenario, summary, new Date().toISOString());
}

export function getScenario(accountId: string, scenario: string): string | null {
  ensureSchema();
  const db = getDb();
  const row = db
    .prepare(`SELECT summary FROM l2_scenarios WHERE account_id = ? AND scenario = ?`)
    .get(accountId, scenario) as { summary: string } | undefined;
  return row?.summary ?? null;
}

export function listScenarios(accountId: string): Array<{ scenario: string; summary: string }> {
  ensureSchema();
  const db = getDb();
  return db
    .prepare(`SELECT scenario, summary FROM l2_scenarios WHERE account_id = ? ORDER BY updated_at DESC`)
    .all(accountId) as Array<{ scenario: string; summary: string }>;
}

// ============================
// L3: persona
// ============================

export function setPersona(accountId: string, summary: string): void {
  ensureSchema();
  const db = getDb();
  db.prepare(
    `INSERT INTO l3_persona (account_id, summary, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`
  ).run(accountId, summary, new Date().toISOString());
}

export function getPersona(accountId: string): string | null {
  ensureSchema();
  const db = getDb();
  const row = db.prepare(`SELECT summary FROM l3_persona WHERE account_id = ?`).get(accountId) as
    | { summary: string }
    | undefined;
  return row?.summary ?? null;
}
