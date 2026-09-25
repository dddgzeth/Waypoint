/**
 * LI.FI cross-chain quote adapter.
 *
 * Real quotes from LI.FI's public REST API (base URL https://li.quest/v1) — no
 * API key required for basic/low-volume use per LI.FI's own docs
 * (docs.li.fi/li.fi-api/li.fi-api: "All LI.FI APIs do not require API key. API
 * key is only needed for higher rate limits."). This only fetches quotes
 * (read-only, no funds move); building + signing + broadcasting the actual
 * transaction is orchestrator.ts's job, using the transactionRequest this
 * returns.
 */
import { formatUnits, parseUnits } from "viem";
import { CHAIN_ID, NATIVE_PLACEHOLDER_ZERO } from "../tokenRegistry.js";
import { resolveTokenReference, tokenReferenceDecimals } from "../tokenReference.js";

const LIFI_BASE_URL = "https://li.quest/v1";

export interface LifiQuoteRequest {
  fromChain: string; // our chain key, e.g. "arbitrum"
  fromToken: string; // symbol, e.g. "ETH"
  fromAmount: number; // human-readable amount, e.g. 0.1
  fromAddress: string; // wallet address executing (signing) the route
  toChain: string;
  toToken: string;
  slippage?: number; // fraction; omitted lets the provider calculate its route policy
  // Recipient of the output, if different from fromAddress — e.g.
  // consolidating several wallets' assets into one before a deposit.
  // LI.FI's own /quote API takes this as `toAddress`; omitted (not just
  // defaulted to fromAddress here) so LI.FI's own default behavior applies.
  toAddress?: string;
}

export interface LifiQuote {
  tool: string; // which bridge/DEX LI.FI picked
  estimatedToAmount: number; // human-readable estimated output
  estimatedDurationSeconds: number;
  gasCostUsd: number | null;
  fromAmountUsd: number | null;
  transactionRequest: { to: `0x${string}`; data: `0x${string}`; value: `0x${string}`; from: `0x${string}` } | null;
  toChain: string;
  toTokenDecimals: number;
  raw: unknown; // full LI.FI response
}

function toBaseUnits(amount: number, decimals: number): string {
  return parseUnits(String(amount), decimals).toString();
}

function fromBaseUnits(amountStr: string, decimals: number): number {
  return Number(formatUnits(BigInt(amountStr), decimals));
}

/** Fetches a real cross-chain (or same-chain) route quote from LI.FI. Read-only — does not execute anything. */
export async function getLifiQuote(req: LifiQuoteRequest): Promise<LifiQuote> {
  const fromChainId = CHAIN_ID[req.fromChain];
  const toChainId = CHAIN_ID[req.toChain];
  const fromTokenAddress = resolveTokenReference(req.fromChain, req.fromToken, NATIVE_PLACEHOLDER_ZERO);
  const toTokenAddress = resolveTokenReference(req.toChain, req.toToken, NATIVE_PLACEHOLDER_ZERO);
  const [fromDecimals, toDecimals] = await Promise.all([
    tokenReferenceDecimals(req.fromChain, req.fromToken),
    tokenReferenceDecimals(req.toChain, req.toToken),
  ]);

  if (!fromChainId || !toChainId || !fromTokenAddress || !toTokenAddress || fromDecimals === undefined || toDecimals === undefined) {
    throw new Error(
      `LI.FI adapter doesn't support: ${req.fromToken}@${req.fromChain} -> ${req.toToken}@${req.toChain}`
    );
  }

  const params = new URLSearchParams({
    fromChain: String(fromChainId),
    toChain: String(toChainId),
    fromToken: fromTokenAddress,
    toToken: toTokenAddress,
    fromAmount: toBaseUnits(req.fromAmount, fromDecimals),
    fromAddress: req.fromAddress,
  });
  if (req.slippage !== undefined) params.set("slippage", String(req.slippage));
  if (req.toAddress) params.set("toAddress", req.toAddress);

  const res = await fetch(`${LIFI_BASE_URL}/quote?${params.toString()}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LI.FI quote request failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    toolDetails?: { name?: string };
    estimate: { toAmount: string; executionDuration: number; gasCosts?: Array<{ amountUSD?: string }>; fromAmountUSD?: string };
    transactionRequest?: { to: `0x${string}`; data: `0x${string}`; value: `0x${string}`; from: `0x${string}` };
  };

  const gasCostUsd = data.estimate.gasCosts?.reduce((sum, g) => sum + Number(g.amountUSD ?? 0), 0) ?? null;

  return {
    tool: data.toolDetails?.name ?? "unknown",
    estimatedToAmount: fromBaseUnits(data.estimate.toAmount, toDecimals),
    estimatedDurationSeconds: data.estimate.executionDuration,
    gasCostUsd,
    fromAmountUsd: data.estimate.fromAmountUSD ? Number(data.estimate.fromAmountUSD) : null,
    transactionRequest: data.transactionRequest ?? null,
    toChain: req.toChain,
    toTokenDecimals: toDecimals,
    raw: data,
  };
}

export interface LifiStatus {
  status: "PENDING" | "DONE" | "FAILED" | "NOT_FOUND" | "INVALID";
  substatus: string | null;
  receivingTxHash: `0x${string}` | null;
  receivedAmount: number | null; // human-readable, using the decimals passed in
}

/**
 * Polls LI.FI's real status-tracking endpoint (docs.li.fi/li.fi-api/li.fi-api/status-of-a-transaction)
 * for a cross-chain (or same-chain) transfer, using the SOURCE-chain tx hash.
 * This is how you find out whether a bridge leg actually completed and what
 * arrived on the destination chain — the destination-chain delivery is a
 * separate transaction submitted by the bridge/relayer, not something we sign
 * ourselves, so it can't be read from the source tx's own receipt.
 */
export async function pollLifiStatus(params: {
  sourceTxHash: `0x${string}`;
  fromChain: string;
  toChain: string;
  toTokenDecimals: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<LifiStatus> {
  const fromChainId = CHAIN_ID[params.fromChain];
  const toChainId = CHAIN_ID[params.toChain];
  const timeoutMs = params.timeoutMs ?? 120_000;
  const pollIntervalMs = params.pollIntervalMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const query = new URLSearchParams({
      txHash: params.sourceTxHash,
      fromChain: String(fromChainId),
      toChain: String(toChainId),
    });
    const res = await fetch(`${LIFI_BASE_URL}/status?${query.toString()}`);
    if (res.ok) {
      const data = (await res.json()) as {
        status: LifiStatus["status"];
        substatus?: string;
        receiving?: { txHash?: `0x${string}`; amount?: string };
      };
      if (data.status === "DONE") {
        return {
          status: "DONE",
          substatus: data.substatus ?? null,
          receivingTxHash: data.receiving?.txHash ?? null,
          receivedAmount: data.receiving?.amount ? fromBaseUnits(data.receiving.amount, params.toTokenDecimals) : null,
        };
      }
      if (data.status === "FAILED" || data.status === "INVALID") {
        return { status: data.status, substatus: data.substatus ?? null, receivingTxHash: null, receivedAmount: null };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { status: "PENDING", substatus: "timed out waiting for LI.FI status", receivingTxHash: null, receivedAmount: null };
}
