/**
 * Trigger store: any account can register any number of automations —
 * "if health factor on this chain drops below X, repay Y% of debt Z" or
 * "buy $X of token Y on chain Z every day at time T" — each one registered
 * once and fired with no user present. Config is type-specific (see
 * types.ts) and stored as opaque JSON so adding a new trigger type never
 * needs a schema migration here.
 *
 * Replaces the old health_factor_triggers table (single-purpose, fixed
 * columns) — dev-only data, safe to reset outright rather than migrate.
 */
import { getDb } from "../accounts/store.js";
import type { TriggerConfig, TriggerType } from "./types.js";

let initialized = false;
function ensureSchema(): void {
  if (initialized) return;
  const db = getDb();
  db.exec(`DROP TABLE IF EXISTS health_factor_triggers`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      trigger_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      execution_wallet_id TEXT NOT NULL,
      chat_session_id TEXT,
      trigger_type TEXT NOT NULL,
      config TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_checked_at TEXT,
      last_fired_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_triggers_account ON triggers(account_id);

    CREATE TABLE IF NOT EXISTS trigger_executions (
      execution_id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      success INTEGER NOT NULL,
      tx_hash TEXT,
      gas_used TEXT,
      amount_in REAL,
      amount_out REAL,
      output_symbol TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_executions_trigger ON trigger_executions(trigger_id, fired_at DESC);

    -- One durable lease per trigger. The monitor and the explicit "Check now"
    -- endpoint share it, so the same rule cannot race itself into two swaps.
    CREATE TABLE IF NOT EXISTS trigger_attempts (
      trigger_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL
    );
  `);
  // A trigger can originate in Chat. Keep that relationship durable so a
  // scheduled on-chain result can be delivered back into the same thread.
  const columns = db.prepare(`PRAGMA table_info(triggers)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "chat_session_id")) {
    db.exec(`ALTER TABLE triggers ADD COLUMN chat_session_id TEXT`);
  }
  initialized = true;
}

export interface Trigger {
  triggerId: string;
  accountId: string;
  executionWalletId: string;
  chatSessionId: string | null;
  triggerType: TriggerType;
  config: TriggerConfig;
  active: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
  lastFiredAt: string | null;
}

type Row = {
  trigger_id: string;
  account_id: string;
  execution_wallet_id: string;
  chat_session_id: string | null;
  trigger_type: string;
  config: string;
  active: number;
  created_at: string;
  last_checked_at: string | null;
  last_fired_at: string | null;
};

function rowToTrigger(row: Row): Trigger {
  return {
    triggerId: row.trigger_id,
    accountId: row.account_id,
    executionWalletId: row.execution_wallet_id,
    chatSessionId: row.chat_session_id,
    triggerType: row.trigger_type as TriggerType,
    config: JSON.parse(row.config) as TriggerConfig,
    active: row.active === 1,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    lastFiredAt: row.last_fired_at,
  };
}

export function createTrigger(input: {
  triggerId: string;
  accountId: string;
  executionWalletId: string;
  chatSessionId?: string;
  config: TriggerConfig;
}): void {
  ensureSchema();
  const db = getDb();
  db.prepare(
    `INSERT INTO triggers (trigger_id, account_id, execution_wallet_id, chat_session_id, trigger_type, config, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    input.triggerId,
    input.accountId,
    input.executionWalletId,
    input.chatSessionId ?? null,
    input.config.type,
    JSON.stringify(input.config),
    new Date().toISOString()
  );
}

export function listTriggersForAccount(accountId: string): Trigger[] {
  ensureSchema();
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM triggers WHERE account_id = ? ORDER BY created_at ASC`).all(accountId) as Row[];
  return rows.map(rowToTrigger);
}

export function listActiveTriggers(): Trigger[] {
  ensureSchema();
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM triggers WHERE active = 1`).all() as Row[];
  return rows.map(rowToTrigger);
}

export function recordCheck(triggerId: string): void {
  ensureSchema();
  const db = getDb();
  db.prepare(`UPDATE triggers SET last_checked_at = ? WHERE trigger_id = ?`).run(new Date().toISOString(), triggerId);
}

export function recordFire(triggerId: string): void {
  ensureSchema();
  const db = getDb();
  db.prepare(`UPDATE triggers SET last_fired_at = ? WHERE trigger_id = ?`).run(new Date().toISOString(), triggerId);
}

/** Acquire a per-trigger execution lease. A stale lease can only be recovered
 * after a deliberately long window: short enough to survive a crashed worker,
 * long enough that an on-chain send/wait cannot be duplicated by a retry. */
export function beginAttempt(triggerId: string, staleAfterMs = 15 * 60 * 1000): boolean {
  ensureSchema();
  const db = getDb();
  const current = db.prepare(`SELECT started_at FROM trigger_attempts WHERE trigger_id = ?`).get(triggerId) as { started_at: string } | undefined;
  if (current && Date.now() - new Date(current.started_at).getTime() < staleAfterMs) return false;
  if (current) db.prepare(`DELETE FROM trigger_attempts WHERE trigger_id = ?`).run(triggerId);
  db.prepare(`INSERT INTO trigger_attempts (trigger_id, started_at) VALUES (?, ?)`).run(triggerId, new Date().toISOString());
  return true;
}

export function finishAttempt(triggerId: string): void {
  ensureSchema();
  getDb().prepare(`DELETE FROM trigger_attempts WHERE trigger_id = ?`).run(triggerId);
}

export function getAttemptStartedAt(triggerId: string): string | null {
  ensureSchema();
  const row = getDb().prepare(`SELECT started_at FROM trigger_attempts WHERE trigger_id = ?`).get(triggerId) as { started_at: string } | undefined;
  return row?.started_at ?? null;
}

export function setActive(accountId: string, triggerId: string, active: boolean): void {
  ensureSchema();
  const db = getDb();
  db.prepare(`UPDATE triggers SET active = ? WHERE trigger_id = ? AND account_id = ?`).run(active ? 1 : 0, triggerId, accountId);
}

export function setChatSession(accountId: string, triggerId: string, chatSessionId: string): void {
  ensureSchema();
  getDb()
    .prepare(`UPDATE triggers SET chat_session_id = ? WHERE trigger_id = ? AND account_id = ? AND chat_session_id IS NULL`)
    .run(chatSessionId, triggerId, accountId);
}

/** Removes an automation and its local execution history. Transactions already
 * broadcast on-chain remain immutable; an in-flight attempt cannot be undone. */
export function deleteTrigger(accountId: string, triggerId: string): boolean {
  ensureSchema();
  const db = getDb();
  const trigger = db.prepare(`SELECT trigger_id FROM triggers WHERE trigger_id = ? AND account_id = ?`).get(triggerId, accountId);
  if (!trigger) return false;
  db.transaction(() => {
    db.prepare(`DELETE FROM trigger_attempts WHERE trigger_id = ?`).run(triggerId);
    db.prepare(`DELETE FROM trigger_executions WHERE trigger_id = ? AND account_id = ?`).run(triggerId, accountId);
    db.prepare(`DELETE FROM triggers WHERE trigger_id = ? AND account_id = ?`).run(triggerId, accountId);
  })();
  return true;
}

export interface TriggerExecution {
  executionId: string;
  triggerId: string;
  firedAt: string;
  success: boolean;
  txHash: string | null;
  gasUsed: string | null;
  amountIn: number | null;
  amountOut: number | null;
  outputSymbol: string | null;
  errorMessage: string | null;
}

type ExecutionRow = {
  execution_id: string;
  trigger_id: string;
  fired_at: string;
  success: number;
  tx_hash: string | null;
  gas_used: string | null;
  amount_in: number | null;
  amount_out: number | null;
  output_symbol: string | null;
  error_message: string | null;
};

function rowToExecution(row: ExecutionRow): TriggerExecution {
  return {
    executionId: row.execution_id,
    triggerId: row.trigger_id,
    firedAt: row.fired_at,
    success: row.success === 1,
    txHash: row.tx_hash,
    gasUsed: row.gas_used,
    amountIn: row.amount_in,
    amountOut: row.amount_out,
    outputSymbol: row.output_symbol,
    errorMessage: row.error_message,
  };
}

export function logExecution(input: {
  triggerId: string;
  accountId: string;
  success: boolean;
  txHash?: string | null;
  gasUsed?: string | null;
  amountIn?: number | null;
  amountOut?: number | null;
  outputSymbol?: string | null;
  errorMessage?: string | null;
}): void {
  ensureSchema();
  const db = getDb();
  const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO trigger_executions
       (execution_id, trigger_id, account_id, fired_at, success, tx_hash, gas_used, amount_in, amount_out, output_symbol, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    executionId,
    input.triggerId,
    input.accountId,
    new Date().toISOString(),
    input.success ? 1 : 0,
    input.txHash ?? null,
    input.gasUsed ?? null,
    input.amountIn ?? null,
    input.amountOut ?? null,
    input.outputSymbol ?? null,
    input.errorMessage ?? null
  );
}

/** Ownership-checked: only returns executions for a trigger belonging to this account. */
export function listExecutions(accountId: string, triggerId: string): TriggerExecution[] {
  ensureSchema();
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM trigger_executions WHERE trigger_id = ? AND account_id = ? ORDER BY fired_at DESC LIMIT 50`)
    .all(triggerId, accountId) as ExecutionRow[];
  return rows.map(rowToExecution);
}
