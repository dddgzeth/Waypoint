/**
 * Execution wallet store: an account can hold multiple Privy-backed
 * execution wallets (created or imported through privy.ts). Each is
 * independent: fund it, execute against it, no fixed "the" execution wallet.
 */
import { getDb } from "../accounts/store.js";

let initialized = false;
function ensureSchema(): void {
  if (initialized) return;
  const db = getDb();
  // Earlier schema had account_id as PRIMARY KEY (one wallet per account) —
  // dev-only data, safe to reset for the one-per-account -> many-per-account change.
  const cols = db.prepare(`PRAGMA table_info(execution_wallets)`).all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "label")) {
    db.exec(`DROP TABLE execution_wallets`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_wallets (
      wallet_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      address TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_wallets_account ON execution_wallets(account_id, created_at ASC);
  `);
  initialized = true;
}

export interface ExecutionWallet {
  accountId: string;
  walletId: string;
  address: string;
  label: string;
  createdAt: string;
}

function rowToWallet(row: { account_id: string; wallet_id: string; address: string; label: string; created_at: string }): ExecutionWallet {
  return { accountId: row.account_id, walletId: row.wallet_id, address: row.address, label: row.label, createdAt: row.created_at };
}

export function saveExecutionWallet(accountId: string, walletId: string, address: string, label: string): void {
  ensureSchema();
  const db = getDb();
  db.prepare(
    `INSERT INTO execution_wallets (wallet_id, account_id, address, label, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(walletId, accountId, address.toLowerCase(), label, new Date().toISOString());
}

export function listExecutionWallets(accountId: string): ExecutionWallet[] {
  ensureSchema();
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM execution_wallets WHERE account_id = ? ORDER BY created_at ASC`)
    .all(accountId) as Array<Parameters<typeof rowToWallet>[0]>;
  return rows.map(rowToWallet);
}

/** Returns false (not a throw) when the wallet doesn't belong to this account — callers turn that into a 404. */
export function renameExecutionWallet(accountId: string, walletId: string, label: string): boolean {
  ensureSchema();
  const db = getDb();
  const result = db
    .prepare(`UPDATE execution_wallets SET label = ? WHERE account_id = ? AND wallet_id = ?`)
    .run(label, accountId, walletId);
  return result.changes > 0;
}

export function getExecutionWalletById(accountId: string, walletId: string): ExecutionWallet | null {
  ensureSchema();
  const db = getDb();
  const row = db.prepare(`SELECT * FROM execution_wallets WHERE account_id = ? AND wallet_id = ?`).get(accountId, walletId) as
    | Parameters<typeof rowToWallet>[0]
    | undefined;
  return row ? rowToWallet(row) : null;
}
