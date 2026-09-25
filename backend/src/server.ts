/**
 * Express entry point: the /plan endpoint runs state reading -> goal parsing
 * -> planning end to end.
 *
 * Start with: npm run dev
 */
import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { parseGoal } from "./goalParser.js";
import { buildPlan, PlanValidationError } from "./planner.js";
import { getMockWalletState, getWalletState } from "./stateReader.js";
import { getUsdValue } from "./adapters/priceUsd.js";
import { prettyPlan } from "./models.js";
import type { WalletListEntry, WalletStateSnapshot } from "./models.js";
import crypto from "node:crypto";
import type { Account } from "viem";
import {
  handleNonce,
  handleLogin,
  handleLinkWallet,
  handleLogout,
  handleCheckEmail,
  handleRegisterEmail,
  handleLoginEmail,
  handleAuthConfig,
  handleGoogleLogin,
  requireAuth,
} from "./accounts/auth.js";
import { listWalletsForAccount, listLinkedWalletsWithLabels, renameLinkedWallet, getAccountEmail } from "./accounts/store.js";
import { appendTurn, findAutomationDraftSession, getSessionHistory, listSessionsForAccount, deleteSession } from "./memory/store.js";
import { runChatTurn, type AutomationDraft, type ChatTurnResult } from "./chat.js";
import { publicErrorMessage } from "./errors.js";
import { runPlan } from "./orchestrator.js";
import { buildClientStep, confirmClientStep, waitForClientTx, type ClientStepBuild } from "./execClient.js";
import {
  createExecutionWallet,
  executionWalletAddressFromPrivateKey,
  exportExecutionWalletPrivateKey,
  getExecutionAccount,
  importExecutionWallet,
} from "./wallets/privy.js";
import { listExecutionWallets, getExecutionWalletById, saveExecutionWallet, renameExecutionWallet } from "./wallets/store.js";
import type { ExecutionPlan } from "./models.js";
import { getHealthFactor } from "./adapters/aaveHealthFactor.js";
import { getAssetDebt, getAaveUserAssetPositions } from "./adapters/aaveYield.js";
import { createTrigger, deleteTrigger, listTriggersForAccount, setActive, setChatSession, listExecutions } from "./triggers/store.js";
import type { TriggerConfig } from "./triggers/types.js";
import { evaluateCompletion } from "./triggers/completion.js";
import { runTriggerAttempt, startMonitorLoop } from "./triggers/monitor.js";
import { trust as trustCustomCall, listAllowed as listTrustedCustomCalls, revoke as revokeCustomCall } from "./customCall/allowlist.js";
import { CHAINS, CHAIN_KEYS, chainsWithAave } from "./chains/index.js";

const app = express();
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? true,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get("/auth/config", handleAuthConfig);
app.post("/auth/check-email", handleCheckEmail);
app.post("/auth/register", handleRegisterEmail);
app.post("/auth/login-email", handleLoginEmail);
app.post("/auth/google", handleGoogleLogin);
app.get("/auth/nonce", handleNonce);
app.post("/auth/login", handleLogin);
app.post("/auth/link-wallet", requireAuth, handleLinkWallet);
app.post("/auth/logout", handleLogout);
app.get("/auth/me", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  res.json({ accountId, email: getAccountEmail(accountId), wallets: listLinkedWalletsWithLabels(accountId) });
});

app.post("/wallet/linked/rename", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { address, label } = req.body as { address?: string; label?: string };
  if (!address || !label?.trim()) {
    res.status(400).json({ error: "address and a non-empty label are required" });
    return;
  }
  const ok = renameLinkedWallet(accountId, address, label.trim());
  if (!ok) {
    res.status(404).json({ error: `${address} is not linked to this account` });
    return;
  }
  res.json({ ok: true });
});

app.post("/plan", async (req, res) => {
  const { goalText, walletAddress } = req.body as {
    goalText?: string;
    walletAddress?: string;
  };
  if (!goalText) {
    res.status(400).json({ error: "goalText is required" });
    return;
  }

  try {
    const state = walletAddress ? await getWalletState(walletAddress) : getMockWalletState();
    const snapshot: WalletStateSnapshot = { ...state, label: "Selected wallet", kind: "execution" };
    const goal = await parseGoal(goalText, [snapshot]);
    const plan = await buildPlan(goal, [snapshot]);
    res.json({ plan, pretty: prettyPlan(plan) });
  } catch (err) {
    if (err instanceof PlanValidationError) {
      res.status(422).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * A goal can be planned against either a linked wallet (the user's own,
 * read-only for planning purposes) or one of the account's execution
 * wallets (its own real multi-chain balance, since it can also be the one
 * that ends up executing the plan) — both are real addresses this account
 * controls, just with different signing paths downstream. Shared by /chat
 * and /chat/stream. Returns null (having already written the error
 * response) when there's no valid wallet to use.
 */
function resolveChatWallet(res: express.Response, accountId: string, walletAddress?: string): string | null {
  const linkedWallets = listWalletsForAccount(accountId);
  const executionWalletAddresses = listExecutionWallets(accountId).map((w) => w.address.toLowerCase());
  const allWallets = [...linkedWallets, ...executionWalletAddresses];
  if (allWallets.length === 0) {
    res.status(400).json({ error: "No wallet linked to this account yet" });
    return null;
  }
  const chosenWallet = walletAddress?.toLowerCase() ?? allWallets[0];
  if (!allWallets.includes(chosenWallet)) {
    res.status(400).json({ error: `Wallet ${chosenWallet} is not linked to this account` });
    return null;
  }
  return chosenWallet;
}

/** This account's known wallets (label -> address), for chat to resolve label references without a chain read. */
function getAccountWalletList(accountId: string): WalletListEntry[] {
  return [
    ...listLinkedWalletsWithLabels(accountId).map((w) => ({ label: w.label, address: w.address, kind: "linked" as const })),
    ...listExecutionWallets(accountId).map((w) => ({ label: w.label, address: w.address, kind: "execution" as const })),
  ];
}

async function getAccountWalletStates(accountId: string, selectedAddress: string): Promise<WalletStateSnapshot[]> {
  // Chat plans can be confirmed and executed only by Privy-backed execution
  // wallets. Keeping linked-wallet balances out of this input makes the
  // planner's universe match the executor's signing authority: a read-only
  // wallet must never become an accidental source in a supposedly executable
  // plan. Linked wallets remain in getAccountWalletList for identity/label
  // resolution elsewhere in the product.
  const wallets = getAccountWalletList(accountId).filter((wallet) => wallet.kind === "execution");
  // A full wallet state is already chain-by-chain paced. Keep execution
  // wallets sequential as well, otherwise three wallets burst the same
  // Alchemy endpoint with simultaneous native-balance reads.
  const states: WalletStateSnapshot[] = [];
  for (const wallet of wallets) {
    states.push({ ...(await getWalletState(wallet.address, { includePositions: true })), label: wallet.label, kind: wallet.kind });
  }
  return states.sort((a, b) => Number(b.address.toLowerCase() === selectedAddress) - Number(a.address.toLowerCase() === selectedAddress));
}

/**
 * Stores the assistant's turn for both /chat and /chat/stream — a plain-text
 * summary (unchanged, what's shown if metadata is ever missing/unparseable)
 * PLUS, for a plan-kind result, the structured goal/plan/highRiskSteps behind
 * it as metadata. Without this, a restored past session (GET
 * /chat/sessions/:id) had nothing to reconstruct the rich goal table / plan
 * step cards from and fell back to a wall of plain escaped text — a real gap
 * the live SSE-streamed turn never had, now fixed by giving history the same
 * structured data the live turn already produces.
 */
function appendAssistantTurn(accountId: string, sessionId: string, result: ChatTurnResult): void {
  const assistantText =
    result.kind === "question"
      ? result.message
      : result.kind === "plan"
        ? `${result.message}\n\n${prettyPlan(result.plan)}`
        : result.kind === "automation_draft"
          ? `${result.message}\n\n${result.automation.title}: ${result.automation.summary}`
        : `${result.message}\n\n(planning failed: ${result.error})`;
  const metadata =
    result.kind === "plan"
      ? { kind: "plan" as const, goal: result.goal, plan: result.plan, highRiskSteps: result.highRiskSteps }
      : result.kind === "automation_draft"
        ? { kind: "automation_draft" as const, automation: result.automation }
        : undefined;
  appendTurn(accountId, sessionId, "assistant", assistantText, metadata);
}

/**
 * POST /chat — the real multi-turn agent loop. Requires auth (a session ties a
 * conversation's L0 history and wallet choice to one account). Each turn either
 * comes back as a clarifying question, or a real plan built by the unchanged
 * goalParser -> planner pipeline once there's enough to act on.
 */
app.post("/chat", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { message, sessionId: bodySessionId, walletAddress } = req.body as {
    message?: string;
    sessionId?: string;
    walletAddress?: string;
  };
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const chosenWallet = resolveChatWallet(res, accountId, walletAddress);
  if (!chosenWallet) return;

  const sessionId = bodySessionId ?? crypto.randomBytes(8).toString("hex");

  try {
    const history = getSessionHistory(accountId, sessionId);
    appendTurn(accountId, sessionId, "user", message);

    const wallets = getAccountWalletList(accountId);
    const result = await runChatTurn(accountId, history, message, () => getAccountWalletStates(accountId, chosenWallet), wallets);

    appendAssistantTurn(accountId, sessionId, result);

    res.json({ sessionId, walletAddress: chosenWallet, ...result });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  }
});

/**
 * POST /chat/stream — same turn as /chat, but as a live event stream instead
 * of one blocking response: "reading_balances" (real balances, right after
 * the state read) -> "goal_parsed" (the real structured Goal) -> the final
 * question/plan/plan_failed event. Lets the UI show each real stage as it
 * happens, matching the actual pipeline's real steps instead of only
 * revealing the end result.
 */
app.post("/chat/stream", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { message, sessionId: bodySessionId, walletAddress } = req.body as {
    message?: string;
    sessionId?: string;
    walletAddress?: string;
  };
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const chosenWallet = resolveChatWallet(res, accountId, walletAddress);
  if (!chosenWallet) return;

  const sessionId = bodySessionId ?? crypto.randomBytes(8).toString("hex");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const history = getSessionHistory(accountId, sessionId);
    appendTurn(accountId, sessionId, "user", message);

    const wallets = getAccountWalletList(accountId);
    const result = await runChatTurn(
      accountId,
      history,
      message,
      () => getAccountWalletStates(accountId, chosenWallet),
      wallets,
      undefined,
      (goal) => send({ type: "goal_parsed", goal }),
      async (states) => {
        const balances = await Promise.all(
          states.map(async (state) => ({
            wallet: { label: state.label, address: state.address, kind: state.kind },
            balances: await mapWithConcurrency(state.balances, 8, async (b) => ({
              ...b,
              usdValue: await getUsdValue(b.token, b.amount, { chainKey: b.chain, tokenAddress: b.tokenAddress }).catch(() => 0),
            })),
          }))
        );
        send({ type: "reading_balances", wallets: balances });
      },
      (stage) => send({ type: "stage", stage })
    );

    appendAssistantTurn(accountId, sessionId, result);

    send({ type: "result", sessionId, walletAddress: chosenWallet, ...result });
  } catch (err) {
    send({ type: "error", error: publicErrorMessage(err) });
  }
  res.end();
});

/** GET /chat/sessions — this account's past conversations, newest first, for a chat-history sidebar. */
app.get("/chat/sessions", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  res.json({ sessions: listSessionsForAccount(accountId) });
});

/** GET /chat/sessions/:sessionId — full turn history for one past session, to reload it into the chat view. */
app.get("/chat/sessions/:sessionId", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  reconcileUnlinkedAutomationResults(accountId, req.params.sessionId);
  res.json({ history: getSessionHistory(accountId, req.params.sessionId) });
});

app.delete("/chat/sessions/:sessionId", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const deleted = deleteSession(accountId, req.params.sessionId);
  res.json({ ok: true, deleted });
});

/**
 * A real wallet's discovered token list regularly runs into the dozens (see
 * stateReader.ts) — with no batch pricing endpoint on this CMC plan, that's
 * one request per token. Firing all of them via a plain Promise.all sends a
 * burst well past CMC's 50 req/min limit, and the resulting 429s get
 * silently treated the same as "not listed" — verified for real: a
 * legitimately-priced token showed $0 purely because a different token's
 * request in the same burst got rate-limited. Capping how many are in
 * flight at once keeps a real multi-token portfolio load under that limit.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * GET /wallet/portfolio?address=0x... — real per-chain balances for any
 * address (linked wallet or execution wallet), with USD values. Balances are
 * public on-chain data, so no ownership check beyond requiring a session.
 */
app.get("/wallet/portfolio", requireAuth, async (req, res) => {
  const address = req.query.address as string | undefined;
  if (!address) {
    res.status(400).json({ error: "address query param is required" });
    return;
  }
  try {
    const state = await getWalletState(address);
    const balances = await mapWithConcurrency(state.balances, 8, async (b) => ({
      ...b,
      usdValue: await getUsdValue(b.token, b.amount, { chainKey: b.chain, tokenAddress: b.tokenAddress }).catch(() => 0),
    }));
    const totalUsd = balances.reduce((sum, b) => sum + b.usdValue, 0);
    res.json({ address: state.address, balances, totalUsd });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /wallet/defi-positions?address=0x... — protocol-native positions that
 * do not belong in the ordinary ERC-20 balance table. Aave reserves and the
 * user's aToken/debt-token balances are read from live contracts, so this
 * remains complete even when an indexer does not return a receipt token.
 */
app.get("/wallet/defi-positions", requireAuth, async (req, res) => {
  const address = req.query.address as string | undefined;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: "a valid address query param is required" });
    return;
  }
  try {
    const marketReads = await Promise.all(chainsWithAave().map(async (chain) => {
      const assets = await getAaveUserAssetPositions(chain.key, address as `0x${string}`);
      if (!assets.length) return null;
      const [account, valuedAssets] = await Promise.all([
        getHealthFactor(chain.key, address as `0x${string}`),
        Promise.all(assets.map(async (asset) => {
          const priceUsd = await getUsdValue(asset.symbol, 1, { chainKey: chain.key, tokenAddress: asset.assetAddress }).catch(() => null);
          return {
            ...asset,
            priceUsd,
            suppliedUsd: priceUsd === null ? null : asset.supplied * priceUsd,
            borrowedUsd: priceUsd === null ? null : asset.borrowed * priceUsd,
          };
        })),
      ]);
      const suppliedUsd = valuedAssets.reduce((sum, asset) => sum + (asset.suppliedUsd ?? 0), 0);
      const borrowedUsd = valuedAssets.reduce((sum, asset) => sum + (asset.borrowedUsd ?? 0), 0);
      return {
        protocol: "aave" as const,
        chain: chain.key,
        officialUrl: "https://app.aave.com/",
        healthFactor: Number.isFinite(account.healthFactor) ? account.healthFactor : null,
        noDebt: !Number.isFinite(account.healthFactor),
        totalCollateralUsd: account.totalCollateralBase,
        totalDebtUsd: account.totalDebtBase,
        suppliedUsd,
        borrowedUsd,
        netUsd: suppliedUsd - borrowedUsd,
        assets: valuedAssets,
      };
    }));
    const markets = marketReads.filter((market): market is NonNullable<typeof market> => market !== null) as Array<{
      protocol: "aave";
      chain: string;
      officialUrl: string;
      healthFactor: number | null;
      noDebt: boolean;
      totalCollateralUsd: number;
      totalDebtUsd: number;
      suppliedUsd: number;
      borrowedUsd: number;
      netUsd: number;
      assets: Array<Record<string, unknown>>;
    }>;
    const suppliedUsd = markets.reduce((sum, market) => sum + market.suppliedUsd, 0);
    const borrowedUsd = markets.reduce((sum, market) => sum + market.borrowedUsd, 0);
    res.json({
      address,
      markets,
      summary: { suppliedUsd, borrowedUsd, netUsd: suppliedUsd - borrowedUsd },
    });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  }
});

/**
 * GET /wallet/execution — all of the account's hands-free execution wallets
 * (Privy-backed, Authorization-Key-owned). An account can hold any number of
 * these — nothing lazily created here, use POST to create or import one. Funds must be
 * moved into one separately from a user's own wallet — this is the
 * Bankr/Banana-Gun-style path (see plan-finals.md), for automatic execution
 * without the user present, as opposed to §1's EIP-7702 delegation path
 * (which operates on a user's own existing wallet but currently has no route
 * through an ordinary browser wallet).
 */
app.get("/wallet/execution", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const wallets = listExecutionWallets(accountId).map((w) => ({
    walletId: w.walletId,
    address: w.address,
    label: w.label,
    createdAt: w.createdAt,
  }));
  res.json({ wallets });
});

/** POST /wallet/execution — creates a new execution wallet for the account. Body: { label? }. */
app.post("/wallet/execution", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { label } = req.body as { label?: string };
  try {
    const created = await createExecutionWallet();
    const finalLabel = label?.trim() || `Execution Wallet ${listExecutionWallets(accountId).length + 1}`;
    saveExecutionWallet(accountId, created.walletId, created.address, finalLabel);
    res.json({ walletId: created.walletId, address: created.address, label: finalLabel });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /wallet/execution/import — imports an existing Ethereum private key as
 * a full execution wallet. The key is used only for Privy's HPKE import and is
 * never written to Waypoint's database. Body: { privateKey, label? }.
 */
app.post("/wallet/execution/import", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { privateKey, label } = req.body as { privateKey?: unknown; label?: unknown };
  if (typeof privateKey !== "string" || !privateKey.trim()) {
    res.status(400).json({ error: "privateKey is required" });
    return;
  }
  if (label !== undefined && typeof label !== "string") {
    res.status(400).json({ error: "label must be a string" });
    return;
  }

  try {
    const trimmedKey = privateKey.trim();
    const address = executionWalletAddressFromPrivateKey(trimmedKey);
    const existing = listExecutionWallets(accountId).find((wallet) => wallet.address.toLowerCase() === address.toLowerCase());
    if (existing) {
      res.status(409).json({ error: `That wallet is already imported as ${existing.label}` });
      return;
    }

    const created = await importExecutionWallet(trimmedKey);
    const finalLabel = (label as string | undefined)?.trim() || `Execution Wallet ${listExecutionWallets(accountId).length + 1}`;
    saveExecutionWallet(accountId, created.walletId, created.address, finalLabel);
    res.json({ walletId: created.walletId, address: created.address, label: finalLabel });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === "Enter a valid 32-byte Ethereum private key" ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

app.post("/wallet/execution/:walletId/rename", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { label } = req.body as { label?: string };
  if (!label?.trim()) {
    res.status(400).json({ error: "a non-empty label is required" });
    return;
  }
  const ok = renameExecutionWallet(accountId, req.params.walletId, label.trim());
  if (!ok) {
    res.status(404).json({ error: `No execution wallet ${req.params.walletId} on this account` });
    return;
  }
  res.json({ ok: true });
});

/**
 * POST /wallet/execution/:walletId/export — self-custody escape hatch: hand
 * the raw private key to the account that owns this execution wallet. HPKE
 * end-to-end encrypted between Privy and this server (see wallets/privy.ts).
 * Never logged, never persisted here — passed straight through to the
 * authenticated response.
 */
app.post("/wallet/execution/:walletId/export", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const wallet = getExecutionWalletById(accountId, req.params.walletId);
  if (!wallet) {
    res.status(400).json({ error: `No execution wallet ${req.params.walletId} on this account` });
    return;
  }
  try {
    const privateKey = await exportExecutionWalletPrivateKey(wallet.walletId);
    res.json({ address: wallet.address, privateKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * Resolves a step's named source wallet (transferFrom) to the real signer
 * account for a plan spanning multiple of the caller's OWN execution
 * wallets — e.g. "consolidate execution wallet 1, 2, and 3, then deposit
 * into Aave" in one confirmed plan (see orchestrator.ts's runPlan doc
 * comment). Scoped to THIS accountId's own execution wallets only — never
 * resolves to another account's wallet, and a linked wallet (no backend key)
 * fails loudly here rather than silently running as the wrong signer.
 */
function makeResolveAccount(accountId: string): (address: string) => Promise<Account> {
  return async (address: string) => {
    const wallet = listExecutionWallets(accountId).find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (!wallet) {
      throw new Error(
        `${address} isn't one of this account's execution wallets — Waypoint can only sign automatically for execution wallets, not a linked wallet.`
      );
    }
    return getExecutionAccount(wallet.walletId, wallet.address as `0x${string}`);
  };
}

/**
 * POST /execute — runs a plan for real against one of the account's
 * execution wallets. Body: { plan, walletId }. Same orchestrator, same
 * safety rails (simulate-before-sign, stop-on-first-failure) as every other
 * execution path in this codebase — only the signer differs (Privy server
 * wallet instead of a local key). `walletId` is the DEFAULT signer, for any
 * step that doesn't name its own source (transferFrom) — a plan naming
 * several of this account's own execution wallets resolves each step's real
 * signer independently, see makeResolveAccount above.
 */
app.post("/execute", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { plan, walletId } = req.body as { plan?: ExecutionPlan; walletId?: string };
  if (!plan) {
    res.status(400).json({ error: "plan is required" });
    return;
  }
  if (!walletId) {
    res.status(400).json({ error: "walletId is required — pick one from GET /wallet/execution" });
    return;
  }

  const wallet = getExecutionWalletById(accountId, walletId);
  if (!wallet) {
    res.status(400).json({ error: `No execution wallet ${walletId} on this account` });
    return;
  }

  try {
    const account = getExecutionAccount(wallet.walletId, wallet.address as `0x${string}`);
    const results = await runPlan(plan, account, undefined, makeResolveAccount(accountId));
    // Confirming a plan (successfully) IS the user's explicit approval for any
    // custom_call steps in it — trust those (target, function) pairs so future
    // plans calling the same contract/method don't need to ask again.
    for (const step of plan.steps) {
      if (step.action === "custom_call" && step.customCallTarget && step.customCallFunction) {
        trustCustomCall(accountId, step.customCallTarget, step.customCallFunction);
      }
    }
    res.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /execute/stream — same as /execute, but as a live event stream: a
 * "step_start" / "step_status" / "step_tx" / "step_complete" event for each
 * real stage a step passes through (quoting, approving, simulating, sending,
 * confirming, bridging), instead of one blocking response that only reveals
 * everything once the whole plan is done. Ends with a "done" event carrying
 * the same results /execute returns.
 */
app.post("/execute/stream", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { plan, walletId } = req.body as { plan?: ExecutionPlan; walletId?: string };
  if (!plan) {
    res.status(400).json({ error: "plan is required" });
    return;
  }
  if (!walletId) {
    res.status(400).json({ error: "walletId is required — pick one from GET /wallet/execution" });
    return;
  }
  const wallet = getExecutionWalletById(accountId, walletId);
  if (!wallet) {
    res.status(400).json({ error: `No execution wallet ${walletId} on this account` });
    return;
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const account = getExecutionAccount(wallet.walletId, wallet.address as `0x${string}`);
    const results = await runPlan(plan, account, send, makeResolveAccount(accountId));
    for (const step of plan.steps) {
      if (step.action === "custom_call" && step.customCallTarget && step.customCallFunction) {
        trustCustomCall(accountId, step.customCallTarget, step.customCallFunction);
      }
    }
    send({ type: "done", results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ type: "error", error: message });
  }
  res.end();
});

/**
 * Client-signed execution — for a plan whose source is the caller's own
 * LINKED wallet (no key on this backend at all, unlike an execution wallet).
 * The backend only ever builds unsigned tx data and verifies real on-chain
 * results; the browser wallet extension does the actual signing via
 * eth_sendTransaction. Same safety rails as /execute/stream (every tx
 * simulated first, real receipt confirmation, real output measurement) —
 * see execClient.ts. Three calls per step, driven by the frontend:
 * build-step -> (client signs) -> confirm-step, with wait-tx in between for
 * an approval tx that must be mined before the main tx can be built.
 */
function isOwnedLinkedWallet(accountId: string, address: string): boolean {
  return listLinkedWalletsWithLabels(accountId).some((w) => w.address.toLowerCase() === address.toLowerCase());
}

app.post("/execute/client/build-step", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { plan, stepId, walletAddress, priorOutputs } = req.body as {
    plan?: ExecutionPlan;
    stepId?: string;
    walletAddress?: string;
    priorOutputs?: Record<string, number>;
  };
  if (!plan || !stepId || !walletAddress) {
    res.status(400).json({ error: "plan, stepId, walletAddress are required" });
    return;
  }
  if (!isOwnedLinkedWallet(accountId, walletAddress)) {
    res.status(403).json({ error: "That address isn't one of your linked wallets." });
    return;
  }
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) {
    res.status(400).json({ error: `No step ${stepId} in this plan` });
    return;
  }
  try {
    const match = /^output_of\(([^)]+)\)$/.exec(step.amountIn);
    let resolvedAmountIn: number;
    if (match) {
      const prior = priorOutputs?.[match[1]];
      if (prior === undefined) throw new Error(`Missing prior output for ${match[1]}`);
      resolvedAmountIn = prior;
    } else {
      resolvedAmountIn = Number(step.amountIn);
    }
    const built = await buildClientStep(step, resolvedAmountIn, walletAddress as `0x${string}`);
    res.json(built);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/execute/client/wait-tx", requireAuth, async (req, res) => {
  const { chainKey, txHash } = req.body as { chainKey?: string; txHash?: string };
  if (!chainKey || !txHash) {
    res.status(400).json({ error: "chainKey and txHash are required" });
    return;
  }
  try {
    const result = await waitForClientTx(chainKey, txHash as `0x${string}`);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post("/execute/client/confirm-step", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { plan, stepId, walletAddress, txHash, built } = req.body as {
    plan?: ExecutionPlan;
    stepId?: string;
    walletAddress?: string;
    txHash?: string;
    built?: ClientStepBuild;
  };
  if (!plan || !stepId || !walletAddress || !txHash || !built) {
    res.status(400).json({ error: "plan, stepId, walletAddress, txHash, built are required" });
    return;
  }
  if (!isOwnedLinkedWallet(accountId, walletAddress)) {
    res.status(403).json({ error: "That address isn't one of your linked wallets." });
    return;
  }
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) {
    res.status(400).json({ error: `No step ${stepId} in this plan` });
    return;
  }
  try {
    const result = await confirmClientStep(step, built, txHash as `0x${string}`, walletAddress as `0x${string}`);
    if (step.action === "custom_call" && step.customCallTarget && step.customCallFunction) {
      trustCustomCall(accountId, step.customCallTarget, step.customCallFunction);
    }
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** custom_call (target, function) pairs this account has trusted — either via /execute confirmation or a past explicit high-risk confirm. */
app.get("/trust", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  res.json({ trusted: listTrustedCustomCalls(accountId) });
});

app.post("/trust/revoke", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { target, functionSignature } = req.body as { target?: string; functionSignature?: string };
  if (!target || !functionSignature) {
    res.status(400).json({ error: "target and functionSignature are required" });
    return;
  }
  revokeCustomCall(accountId, target, functionSignature);
  res.json({ ok: true });
});

/**
 * Automations. Any TriggerConfig variant (see triggers/types.ts) — currently
 * "health_factor" (repay a % of debt when health factor breaches a
 * threshold) and "dca" (buy a fixed amount on a schedule). Registered once,
 * fires with no user present (the monitor loop, started below). Actions only
 * ever run from the execution wallet itself, since that's the only wallet
 * type this backend can sign for autonomously.
 */
function validateTriggerConfig(config: TriggerConfig): string | null {
  if (config.type === "health_factor") {
    if (!config.chain || !config.threshold || !config.repayAsset || !config.repayPercent) {
      return "health_factor config needs chain, threshold, repayAsset, repayPercent";
    }
  } else if (config.type === "dca") {
    if (!config.chain || !config.tokenIn || !config.tokenOut || !config.amountPerBuy) {
      return "dca config needs chain, tokenIn, tokenOut, amountPerBuy";
    }
    if (!config.intervalMinutes && !config.timeOfDayUtc) {
      return "dca config needs intervalMinutes or timeOfDayUtc";
    }
    if (config.intervalMinutes !== undefined && (!Number.isInteger(config.intervalMinutes) || config.intervalMinutes < 1)) {
      return "dca intervalMinutes must be a positive whole number";
    }
    if (config.startAfterMinutes !== undefined && (!Number.isInteger(config.startAfterMinutes) || config.startAfterMinutes < 1)) {
      return "dca startAfterMinutes must be a positive whole number";
    }
    if (config.startAfterMinutes !== undefined && config.timeOfDayUtc) {
      return "dca startAfterMinutes and timeOfDayUtc cannot both be set";
    }
    if (config.timeOfDayUtc && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.timeOfDayUtc)) {
      return "dca timeOfDayUtc must use HH:MM UTC";
    }
  } else {
    return `Unknown trigger type: ${(config as { type?: string }).type}`;
  }
  return null;
}

function latestAutomationUpdate(accountId: string, sessionId: string | undefined, triggerId: string) {
  if (!sessionId) return undefined;
  return [...getSessionHistory(accountId, sessionId)].reverse().find((turn) => {
    if (turn.role !== "assistant" || !turn.metadata) return false;
    try {
      const metadata = JSON.parse(turn.metadata) as { kind?: string; triggerId?: string };
      return metadata.kind === "automation_update" && metadata.triggerId === triggerId;
    } catch {
      return false;
    }
  });
}

/** Repair trigger records created by an older frontend that omitted sessionId
 * on confirmation. It is intentionally content-addressed to the saved draft,
 * not a "latest trigger" guess, and only attaches an unlinked trigger once. */
function reconcileUnlinkedAutomationResults(accountId: string, sessionId: string): void {
  const history = getSessionHistory(accountId, sessionId);
  const drafts = history.flatMap((turn) => {
    if (turn.role !== "assistant" || !turn.metadata) return [];
    try {
      const metadata = JSON.parse(turn.metadata) as { kind?: string; automation?: AutomationDraft };
      return metadata.kind === "automation_draft" && metadata.automation ? [{ turn, automation: metadata.automation }] : [];
    } catch {
      return [];
    }
  });
  if (!drafts.length) return;

  const existingUpdates = new Set(
    history.flatMap((turn) => {
      try {
        const metadata = turn.metadata ? JSON.parse(turn.metadata) as { kind?: string; triggerId?: string } : null;
        return metadata?.kind === "automation_update" && metadata.triggerId ? [metadata.triggerId] : [];
      } catch {
        return [];
      }
    })
  );
  for (const { turn, automation } of drafts) {
    const trigger = listTriggersForAccount(accountId).find(
      (candidate) =>
        !candidate.chatSessionId &&
        candidate.createdAt >= turn.createdAt &&
        JSON.stringify(candidate.config) === JSON.stringify(automation.config)
    );
    if (!trigger) continue;
    setChatSession(accountId, trigger.triggerId, sessionId);
    if (existingUpdates.has(trigger.triggerId)) continue;
    for (const execution of listExecutions(accountId, trigger.triggerId).reverse()) {
      const summary = execution.success
        ? `Automation update — ${trigger.triggerType === "dca" ? "DCA purchase" : "health-factor repayment"} confirmed: ${execution.amountIn ?? ""} ${execution.outputSymbol ?? ""}${execution.amountOut !== null ? ` → ${execution.amountOut}` : ""}. Transaction: ${execution.txHash ?? "(hash unavailable)"}`
        : `Automation update — ${trigger.triggerType} execution failed${execution.txHash ? ` after submitting ${execution.txHash}` : " before a transaction was submitted"}: ${execution.errorMessage ?? "unknown error"}`;
      appendTurn(accountId, sessionId, "assistant", summary, { kind: "automation_update", triggerId: trigger.triggerId });
    }
  }
}

async function registerTrigger(accountId: string, executionWalletId: string, config: TriggerConfig, chatSessionId?: string) {
  const validationError = validateTriggerConfig(config);
  if (validationError) throw new Error(validationError);
  const wallet = getExecutionWalletById(accountId, executionWalletId);
  if (!wallet) throw new Error(`No execution wallet ${executionWalletId} on this account`);
  // Confirming the same saved Chat draft twice must return the automation it
  // already created, not create a second rule and spend twice.
  if (chatSessionId) {
    const existing = listTriggersForAccount(accountId).find(
      (candidate) =>
        candidate.chatSessionId === chatSessionId &&
        candidate.executionWalletId === executionWalletId &&
        JSON.stringify(candidate.config) === JSON.stringify(config)
    );
    if (existing) {
      return {
        triggerId: existing.triggerId,
        trigger: existing,
        firstRunUpdate: latestAutomationUpdate(accountId, chatSessionId, existing.triggerId),
        alreadyExisted: true,
      };
    }
  }
  const triggerId = `trig_${crypto.randomBytes(8).toString("hex")}`;
  createTrigger({ triggerId, accountId, executionWalletId, chatSessionId, config });
  // An interval describes the cadence AFTER the first buy. Unless the user
  // explicitly scheduled a time/delay, perform that first buy immediately.
  const trigger = listTriggersForAccount(accountId).find((candidate) => candidate.triggerId === triggerId)!;
  await runTriggerAttempt(trigger);
  return {
    triggerId,
    trigger: listTriggersForAccount(accountId).find((candidate) => candidate.triggerId === triggerId),
    firstRunUpdate: latestAutomationUpdate(accountId, chatSessionId, triggerId),
  };
}

app.post("/triggers", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { executionWalletId, config } = req.body as { executionWalletId?: string; config?: TriggerConfig };
  if (!executionWalletId || !config) {
    res.status(400).json({ error: "executionWalletId and config are required" });
    return;
  }
  try {
    res.json(await registerTrigger(accountId, executionWalletId, config));
  } catch (err) {
    res.status(400).json({ error: publicErrorMessage(err) });
  }
});

/** Confirm a draft that Chat created. The address is resolved back to an
 * account-owned execution wallet here, so a linked/read-only wallet can never
 * become an autonomous signer. */
app.post("/chat/automations/confirm", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { automation, sessionId } = req.body as { automation?: AutomationDraft; sessionId?: string };
  if (!automation?.sourceWalletAddress || !automation.config) {
    res.status(400).json({ error: "automation draft is required" });
    return;
  }
  const wallet = listExecutionWallets(accountId).find(
    (candidate) => candidate.address.toLowerCase() === automation.sourceWalletAddress.toLowerCase()
  );
  if (!wallet) {
    res.status(400).json({ error: "The automation source must be one of your execution wallets" });
    return;
  }
  try {
    const chatSessionId = sessionId || findAutomationDraftSession(accountId, automation);
    res.json(await registerTrigger(accountId, wallet.walletId, automation.config, chatSessionId));
  } catch (err) {
    res.status(400).json({ error: publicErrorMessage(err) });
  }
});

/** Real completion progress ("3 / 10 fires", "$40 / $200 spent") per trigger, computed from its actual fire history — null when the trigger has no completionCondition set. */
app.get("/triggers", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const triggers = listTriggersForAccount(accountId);
  const withProgress = await Promise.all(
    triggers.map(async (t) => {
      const configError = validateTriggerConfig(t.config);
      if (configError && t.active) setActive(accountId, t.triggerId, false);
      const spentToken = t.config.type === "dca" ? t.config.tokenIn : t.config.repayAsset;
      const executions = listExecutions(accountId, t.triggerId);
      const status = await evaluateCompletion(t.config.completionCondition ?? null, executions, spentToken);
      return { ...t, active: configError ? false : t.active, completionProgress: status.progress, completionMet: status.met, configError };
    })
  );
  res.json({ triggers: withProgress });
});

app.post("/triggers/:triggerId/active", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const { active } = req.body as { active?: boolean };
  const trigger = listTriggersForAccount(accountId).find((candidate) => candidate.triggerId === req.params.triggerId);
  if (!trigger) {
    res.status(404).json({ error: `No trigger ${req.params.triggerId} on this account` });
    return;
  }
  if (active) {
    const configError = validateTriggerConfig(trigger.config);
    if (configError) {
      res.status(400).json({ error: configError });
      return;
    }
    const spentToken = trigger.config.type === "dca" ? trigger.config.tokenIn : trigger.config.repayAsset;
    const completion = await evaluateCompletion(
      trigger.config.completionCondition ?? null,
      listExecutions(accountId, trigger.triggerId),
      spentToken
    );
    if (completion.met) {
      res.status(409).json({ error: `This automation is already complete (${completion.progress})` });
      return;
    }
  }
  setActive(accountId, req.params.triggerId, Boolean(active));
  res.json({ ok: true });
});

app.delete("/triggers/:triggerId", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const deleted = deleteTrigger(accountId, req.params.triggerId);
  if (!deleted) {
    res.status(404).json({ error: `No trigger ${req.params.triggerId} on this account` });
    return;
  }
  res.json({ ok: true });
});

/** Run one stored automation check now. This uses the exact same monitor path
 * as the background loop, which makes it useful for both an on-demand status
 * refresh in the UI and deterministic operational verification. */
app.post("/triggers/:triggerId/check", requireAuth, async (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  const trigger = listTriggersForAccount(accountId).find((candidate) => candidate.triggerId === req.params.triggerId);
  if (!trigger) {
    res.status(404).json({ error: `No trigger ${req.params.triggerId} on this account` });
    return;
  }
  try {
    const { force } = req.body as { force?: boolean };
    // force is only used after an explicit user retry request. It bypasses
    // cadence once, but still uses the exact same lease, fresh quote,
    // simulation and on-chain confirmation path as the scheduler.
    if (force && trigger.config.type === "dca") setActive(accountId, trigger.triggerId, true);
    const refreshed = listTriggersForAccount(accountId).find((candidate) => candidate.triggerId === trigger.triggerId)!;
    const attempt = await runTriggerAttempt(refreshed, { force: Boolean(force) });
    if (!attempt.started) {
      res.status(409).json({ error: "This automation is already being checked" });
      return;
    }
    const updated = listTriggersForAccount(accountId).find((candidate) => candidate.triggerId === trigger.triggerId)!;
    const attemptedAction = updated.lastFiredAt !== trigger.lastFiredAt;
    const spentToken = updated.config.type === "dca" ? updated.config.tokenIn : updated.config.repayAsset;
    const completion = await evaluateCompletion(
      updated.config.completionCondition ?? null,
      listExecutions(accountId, updated.triggerId),
      spentToken
    );
    res.json({
      trigger: updated,
      check: completion.met
        ? { outcome: "completed", message: `Completed — ${completion.progress}. No further transaction is required.` }
        : updated.config.type === "dca" && !force && !attemptedAction
        ? { outcome: "not_due", message: "Checked successfully. This DCA is not due yet, so no transaction was sent." }
        : { outcome: attemptedAction ? "action_attempted" : "checked", message: attemptedAction ? "Checked successfully; see execution history for this attempt." : "Checked successfully; the condition did not require an action." },
    });
  } catch (err) {
    res.status(500).json({ error: publicErrorMessage(err) });
  }
});

/** GET /triggers/:triggerId/executions — real fire history (tx hash, gas, amounts, error) for one trigger, newest first. */
app.get("/triggers/:triggerId/executions", requireAuth, (req, res) => {
  const accountId = (req as express.Request & { accountId: string }).accountId;
  res.json({ executions: listExecutions(accountId, req.params.triggerId) });
});

/**
 * GET /wallet/health-factor?address=0x...&chain=arbitrum[&asset=USDC] — a
 * live read, used by the Automations quick-create UI to show a user their
 * real current position BEFORE asking them to set a threshold/repay-percent,
 * instead of a blind form. Pass `asset` to also get that asset's exact
 * current debt (needed to convert a repay-percent into a real amount).
 */
app.get("/wallet/health-factor", requireAuth, async (req, res) => {
  const address = req.query.address as string | undefined;
  const chain = req.query.chain as string | undefined;
  const asset = req.query.asset as string | undefined;
  if (!address || !chain) {
    res.status(400).json({ error: "address and chain query params are required" });
    return;
  }
  try {
    const snapshot = await getHealthFactor(chain, address as `0x${string}`);
    const assetDebt = asset ? await getAssetDebt(chain, asset, address as `0x${string}`).catch(() => null) : null;
    // JSON has no Infinity — JSON.stringify silently turns it into null,
    // which would look identical to "read failed" on the client. Make "no
    // debt, infinite health factor" an explicit field instead.
    res.json({
      ...snapshot,
      healthFactor: Number.isFinite(snapshot.healthFactor) ? snapshot.healthFactor : null,
      noDebt: !Number.isFinite(snapshot.healthFactor),
      assetDebt: assetDebt?.amount ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/** GET /chains — the supported-chain list, derived from src/chains/ so the frontend never hand-maintains its own copy. Public, no auth (static config). */
app.get("/chains", (_req, res) => {
  res.json({
    chains: CHAIN_KEYS.map((k) => ({
      key: k,
      label: CHAINS[k].label,
      aave: Boolean(CHAINS[k].aavePool),
      chainId: CHAINS[k].chainId,
      // From viem's own chain definitions (not hand-maintained) — undefined
      // for a chain viem doesn't carry explorer info for (e.g. Robinhood
      // Chain's custom defineChain() has none), which the frontend treats
      // as "no link available" rather than guessing a URL.
      explorerUrl: CHAINS[k].viemChain.blockExplorers?.default?.url,
    })),
  });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

startMonitorLoop();

const port = process.env.PORT ?? 8787;
app.listen(port, () => console.log(`Waypoint backend listening on :${port}`));
