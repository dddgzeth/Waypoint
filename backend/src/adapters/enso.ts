/**
 * Enso Shortcuts adapter — same-chain multi-protocol action bundling
 * (e.g. "deposit USDC into Aave" expressed as one routed transaction).
 *
 * Real Route API calls against https://api.enso.build/api/v1/shortcuts/route
 * (docs.enso.build/pages/build/get-started/authentication). Requires an API
 * key (ENSO_API_KEY in .env) — unlike LI.FI, Enso has no key-free tier.
 * This only fetches a route (read-only, no funds move); building + signing +
 * broadcasting the actual transaction is orchestrator.ts's job.
 *
 * "Deposit into Aave" isn't a distinct Enso action — it's expressed by
 * routing tokenOut to the Aave aToken address (the receipt token for that
 * deposit), so Enso plans the swap+supply itself. The aToken address comes
 * from adapters/aaveYield.ts, which already reads it live from the Aave Pool
 * contract, rather than hardcoding a second copy of it here.
 */
import { formatUnits, parseUnits } from "viem";
import { CHAIN_ID, NATIVE_PLACEHOLDER_EEEE } from "../tokenRegistry.js";
import { resolveTokenReference, tokenReferenceDecimals } from "../tokenReference.js";

const ENSO_BASE_URL = "https://api.enso.build/api/v1";

function apiKey(): string {
  const key = process.env.ENSO_API_KEY;
  if (!key) {
    throw new Error("ENSO_API_KEY environment variable not found");
  }
  return key;
}

function toBaseUnits(amount: number, decimals: number): string {
  return parseUnits(String(amount), decimals).toString();
}

function fromBaseUnits(amountStr: string, decimals: number): number {
  return Number(formatUnits(BigInt(amountStr), decimals));
}

interface EnsoRouteResponse {
  amountOut: string;
  priceImpact?: number | null;
  gas: string;
  tx: { to: `0x${string}`; data: `0x${string}`; value: string; from: `0x${string}` };
  route?: Array<{ protocol?: string; action?: string }>;
}

export interface EnsoRouteResult {
  estimatedAmountOut: number;
  estimatedGas: string;
  /** Slippage used for this exact route, in basis points. */
  slippageBps: number;
  priceImpactBps: number | null;
  transactionRequest: { to: `0x${string}`; data: `0x${string}`; value: `0x${string}`; from: `0x${string}` };
  raw: unknown;
}

function adaptiveSlippageBps(priceImpactBps: number | null | undefined): number {
  const impact = Math.max(0, priceImpactBps ?? 0);
  // The route's own simulated price impact is the market-derived input. The
  // square-root term gives proportionally less headroom as liquidity improves
  // and more headroom as impact rises, without a global fixed slippage value.
  return Math.ceil(impact + Math.sqrt(impact));
}

async function requestEnsoRoute(params: {
  chainKey: string;
  fromAddress: string;
  tokenInSymbol: string;
  tokenOutAddress: string;
  tokenOutDecimals: number;
  amountIn: number;
  slippageBps?: number;
  // Recipient of the output, if different from fromAddress — Enso's own
  // `receiver` field, already decoupled from `fromAddress`/`spender` in
  // their API (both of which must stay the signer, since that's who's
  // approving/spending the input).
  receiverAddress?: string;
}): Promise<EnsoRouteResult> {
  const chainId = CHAIN_ID[params.chainKey];
  const tokenInAddress = resolveTokenReference(params.chainKey, params.tokenInSymbol, NATIVE_PLACEHOLDER_EEEE);
  const tokenInDecimals = await tokenReferenceDecimals(params.chainKey, params.tokenInSymbol);
  if (!chainId || !tokenInAddress || tokenInDecimals === undefined) {
    throw new Error(`Enso adapter doesn't support: ${params.tokenInSymbol}@${params.chainKey}`);
  }

  const query = new URLSearchParams({
    chainId: String(chainId),
    fromAddress: params.fromAddress,
    receiver: params.receiverAddress ?? params.fromAddress,
    spender: params.fromAddress,
    amountIn: toBaseUnits(params.amountIn, tokenInDecimals),
    tokenIn: tokenInAddress,
    tokenOut: params.tokenOutAddress,
    routingStrategy: "router",
  });
  if (params.slippageBps !== undefined) query.set("slippage", String(params.slippageBps));

  const res = await fetch(`${ENSO_BASE_URL}/shortcuts/route?${query.toString()}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Enso route request failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as EnsoRouteResponse;

  return {
    estimatedAmountOut: fromBaseUnits(data.amountOut, params.tokenOutDecimals),
    estimatedGas: data.gas,
    slippageBps: params.slippageBps ?? 0,
    priceImpactBps: data.priceImpact ?? null,
    transactionRequest: { ...data.tx, value: data.tx.value.startsWith("0x") ? (data.tx.value as `0x${string}`) : (`0x${BigInt(data.tx.value || "0").toString(16)}` as `0x${string}`) },
    raw: data,
  };
}

/** Fetches a real Enso route for tokenIn -> tokenOut on one chain. The first
 * read-only quote supplies Enso's simulated price impact; the second route is
 * built with a slippage bound derived from that live impact. */
async function getEnsoRoute(params: {
  chainKey: string;
  fromAddress: string;
  tokenInSymbol: string;
  tokenOutAddress: string;
  tokenOutDecimals: number;
  amountIn: number;
  slippageBps?: number;
  receiverAddress?: string;
}): Promise<EnsoRouteResult> {
  if (params.slippageBps !== undefined) return requestEnsoRoute(params);
  const reference = await requestEnsoRoute(params);
  return requestEnsoRoute({ ...params, slippageBps: adaptiveSlippageBps(reference.priceImpactBps) });
}

/**
 * Routes tokenInSymbol -> a deposit into Aave, on one chain, in one Enso-planned
 * transaction (swap-if-needed + supply). Takes the aToken address + decimals
 * from adapters/aaveYield.ts's live on-chain read rather than a hardcoded copy.
 */
export async function depositIntoAaveViaEnso(params: {
  chainKey: string;
  fromAddress: string;
  tokenInSymbol: string;
  amountIn: number;
  aTokenAddress: string;
  underlyingDecimals: number;
  receiverAddress?: string;
}): Promise<EnsoRouteResult> {
  return getEnsoRoute({
    chainKey: params.chainKey,
    fromAddress: params.fromAddress,
    tokenInSymbol: params.tokenInSymbol,
    tokenOutAddress: params.aTokenAddress,
    tokenOutDecimals: params.underlyingDecimals, // aTokens are 1:1, same decimals as the underlying
    amountIn: params.amountIn,
    receiverAddress: params.receiverAddress,
  });
}

export { getEnsoRoute };
