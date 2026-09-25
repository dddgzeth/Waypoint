/**
 * Account store: SQLite (better-sqlite3), mirroring the pattern proven out in
 * Synapse's lib/memory/store.ts. An account's real identity is its email —
 * created and authenticated by email+password (see hashPassword/verifyPassword
 * below), same scrypt scheme as Synapse. Wallets are linked to an account
 * afterward, each verified by a SIWE signature, never a private key. This
 * matters for isolation: without an email anchor, a SIWE login for ANY unknown
 * wallet used to silently create and authenticate into a brand-new account —
 * so any key could hijack a browser's session with no identity check at all.
 * Now account creation only happens through email registration; SIWE only
 * ever authenticates a wallet that's already been linked to one.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = process.env.WAYPOINT_DATA_DIR ?? path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "waypoint.db"));

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS linked_wallets (
      address TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(account_id),
      linked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_linked_wallets_account ON linked_wallets(account_id);

    CREATE TABLE IF NOT EXISTS siwe_nonces (
      nonce TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);

  // linked_wallets predates per-wallet custom naming — add the column rather
  // than drop/recreate, since (unlike execution_wallets) this table carries
  // real account-identity data (SIWE-verified address <-> account links) that
  // isn't safe to throw away.
  const linkedCols = db.prepare(`PRAGMA table_info(linked_wallets)`).all() as Array<{ name: string }>;
  if (!linkedCols.some((c) => c.name === "label")) {
    db.exec(`ALTER TABLE linked_wallets ADD COLUMN label TEXT`);
  }

  // accounts predates email/password login — same reasoning as above, add
  // rather than recreate. Both columns are nullable at the schema level
  // (pre-existing wallet-only accounts have neither) but every account
  // created going forward always gets both, via createEmailAccount.
  const accountCols = db.prepare(`PRAGMA table_info(accounts)`).all() as Array<{ name: string }>;
  if (!accountCols.some((c) => c.name === "email")) {
    db.exec(`ALTER TABLE accounts ADD COLUMN email TEXT`);
    db.exec(`ALTER TABLE accounts ADD COLUMN password_hash TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email) WHERE email IS NOT NULL`);
  }
  if (!accountCols.some((c) => c.name === "google_sub")) {
    db.exec(`ALTER TABLE accounts ADD COLUMN google_sub TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_google_sub ON accounts(google_sub) WHERE google_sub IS NOT NULL`);
  }

  _db = db;
  return _db;
}

export interface Account {
  accountId: string;
  createdAt: string;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function createAccount(): Account {
  const db = getDb();
  const accountId = `acct_${crypto.randomBytes(12).toString("hex")}`;
  const createdAt = new Date().toISOString();
  db.prepare("INSERT INTO accounts (account_id, created_at) VALUES (?, ?)").run(accountId, createdAt);
  return { accountId, createdAt };
}

// ── Email identity: scrypt password hashing, same scheme as Synapse's
// lib/memory/store.ts (salted, timing-safe compare). ──

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface EmailAccount extends Account {
  email: string;
  passwordHash: string;
}

/** Throws if the email is already registered — callers (auth.ts) check getAccountByEmail first to give a clean error instead. */
export function createEmailAccount(email: string, password: string): EmailAccount {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const account = createAccount();
  const passwordHash = hashPassword(password);
  db.prepare("UPDATE accounts SET email = ?, password_hash = ? WHERE account_id = ?").run(
    normalized,
    passwordHash,
    account.accountId
  );
  return { ...account, email: normalized, passwordHash };
}

export function getAccountByEmail(email: string): EmailAccount | null {
  const db = getDb();
  const row = db.prepare("SELECT account_id, created_at, email, password_hash FROM accounts WHERE email = ?").get(
    normalizeEmail(email)
  ) as { account_id: string; created_at: string; email: string; password_hash: string } | undefined;
  if (!row) return null;
  return { accountId: row.account_id, createdAt: row.created_at, email: row.email, passwordHash: row.password_hash };
}

/**
 * Google sign-in: the ID token's signature is already verified by the caller
 * (auth.ts, via google-auth-library) before this runs, so a real Google
 * account backs this email — safe to auto-create, unlike an anonymous wallet
 * signature. Matches by google_sub first (Google's stable per-user id), then
 * falls back to email (covers a pre-existing email/password account signing
 * in with Google for the first time — same account, not a duplicate).
 */
export function findOrCreateGoogleAccount(email: string, googleSub: string): Account {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const bySub = db.prepare("SELECT account_id, created_at FROM accounts WHERE google_sub = ?").get(googleSub) as
    | { account_id: string; created_at: string }
    | undefined;
  if (bySub) return { accountId: bySub.account_id, createdAt: bySub.created_at };

  const byEmail = getAccountByEmail(normalized);
  if (byEmail) {
    db.prepare("UPDATE accounts SET google_sub = ? WHERE account_id = ?").run(googleSub, byEmail.accountId);
    return { accountId: byEmail.accountId, createdAt: byEmail.createdAt };
  }

  const account = createAccount();
  db.prepare("UPDATE accounts SET email = ?, google_sub = ? WHERE account_id = ?").run(
    normalized,
    googleSub,
    account.accountId
  );
  return account;
}

/** Just the email (null for the rare pre-email-era account with none) — for display, e.g. "Signed in as x@y.com". */
export function getAccountEmail(accountId: string): string | null {
  const db = getDb();
  const row = db.prepare("SELECT email FROM accounts WHERE account_id = ?").get(accountId) as
    | { email: string | null }
    | undefined;
  return row?.email ?? null;
}

export function getAccountByWallet(address: string): Account | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT a.account_id, a.created_at FROM accounts a
       JOIN linked_wallets w ON w.account_id = a.account_id
       WHERE w.address = ?`
    )
    .get(normalizeAddress(address)) as { account_id: string; created_at: string } | undefined;
  if (!row) return null;
  return { accountId: row.account_id, createdAt: row.created_at };
}

/**
 * Links a wallet address to an account. Idempotent — re-linking the same
 * address to the same account is a no-op. Reaching this function requires a
 * fresh, just-verified SIWE signature (see auth.ts) — that signature already
 * proves current control of the wallet's private key, so if the address was
 * previously linked to a DIFFERENT account, this re-parents it to the
 * account that just proved ownership rather than refusing. What account a
 * wallet was linked to in the past (e.g. an old/abandoned account) isn't a
 * reason to block a real, freshly-signed request to link it now.
 */
export function linkWallet(accountId: string, address: string): void {
  const db = getDb();
  const normalized = normalizeAddress(address);
  const existing = getAccountByWallet(normalized);
  if (existing?.accountId === accountId) return;
  if (existing) {
    db.prepare("UPDATE linked_wallets SET account_id = ?, linked_at = ? WHERE address = ?").run(
      accountId,
      new Date().toISOString(),
      normalized
    );
    return;
  }
  db.prepare("INSERT INTO linked_wallets (address, account_id, linked_at) VALUES (?, ?, ?)").run(
    normalized,
    accountId,
    new Date().toISOString()
  );
}

export function listWalletsForAccount(accountId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT address FROM linked_wallets WHERE account_id = ? ORDER BY linked_at ASC")
    .all(accountId) as Array<{ address: string }>;
  return rows.map((r) => r.address);
}

export interface LinkedWallet {
  address: string;
  label: string;
  linkedAt: string;
}

/** Same wallets as listWalletsForAccount, with a display label — falls back to a short address when never renamed. */
export function listLinkedWalletsWithLabels(accountId: string): LinkedWallet[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT address, label, linked_at FROM linked_wallets WHERE account_id = ? ORDER BY linked_at ASC")
    .all(accountId) as Array<{ address: string; label: string | null; linked_at: string }>;
  return rows.map((r) => ({
    address: r.address,
    label: r.label ?? `${r.address.slice(0, 6)}…${r.address.slice(-4)}`,
    linkedAt: r.linked_at,
  }));
}

/** Returns false (not a throw) when the address isn't linked to this account — callers turn that into a 404. */
export function renameLinkedWallet(accountId: string, address: string, label: string): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE linked_wallets SET label = ? WHERE account_id = ? AND address = ?")
    .run(label, accountId, normalizeAddress(address));
  return result.changes > 0;
}

// ── SIWE nonces: one-time-use, short-lived ──

const NONCE_TTL_MS = 5 * 60 * 1000;

export function issueNonce(): string {
  const db = getDb();
  const nonce = crypto.randomBytes(16).toString("hex");
  db.prepare("INSERT INTO siwe_nonces (nonce, created_at) VALUES (?, ?)").run(nonce, Date.now());
  return nonce;
}

/** Consumes a nonce (single use). Returns false if unknown, already used, or expired. */
export function consumeNonce(nonce: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT created_at FROM siwe_nonces WHERE nonce = ?").get(nonce) as
    | { created_at: number }
    | undefined;
  if (!row) return false;
  db.prepare("DELETE FROM siwe_nonces WHERE nonce = ?").run(nonce);
  return Date.now() - row.created_at <= NONCE_TTL_MS;
}
