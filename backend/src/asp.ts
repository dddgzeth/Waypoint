/**
 * Public, stateless planning service for agent marketplaces (OKX.AI A2MCP).
 *
 * POST /asp/plan { goal, walletAddress? } -> a validated multi-step execution plan.
 * It reads public chain state, runs the goal parser and the planner, and returns the
 * plan. It never signs, never executes and never touches an account, a session or an
 * execution wallet. Execution stays behind the authenticated app and its one-time
 * confirmation.
 *
 * Because it is public and every call costs model and RPC usage, it is rate limited
 * (per client and globally) and concurrency capped.
 *
 * Payment (x402, OKX facilitator): when ASP_PAY_TO is set, POST /asp/plan costs ASP_PRICE_USD
 * per call, paid in the network's x402 stablecoin (default X Layer, eip155:196). The caller
 * gets HTTP 402 with the payment requirements, signs, and retries. Payment is settled only
 * when the response is a success (status < 400): bad input, rate limits, errors and
 * "needs clarification" (422) are never charged. Unset ASP_PAY_TO = free mode.
 */
import type { Express, Request, Response } from "express";
import { isAddress } from "viem";
import { parseGoal } from "./goalParser.js";
import { buildPlan, PlanValidationError } from "./planner.js";
import { getMockWalletState, getWalletState } from "./stateReader.js";
import { prettyPlan } from "./models.js";
import type { WalletStateSnapshot } from "./models.js";
import { judgeReadiness } from "./agents/readinessAgent.js";
import { publicErrorMessage } from "./errors.js";
import { CHAIN_KEYS } from "./chains/index.js";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";

const GOAL_MIN = 3;
const GOAL_MAX = 600;
const HOUR_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 120_000;

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const PER_CLIENT_PER_HOUR = () => num(process.env.ASP_RATE_PER_CLIENT_HOUR, 20);
const GLOBAL_PER_HOUR = () => num(process.env.ASP_RATE_GLOBAL_HOUR, 150);
const MAX_CONCURRENT = () => num(process.env.ASP_MAX_CONCURRENT, 3);

const perClient = new Map<string, number[]>();
let globalHits: number[] = [];
let inFlight = 0;

function recent(list: number[], now: number): number[] {
  return list.filter((t) => now - t < HOUR_MS);
}

/** Returns seconds to wait if the call is over a limit, else null (and records the call). */
function takeSlot(client: string): number | null {
  const now = Date.now();
  globalHits = recent(globalHits, now);
  const mine = recent(perClient.get(client) ?? [], now);
  if (mine.length >= PER_CLIENT_PER_HOUR()) return Math.ceil((HOUR_MS - (now - mine[0]!)) / 1000);
  if (globalHits.length >= GLOBAL_PER_HOUR()) return Math.ceil((HOUR_MS - (now - globalHits[0]!)) / 1000);
  mine.push(now);
  globalHits.push(now);
  perClient.set(client, mine);
  if (perClient.size > 5000) for (const [k, v] of perClient) if (recent(v, now).length === 0) perClient.delete(k);
  return null;
}

/** Cloudflare fronts the site; nginx forwards its headers. Falls back to the socket address. */
function clientId(req: Request): string {
  const h = (k: string) => (typeof req.headers[k] === "string" ? (req.headers[k] as string) : undefined);
  return h("cf-connecting-ip") ?? h("x-real-ip") ?? req.socket.remoteAddress ?? "unknown";
}

const PAY_TO = () => process.env.ASP_PAY_TO?.trim() || null;
const PRICE_USD = () => process.env.ASP_PRICE_USD?.trim() || "0.02";
const PAY_NETWORK = () => (process.env.ASP_X402_NETWORK?.trim() || "eip155:196") as `${string}:${string}`;

const DESCRIPTOR = () => ({
  ok: true,
  service: "Waypoint Plan",
  description:
    "Turn one plain-language onchain goal into a validated, dependency-ordered, multi-step cross-chain execution plan " +
    "(swap, bridge, Aave supply/withdraw/borrow, transfer, custom contract call). Read-only: it plans, it does not sign or execute.",
  endpoint: "POST /asp/plan",
  input: {
    goal: `string, ${GOAL_MIN}-${GOAL_MAX} characters, the outcome you want. Required.`,
    walletAddress: "0x address, optional. If set, the plan is built against that wallet's real public balances; otherwise against a demo wallet.",
  },
  output: {
    plan: "ordered steps with chain, asset, amount and provider per step, and dependencies between steps",
    goal: "the structured goal parsed from your text",
    summary: "the plan as readable text",
    status: '"planned" with a plan, or "needs_clarification" with one question when the goal is unclear',
    executed: "always false",
  },
  supportedChains: CHAIN_KEYS,
  example: {
    goal: "Swap 100 USDC on Base to ETH, bridge it to Arbitrum and deposit it into Aave",
  },
  limits: { perClientPerHour: PER_CLIENT_PER_HOUR(), globalPerHour: GLOBAL_PER_HOUR() },
  pricing: PAY_TO()
    ? {
        model: "x402 pay-per-call",
        pricePerPlanUsd: PRICE_USD(),
        network: PAY_NETWORK(),
        payTo: PAY_TO(),
        charged: "only when a plan is returned (HTTP 200); clarification questions (422), errors and rate limits are free",
      }
    : { model: "free" },
});

async function handlePlan(req: Request, res: Response) {
  const body = (req.body ?? {}) as { goal?: unknown; goalText?: unknown; walletAddress?: unknown };
  const raw = body.goal ?? body.goalText;

  // No goal: describe the service (also what a marketplace health probe sees).
  if (raw === undefined || raw === null || raw === "") {
    res.status(200).json(DESCRIPTOR());
    return;
  }
  if (typeof raw !== "string") {
    res.status(400).json({ ok: false, error: "goal must be a string" });
    return;
  }
  const goal = raw.trim();
  if (goal.length < GOAL_MIN || goal.length > GOAL_MAX) {
    res.status(400).json({ ok: false, error: `goal must be ${GOAL_MIN}-${GOAL_MAX} characters` });
    return;
  }
  let walletAddress: string | undefined;
  if (body.walletAddress !== undefined && body.walletAddress !== null && body.walletAddress !== "") {
    if (typeof body.walletAddress !== "string" || !isAddress(body.walletAddress)) {
      res.status(400).json({ ok: false, error: "walletAddress must be a valid 0x address" });
      return;
    }
    walletAddress = body.walletAddress;
  }

  const wait = takeSlot(clientId(req));
  if (wait !== null) {
    res.setHeader("Retry-After", String(wait));
    res.status(429).json({ ok: false, error: "rate limit reached, retry later", retryAfterSeconds: wait });
    return;
  }
  if (inFlight >= MAX_CONCURRENT()) {
    res.setHeader("Retry-After", "10");
    res.status(429).json({ ok: false, error: "service is busy, retry in a few seconds", retryAfterSeconds: 10 });
    return;
  }

  inFlight++;
  try {
    const work = (async () => {
      const state = walletAddress ? await getWalletState(walletAddress) : getMockWalletState();
      const snapshot: WalletStateSnapshot = { ...state, label: "Selected wallet", kind: "execution" };
      // Same gate the chat uses: an unclear or non-actionable request gets one question, never an invented plan.
      const readiness = await judgeReadiness([], goal, [snapshot], [], process.env.OPENAI_MODEL || "gpt-4o-mini");
      if (!readiness.ready) return { question: readiness.message } as const;
      const parsed = await parseGoal(goal, [snapshot]);
      const plan = await buildPlan(parsed, [snapshot]);
      return { parsed, plan } as const;
    })();
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("planning timed out")), REQUEST_TIMEOUT_MS));
    const result = await Promise.race([work, timeout]);
    if ("question" in result) {
      // 422, not 200: no plan was produced, so the x402 middleware does not settle (the caller is not charged).
      res.status(422).json({ ok: false, service: "Waypoint Plan", status: "needs_clarification", executed: false, charged: false, question: result.question });
      return;
    }
    const { parsed, plan } = result;
    res.status(200).json({
      ok: true,
      service: "Waypoint Plan",
      status: "planned",
      executed: false,
      walletState: walletAddress ? "onchain" : "demo",
      goal: parsed,
      plan,
      summary: prettyPlan(plan),
      note: "This is a plan only. Nothing was signed or sent. Execution requires the Waypoint app and a one-time user confirmation.",
    });
  } catch (err) {
    if (err instanceof PlanValidationError) {
      res.status(422).json({ ok: false, error: err.message });
      return;
    }
    console.error("[asp/plan] failed:", err instanceof Error ? err.message : err);
    const timedOut = err instanceof Error && err.message === "planning timed out";
    // Public endpoint: never echo internal error text (paths, provider details). Details stay in the server log.
    const upstreamBusy = /temporarily rate-limiting/.test(publicErrorMessage(err));
    res.status(timedOut ? 504 : upstreamBusy ? 503 : 500).json({
      ok: false,
      error: timedOut ? "planning timed out" : upstreamBusy ? "an upstream data provider is busy, retry in a few seconds" : "planning failed, please retry",
    });
  } finally {
    inFlight--;
  }
}

function registerPayment(app: Express): void {
  const payTo = PAY_TO();
  if (!payTo) return;
  if (!isAddress(payTo)) throw new Error("ASP_PAY_TO is not a valid 0x address");
  const { OKX_ONCHAIN_API_KEY: apiKey, OKX_ONCHAIN_SECRET_KEY: secretKey, OKX_ONCHAIN_PASSPHRASE: passphrase } = process.env;
  if (!apiKey || !secretKey || !passphrase) throw new Error("ASP_PAY_TO is set but the OKX_ONCHAIN_* facilitator credentials are missing");
  const facilitator = new OKXFacilitatorClient({ apiKey, secretKey, passphrase } as never);
  const network = PAY_NETWORK();
  const server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
  app.use(
    paymentMiddleware(
      {
        "POST /asp/plan": {
          accepts: { scheme: "exact", price: `$${PRICE_USD()}`, network, payTo, maxTimeoutSeconds: 60 },
          description: "Waypoint Plan: one validated multi-step cross-chain execution plan (read-only)",
        },
      },
      server,
    ),
  );
  console.log(`[asp] x402 payment enabled: $${PRICE_USD()} per plan on ${network}, payTo ${payTo}`);
}

export function registerAspRoutes(app: Express): void {
  registerPayment(app);
  app.get("/asp/plan", (_req, res) => res.status(200).json(DESCRIPTOR()));
  app.post("/asp/plan", handlePlan);
}
