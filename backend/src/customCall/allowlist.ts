/**
 * Per-account allowlist of (target contract, function signature) pairs
 * trusted for custom_call steps — the escape-hatch action type for on-chain
 * operations outside the other 4 built-in action types. A step calling
 * something NOT on the list isn't rejected outright; it's surfaced to the
 * user as a high-risk step that needs explicit confirmation before it can
 * run (see chat.ts / server.ts) — confirming it also adds it to the list, so
 * repeat calls to the same contract+method don't ask again.
 */
import { getDb } from "../accounts/store.js";

let initialized = false;
function ensureSchema(): void {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_call_allowlist (
      account_id TEXT NOT NULL,
      target TEXT NOT NULL,
      function_signature TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, target, function_signature)
    );
  `);
  initialized = true;
}

function normalize(target: string, functionSignature: string): { target: string; sig: string } {
  return { target: target.toLowerCase(), sig: functionSignature.trim() };
}

export function isAllowed(accountId: string, target: string, functionSignature: string): boolean {
  ensureSchema();
  const db = getDb();
  const { target: t, sig } = normalize(target, functionSignature);
  const row = db
    .prepare(`SELECT 1 FROM custom_call_allowlist WHERE account_id = ? AND target = ? AND function_signature = ?`)
    .get(accountId, t, sig);
  return Boolean(row);
}

export function trust(accountId: string, target: string, functionSignature: string): void {
  ensureSchema();
  const db = getDb();
  const { target: t, sig } = normalize(target, functionSignature);
  db.prepare(
    `INSERT INTO custom_call_allowlist (account_id, target, function_signature, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, target, function_signature) DO NOTHING`
  ).run(accountId, t, sig, new Date().toISOString());
}

export function revoke(accountId: string, target: string, functionSignature: string): void {
  ensureSchema();
  const db = getDb();
  const { target: t, sig } = normalize(target, functionSignature);
  db.prepare(`DELETE FROM custom_call_allowlist WHERE account_id = ? AND target = ? AND function_signature = ?`).run(accountId, t, sig);
}

export function listAllowed(accountId: string): Array<{ target: string; functionSignature: string; createdAt: string }> {
  ensureSchema();
  const db = getDb();
  const rows = db
    .prepare(`SELECT target, function_signature, created_at FROM custom_call_allowlist WHERE account_id = ? ORDER BY created_at DESC`)
    .all(accountId) as Array<{ target: string; function_signature: string; created_at: string }>;
  return rows.map((r) => ({ target: r.target, functionSignature: r.function_signature, createdAt: r.created_at }));
}
