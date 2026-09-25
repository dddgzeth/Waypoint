/**
 * SIWE (Sign-In With Ethereum) auth: login, multi-wallet linking, session
 * middleware. Three separate concerns kept separate on purpose:
 *   (a) login — a wallet signs a challenge to establish a session
 *   (b) wallet linking — an already-authenticated session's owner signs a
 *       SECOND, differently-worded message to prove they also control another
 *       address, which gets added to the same account (never a new one)
 *   (c) transaction signing authority — handled entirely separately, in the
 *       EIP-7702/ZeroDev delegation layer. This module only ever sees
 *       signatures over plain text messages, never anything that moves funds.
 */
import type { Request, Response, NextFunction } from "express";
import { SiweMessage } from "siwe";
import jwt from "jsonwebtoken";
import {
  getAccountByWallet,
  issueNonce,
  consumeNonce,
  linkWallet,
  createEmailAccount,
  getAccountByEmail,
  verifyPassword,
  findOrCreateGoogleAccount,
} from "./store.js";

const SESSION_COOKIE = "waypoint_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function jwtSecret(): string {
  const secret = process.env.SESSION_JWT_SECRET;
  if (!secret) throw new Error("SESSION_JWT_SECRET environment variable not set");
  return secret;
}

function expectedDomain(req: Request): string {
  // Configurable allowlist for production; falls back to whatever Host the
  // request actually came in on (fine for local dev, not for prod — set
  // SIWE_DOMAIN explicitly when deploying).
  return process.env.SIWE_DOMAIN ?? req.hostname;
}

export interface SessionPayload {
  accountId: string;
}

function issueSessionCookie(res: Response, accountId: string): void {
  const token = jwt.sign({ accountId } satisfies SessionPayload, jwtSecret(), {
    expiresIn: SESSION_TTL_SECONDS,
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

/** Express middleware: requires a valid session, attaches req.accountId. 401s otherwise. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  try {
    const payload = jwt.verify(token, jwtSecret()) as SessionPayload;
    (req as Request & { accountId: string }).accountId = payload.accountId;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

/** GET /auth/nonce — issues a one-time, short-lived nonce for the client to embed in a SIWE message. */
export function handleNonce(_req: Request, res: Response): void {
  res.json({ nonce: issueNonce() });
}

/** GET /auth/config — public, non-secret frontend config. googleClientId is null (hides the button) until GOOGLE_CLIENT_ID is set. */
export function handleAuthConfig(_req: Request, res: Response): void {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
}

/**
 * POST /auth/google — body: { accessToken }, from Google Identity Services'
 * OAuth2 token client (google.accounts.oauth2.initTokenClient), used behind a
 * custom-styled button instead of Google's own pre-built widget — GIS's
 * built-in button can't be restyled to match Waypoint's own dark UI (its
 * brand rules force the "G" logo onto a light square no matter the theme).
 * The access token is verified simply by USING it: it's handed to Google's
 * own userinfo endpoint, which only returns real account data for a token
 * Google itself just issued — same trust boundary as verifying an ID token's
 * signature, just via a live call instead of local JWT verification.
 */
export async function handleGoogleLogin(req: Request, res: Response): Promise<void> {
  const { accessToken } = req.body as { accessToken?: string };
  if (!accessToken) {
    res.status(400).json({ error: "accessToken is required" });
    return;
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    res.status(501).json({ error: "Google sign-in isn't configured on this server" });
    return;
  }

  let userinfo: { email?: string; email_verified?: boolean; sub?: string };
  try {
    const resp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      res.status(401).json({ error: `Google rejected this token: ${resp.status}` });
      return;
    }
    userinfo = await resp.json();
  } catch (err) {
    res.status(502).json({ error: `Could not reach Google: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  if (!userinfo.email || !userinfo.email_verified || !userinfo.sub) {
    res.status(401).json({ error: "Google account has no verified email" });
    return;
  }
  const payload = userinfo as { email: string; sub: string };

  const account = findOrCreateGoogleAccount(payload.email, payload.sub);
  issueSessionCookie(res, account.accountId);
  res.json({ accountId: account.accountId, email: payload.email });
}

/** POST /auth/check-email — body: { email }. No account leakage beyond the boolean itself. */
export function handleCheckEmail(req: Request, res: Response): void {
  const { email } = req.body as { email?: string };
  if (!email) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  res.json({ exists: getAccountByEmail(email) !== null });
}

/** POST /auth/register — body: { email, password }. Creates the account (the only way one now gets created) and signs it in. */
export function handleRegisterEmail(req: Request, res: Response): void {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  if (getAccountByEmail(email)) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }
  const account = createEmailAccount(email, password);
  issueSessionCookie(res, account.accountId);
  res.json({ accountId: account.accountId, email: account.email });
}

/** POST /auth/login-email — body: { email, password }. */
export function handleLoginEmail(req: Request, res: Response): void {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  const account = getAccountByEmail(email);
  if (!account || !verifyPassword(password, account.passwordHash)) {
    res.status(401).json({ error: "Incorrect email or password" });
    return;
  }
  issueSessionCookie(res, account.accountId);
  res.json({ accountId: account.accountId, email: account.email });
}

/**
 * POST /auth/login — body: { message, signature }. Verifies a real SIWE
 * signature (not just a format check), then signs in to whichever account
 * that address is ALREADY linked to. Does not create a new account for an
 * unknown wallet — account identity comes from email now (see store.ts);
 * an unrecognized wallet must be linked from an authenticated session
 * (POST /auth/link-wallet) instead of being able to spin up and sign into a
 * fresh, unowned account on its own.
 */
export async function handleLogin(req: Request, res: Response): Promise<void> {
  const { message, signature } = req.body as { message?: string; signature?: string };
  if (!message || !signature) {
    res.status(400).json({ error: "message and signature are required" });
    return;
  }

  let siweMessage: SiweMessage;
  try {
    siweMessage = new SiweMessage(message);
  } catch {
    res.status(400).json({ error: "Malformed SIWE message" });
    return;
  }

  if (!consumeNonce(siweMessage.nonce)) {
    res.status(400).json({ error: "Unknown, already-used, or expired nonce" });
    return;
  }

  const result = await siweMessage.verify(
    { signature, domain: expectedDomain(req) },
    { suppressExceptions: true }
  );
  if (!result.success) {
    res.status(401).json({ error: `SIWE verification failed: ${result.error?.type ?? "unknown"}` });
    return;
  }

  const address = result.data.address;
  const account = getAccountByWallet(address);
  if (!account) {
    res.status(404).json({
      error: "This wallet isn't linked to any account yet. Sign in with your email first, then link this wallet from the Wallet tab.",
    });
    return;
  }

  issueSessionCookie(res, account.accountId);
  res.json({ accountId: account.accountId, address });
}

/**
 * POST /auth/link-wallet — requires an existing session (requireAuth).
 * Body: { message, signature }, where `message` is a SIWE message whose
 * `statement` must explicitly reference linking to the CALLER'S account id
 * (checked below) — this is what distinguishes "link" from "login" even
 * though both are just a signed SIWE message under the hood.
 */
export async function handleLinkWallet(req: Request, res: Response): Promise<void> {
  const accountId = (req as Request & { accountId: string }).accountId;
  const { message, signature } = req.body as { message?: string; signature?: string };
  if (!message || !signature) {
    res.status(400).json({ error: "message and signature are required" });
    return;
  }

  let siweMessage: SiweMessage;
  try {
    siweMessage = new SiweMessage(message);
  } catch {
    res.status(400).json({ error: "Malformed SIWE message" });
    return;
  }

  if (!siweMessage.statement?.includes(accountId)) {
    res.status(400).json({
      error: `Message statement must explicitly reference the linking account (${accountId}) to prevent replaying an unrelated login message as a link`,
    });
    return;
  }

  if (!consumeNonce(siweMessage.nonce)) {
    res.status(400).json({ error: "Unknown, already-used, or expired nonce" });
    return;
  }

  const result = await siweMessage.verify(
    { signature, domain: expectedDomain(req) },
    { suppressExceptions: true }
  );
  if (!result.success) {
    res.status(401).json({ error: `SIWE verification failed: ${result.error?.type ?? "unknown"}` });
    return;
  }

  try {
    linkWallet(accountId, result.data.address);
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.json({ accountId, linkedAddress: result.data.address });
}

export function handleLogout(_req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
}
