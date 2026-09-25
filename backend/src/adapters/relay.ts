/**
 * Relay.link cross-chain quote adapter — a second bridge option alongside LI.FI.
 *
 * Real quotes from Relay's public REST API (base URL https://api.relay.link).
 * Response fields below were confirmed against a live POST /quote/v2 call
 * (docs.relay.link's own example response was incomplete/ambiguous about
 * where the output amount lives), not assumed from docs. Relay uses the same
 * native-token placeholder convention as LI.FI (0x0000...0000), unlike Enso's
 * 0xEeee...eeeE.
 */
import { formatUnits, parseUnits } from "viem";
import { CHAIN_ID, NATIVE_PLACEHOLDER_ZERO } from "../tokenRegistry.js";
import { resolveTokenReference, tokenReferenceDecimals } from "../tokenReference.js";

const RELAY_BASE_URL = "https://api.relay.link";

export interface RelayQuoteRequest {
  fromChain: string;
  fromToken: string;
  fromAmount: number;
  fromAddress: string; // who spends/signs — Relay's `user`
  toChain: string;
  toToken: string;
  // Recipient of the output, if different from fromAddress — Relay's own
  // `recipient` field, already decoupled from `user` in their API.
  toAddress?: string;
}

export interface RelayQuote {
  requestId: string;
  estimatedToAmount: number; // human-readable, from details.currencyOut.amountFormatted
  estimatedToAmountUsd: number | null;
  minimumToAmount: number; // worst case after slippage, human-readable
  estimatedDurationSeconds: number | null;
  gasCostUsd: number | null;
  fromAmountUsd: number | null;
  transactionRequest: { to: `0x${string}`; data: `0x${string}`; value: `0x${string}`; from: `0x${string}` } | null;
  toChain: string;
  toTokenDecimals: number;
  raw: unknown;
}

function toBaseUnits(amount: number, decimals: number): string {
  return parseUnits(String(amount), decimals).toString();
}

function fromBaseUnitsStr(amountStr: string, decimals: number): number {
  return Number(formatUnits(BigInt(amountStr), decimals));
}

function authHeaders(): Record<string, string> {
  const key = process.env.RELAY_API_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["x-api-key"] = key;
  return headers;
}

/** Fetches a real cross-chain (or same-chain) route quote from Relay. Read-only — does not execute anything. */
export async function getRelayQuote(req: RelayQuoteRequest): Promise<RelayQuote> {
  const fromChainId = CHAIN_ID[req.fromChain];
  const toChainId = CHAIN_ID[req.toChain];
  const fromTokenAddress = resolveTokenReference(req.fromChain, req.fromToken, NATIVE_PLACEHOLDER_ZERO);
  const toTokenAddress = resolveTokenReference(req.toChain, req.toToken, NATIVE_PLACEHOLDER_ZERO);
  const fromDecimals = await tokenReferenceDecimals(req.fromChain, req.fromToken);

  if (!fromChainId || !toChainId || !fromTokenAddress || !toTokenAddress || fromDecimals === undefined) {
    throw new Error(`Relay adapter doesn't support: ${req.fromToken}@${req.fromChain} -> ${req.toToken}@${req.toChain}`);
  }

  const body = {
    user: req.fromAddress,
    recipient: req.toAddress ?? req.fromAddress,
    originChainId: fromChainId,
    destinationChainId: toChainId,
    originCurrency: fromTokenAddress,
    destinationCurrency: toTokenAddress,
    amount: toBaseUnits(req.fromAmount, fromDecimals),
    tradeType: "EXACT_INPUT",
  };

  const res = await fetch(`${RELAY_BASE_URL}/quote/v2`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Relay quote request failed (${res.status}): ${errBody}`);
  }
  const data = (await res.json()) as {
    steps: Array<{
      requestId?: string;
      items: Array<{ data: { to: `0x${string}`; data: `0x${string}`; value: string; from: `0x${string}` } }>;
    }>;
    fees?: { gas?: { amountUsd?: string } };
    details: {
      currencyOut: { amount: string; amountFormatted: string; amountUsd: string; minimumAmount: string };
      currencyIn: { amountUsd: string };
    };
    timeEstimate?: number;
  };

  if (!data.steps || data.steps.length === 0) {
    throw new Error("Relay quote returned no executable steps");
  }
  if (data.steps.length > 1 || data.steps[0].items.length > 1) {
    // Multi-step Relay routes (e.g. separate approve step for ERC20 input) aren't
    // handled yet — same scope boundary as Morpho not being implemented in the
    // orchestrator. Fail loudly instead of silently only running the first step.
    throw new Error("Relay quote returned a multi-step route; only single-transaction routes are supported so far");
  }

  const step = data.steps[0];
  const item = step.items[0];
  const toDecimals = await tokenReferenceDecimals(req.toChain, req.toToken);

  return {
    requestId: step.requestId ?? "",
    estimatedToAmount: Number(data.details.currencyOut.amountFormatted),
    estimatedToAmountUsd: data.details.currencyOut.amountUsd ? Number(data.details.currencyOut.amountUsd) : null,
    minimumToAmount: fromBaseUnitsStr(data.details.currencyOut.minimumAmount, toDecimals),
    estimatedDurationSeconds: data.timeEstimate ?? null,
    gasCostUsd: data.fees?.gas?.amountUsd ? Number(data.fees.gas.amountUsd) : null,
    fromAmountUsd: data.details.currencyIn.amountUsd ? Number(data.details.currencyIn.amountUsd) : null,
    transactionRequest: {
      to: item.data.to,
      data: item.data.data,
      value: (item.data.value.startsWith("0x") ? item.data.value : `0x${BigInt(item.data.value).toString(16)}`) as `0x${string}`,
      from: item.data.from,
    },
    toChain: req.toChain,
    toTokenDecimals: toDecimals,
    raw: data,
  };
}

export interface RelayStatus {
  status: "PENDING" | "DONE" | "FAILED";
  rawStatus: string;
  receivingTxHash: `0x${string}` | null;
}

/**
 * Polls Relay's status-tracking endpoint for a submitted request, using the
 * requestId returned by getRelayQuote (NOT the source tx hash — confirmed via
 * a live call that GET /intents/status/v3?requestId=... returns
 * {status:"waiting", ...} before a tx is submitted). Field names for the
 * "done" case are validated empirically on first real use, since Relay's docs
 * page didn't render a complete example.
 */
export async function pollRelayStatus(params: {
  requestId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<RelayStatus> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const pollIntervalMs = params.pollIntervalMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${RELAY_BASE_URL}/intents/status/v3?requestId=${params.requestId}`, {
      headers: authHeaders(),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        status: string;
        txHashes?: `0x${string}`[];
        inTxHashes?: `0x${string}`[];
        outTxHashes?: `0x${string}`[];
        destinationTxHash?: `0x${string}`;
      };
      const s = data.status.toLowerCase();
      if (s.includes("success") || s.includes("complete") || s === "done") {
        const receivingTxHash = data.outTxHashes?.[0] ?? data.destinationTxHash ?? data.txHashes?.[0] ?? null;
        return { status: "DONE", rawStatus: data.status, receivingTxHash };
      }
      if (s.includes("fail") || s.includes("refund")) {
        return { status: "FAILED", rawStatus: data.status, receivingTxHash: null };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { status: "PENDING", rawStatus: "timed out waiting for Relay status", receivingTxHash: null };
}
