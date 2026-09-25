/**
 * Delegation store: persists signed EIP-7702 authorizations + caveat-scoped
 * MetaMask delegations per (account, wallet, chain). One row = one wallet's
 * delegated execution grant on one chain, revocable independently per chain.
 */
import { getDb } from "../accounts/store.js";

let initialized = false;
function ensureSchema(): void {
  if (initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_delegations (
      account_id TEXT NOT NULL,
      address TEXT NOT NULL,
      chain TEXT NOT NULL,
      delegation_json TEXT NOT NULL,
      authorization_json TEXT NOT NULL,
      relayer_address TEXT NOT NULL,
      max_native_wei TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY (address, chain)
    );
  `);
  initialized = true;
}

export interface WalletDelegation {
  accountId: string;
  address: string;
  chain: string;
  delegation: unknown;
  authorization: unknown;
  relayerAddress: string;
  maxNativeWei: string;
  expiresAt: number;
  createdAt: string;
  revokedAt: string | null;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function rowToDelegation(row: {
  account_id: string;
  address: string;
  chain: string;
  delegation_json: string;
  authorization_json: string;
  relayer_address: string;
  max_native_wei: string;
  expires_at: number;
  created_at: string;
  revoked_at: string | null;
}): WalletDelegation {
  return {
    accountId: row.account_id,
    address: row.address,
    chain: row.chain,
    delegation: JSON.parse(row.delegation_json),
    authorization: JSON.parse(row.authorization_json),
    relayerAddress: row.relayer_address,
    maxNativeWei: row.max_native_wei,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function saveDelegation(input: {
  accountId: string;
  address: string;
  chain: string;
  delegation: unknown;
  authorization: unknown;
  relayerAddress: string;
  maxNativeWei: bigint;
  expiresAt: number;
}): void {
  ensureSchema();
  const db = getDb();
  db.prepare(
    `INSERT INTO wallet_delegations
       (account_id, address, chain, delegation_json, authorization_json, relayer_address, max_native_wei, expires_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(address, chain) DO UPDATE SET
       account_id = excluded.account_id,
       delegation_json = excluded.delegation_json,
       authorization_json = excluded.authorization_json,
       relayer_address = excluded.relayer_address,
       max_native_wei = excluded.max_native_wei,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at,
       revoked_at = NULL`
  ).run(
    input.accountId,
    normalizeAddress(input.address),
    input.chain,
    JSON.stringify(input.delegation),
    JSON.stringify(input.authorization),
    normalizeAddress(input.relayerAddress),
    input.maxNativeWei.toString(),
    input.expiresAt,
    new Date().toISOString()
  );
}

/** Returns the active (not revoked, not expired) delegation for a wallet on a chain, or null. */
export function getActiveDelegation(address: string, chain: string): WalletDelegation | null {
  ensureSchema();
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM wallet_delegations WHERE address = ? AND chain = ? AND revoked_at IS NULL`)
    .get(normalizeAddress(address), chain) as Parameters<typeof rowToDelegation>[0] | undefined;
  if (!row) return null;
  const delegation = rowToDelegation(row);
  if (delegation.expiresAt * 1000 < Date.now()) return null;
  return delegation;
}

export function listDelegationsForAccount(accountId: string): WalletDelegation[] {
  ensureSchema();
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM wallet_delegations WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`)
    .all(accountId) as Array<Parameters<typeof rowToDelegation>[0]>;
  return rows.map(rowToDelegation);
}

export function revokeDelegation(address: string, chain: string): void {
  ensureSchema();
  const db = getDb();
  db.prepare(`UPDATE wallet_delegations SET revoked_at = ? WHERE address = ? AND chain = ?`).run(
    new Date().toISOString(),
    normalizeAddress(address),
    chain
  );
}
