/**
 * Orchestrator: the real execution-time state machine. Takes a validated
 * ExecutionPlan and actually runs it — signs and broadcasts a real
 * transaction for each step, on real mainnet chains, with real funds.
 *
 * Safety rules:
 *   1. Every step is simulated (eth_call) before it is ever signed. A step
 *      that would revert is never sent.
 *      (There is deliberately no platform-wide dollar cap on step size — a
 *      hardcoded limit is a decision for whoever owns the funds, not for
 *      this codebase to impose on their behalf. If a spending limit is
 *      wanted, it belongs as a user-set, per-account/per-wallet setting —
 *      not baked in here.)
 *   2. Steps run strictly in order (step1, step2, ...). If any step's
 *      simulation OR real execution fails, the run stops immediately —
 *      dependent steps are never attempted on top of a failed/uncertain
 *      state.
 *   3. `output_of(stepX)` references are resolved from the REAL measured
 *      output of that step, and the measurement method depends on whether
 *      the step is same-chain or cross-chain:
 *        - Same-chain: parsed directly from the ERC20 Transfer log(s) in
 *          that step's own transaction receipt. (An earlier version polled
 *          balance before/after via separate RPC calls and got a false
 *          "0 received" on a real, successful swap — the "after" read hit a
 *          public RPC node that hadn't caught up yet. Reading the receipt's
 *          own logs is deterministic: it reflects exactly what that
 *          transaction did, independent of any other node's state.)
 *        - Cross-chain (bridge / cross_chain_swap): the destination-chain
 *          delivery is a SEPARATE transaction submitted by the bridge's own
 *          relayer/solver, not something we sign — it cannot appear in our
 *          source-chain transaction's receipt. Confirmed via the bridge's own
 *          status-tracking endpoint (LI.FI's /status polled by source tx
 *          hash, or Relay's /intents/status/v3 polled by requestId) until it
 *          reports delivery is done — that's what the bridge protocol itself
 *          reports as delivered, rather than us guessing at destination
 *          balance changes that could collide with unrelated activity. For
 *          Relay specifically, the status endpoint's own "done" payload
 *          shape wasn't fully documented, so once it confirms delivery we
 *          still read the actual amount from the destination tx's own
 *          Transfer log (same technique as the same-chain case, just against
 *          the destination chain's receipt instead of the source chain's).
 *   4. Two bridge vendors are wired up (LI.FI and Relay); a plan step picks
 *      one via its `vendorAdapter` field, defaulting to LI.FI when unset.
 *      Neither is a hard dependency — see plan.md for why.
 */
import { createPublicClient, createWalletClient, parseEventLogs, erc20Abi, maxUint256, encodeFunctionData, formatUnits, parseUnits } from "viem";
import type { Account } from "viem";
import type { ExecutionPlan, PlanStep } from "./models.js";
import { VIEM_CHAIN, NATIVE_SYMBOL, NATIVE_PLACEHOLDER_EEEE } from "./tokenRegistry.js";
import { getChain } from "./chains/index.js";
import { alchemyHttp, alchemyHttpForKey } from "./adapters/alchemyTransport.js";
import { getSingleTokenBalance } from "./stateReader.js";
import { getLifiQuote, pollLifiStatus } from "./adapters/lifi.js";
import { getRelayQuote, pollRelayStatus } from "./adapters/relay.js";
import { getAaveBorrowMarket, getAaveSupplyApy } from "./adapters/aaveYield.js";
import { getHealthFactor } from "./adapters/aaveHealthFactor.js";
import { getEnsoRoute } from "./adapters/enso.js";
import { getOkxDexSwapRoute } from "./adapters/okxDex.js";
import { encodeCustomCall } from "./customCall/execute.js";
import { resolveTokenReference, tokenReferenceDecimals } from "./tokenReference.js";
import { resolveLiveProtocolTokenReferences } from "./protocolTokenResolver.js";
import { alchemyApiKeys } from "./chains/index.js";

export class OrchestratorError extends Error {
  constructor(
    message: string,
    public readonly stepId: string,
    /** Present only after a transaction was actually broadcast. Callers can
     * distinguish a pre-send error from an on-chain failure and retain proof. */
    public readonly txHash?: `0x${string}`
  ) {
    super(message);
  }
}

export interface StepResult {
  stepId: string;
  txHash: `0x${string}`;
  destTxHash?: `0x${string}`; // cross-chain steps only — the destination-chain delivery tx (a separate tx submitted by the bridge's own relayer, not signed by us)
  resolvedAmountIn: number;
  actualAmountOut: number;
  outputSymbol: string; // what was actually measured (may be an aToken symbol for deposits)
  gasUsed: string; // decimal string (bigint doesn't survive JSON.stringify) — for execution-log display
}

/**
 * Real-time progress events emitted while a plan runs — lets a caller (e.g.
 * server.ts's SSE endpoint) show live per-step status instead of a single
 * blocking "executing..." spinner until the whole plan finishes. Every field
 * is real data pulled from the same values already being sent/measured, not
 * synthesized for display.
 */
export type ProgressEvent =
  | { type: "step_start"; stepId: string; action: string; summary: string }
  | { type: "step_status"; stepId: string; status: string; detail?: string }
  | { type: "step_tx"; stepId: string; label: "source" | "destination" | "approval"; chainKey: string; txHash: string }
  | { type: "step_complete"; stepId: string; result: StepResult }
  | { type: "step_failed"; stepId: string; error: string };

export type ProgressCallback = (event: ProgressEvent) => void;

export interface TxRequest {
  to: `0x${string}`;
  data: `0x${string}`;
  value: `0x${string}`;
}

interface BuiltStep {
  tx: TxRequest;
  outputSymbol: string;
  outputTokenAddress: `0x${string}` | null; // null means native token output (not yet supported for measurement — see readActualOutput)
  outputDecimals: number;
  bridgeAdapter?: "lifi" | "relay"; // only set for swap/bridge/cross_chain_swap steps
  relayRequestId?: string; // only set when bridgeAdapter === "relay"
  /** A same-chain DEX can expose a dedicated ERC-20 approval target that is
   * different from the router transaction's `to` address. */
  approvalSpender?: `0x${string}`;
}

const OUTPUT_OF_RE = /^output_of\(([^)]+)\)$/;

async function resolveAmountIn(step: PlanStep, results: Map<string, StepResult>, account: Account): Promise<number> {
  if (step.amountIn === "all") {
    if (step.tokenIn.toUpperCase() === NATIVE_SYMBOL[step.chainFrom]) {
      throw new OrchestratorError('amountIn "all" is only supported for ERC20 balances; native assets must reserve gas', step.id);
    }
    if (step.action === "protocol_withdraw") {
      const reserve = await getAaveSupplyApy(step.chainFrom, step.tokenIn);
      const client = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
      const raw = await client.readContract({
        address: reserve.aTokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      });
      const amount = Number(formatUnits(raw, reserve.decimals));
      if (amount <= 0) throw new OrchestratorError(`No Aave ${step.tokenIn} position is available for amountIn "all"`, step.id);
      return amount;
    }
    const amount = await getSingleTokenBalance(step.chainFrom, step.tokenIn, account.address);
    if (amount <= 0) throw new OrchestratorError(`No ${step.tokenIn} balance is available for amountIn "all"`, step.id);
    return amount;
  }
  const match = OUTPUT_OF_RE.exec(step.amountIn);
  if (!match) {
    const n = Number(step.amountIn);
    if (Number.isNaN(n)) throw new OrchestratorError(`amountIn is not a number or output_of() reference: ${step.amountIn}`, step.id);
    return n;
  }
  const refId = match[1];
  const refResult = results.get(refId);
  if (!refResult) throw new OrchestratorError(`amountIn references ${refId}, which hasn't executed yet`, step.id);
  return refResult.actualAmountOut;
}

/** Builds the real transaction for a step via the adapter its vendorAdapter/action/protocol implies. */
/**
 * recipientAddress: where this step's output should land, if different from
 * fromAddress (the wallet that signs/funds it) — e.g. consolidating several
 * execution wallets' assets into one before a deposit. Defaults to
 * fromAddress (the pre-existing behavior: output returns to the signer).
 */
export async function buildStepTx(
  step: PlanStep,
  resolvedAmountIn: number,
  fromAddress: `0x${string}`,
  recipientAddress: `0x${string}` = fromAddress
): Promise<BuiltStep> {
  if (step.action === "protocol_withdraw") {
    if (step.protocol?.toLowerCase() !== "aave") {
      throw new OrchestratorError(`No withdrawal adapter for protocol "${step.protocol}" yet — only Aave is wired up`, step.id);
    }
    if (step.amountIn === "all") {
      const health = await getHealthFactor(step.chainFrom, fromAddress);
      if (health.totalDebtBase > 0) {
        throw new OrchestratorError(
          `Cannot fully withdraw Aave collateral while ${health.totalDebtBase.toFixed(2)} of debt remains (health factor ${health.healthFactor.toFixed(2)})`,
          step.id
        );
      }
    }
    const aave = await getAaveSupplyApy(step.chainFrom, step.tokenIn);
    const pool = getChain(step.chainFrom)?.aavePool;
    if (!pool) throw new OrchestratorError(`Aave is not available on ${step.chainFrom}`, step.id);
    const decimals = aave.decimals;
    // Aave V3 explicitly treats uint256.max as "withdraw the entire supplied
    // balance". It avoids converting an interest-accruing aToken balance
    // through JavaScript's decimal number representation, where rounding one
    // smallest unit upward can make an otherwise valid full withdrawal revert.
    const amount = step.amountIn === "all" ? maxUint256 : parseUnits(String(resolvedAmountIn), decimals);
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "withdraw",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "to", type: "address" },
          ],
          outputs: [{ name: "", type: "uint256" }],
        },
      ] as const,
      functionName: "withdraw",
      args: [aave.underlyingAddress, amount, recipientAddress],
    });
    return {
      tx: { to: pool, data, value: "0x0" },
      outputSymbol: step.tokenOut.toUpperCase(),
      outputTokenAddress: aave.underlyingAddress,
      outputDecimals: decimals,
    };
  }
  if (step.action === "protocol_supply") {
    if (step.protocol?.toLowerCase() !== "aave") {
      throw new OrchestratorError(`No execution adapter for protocol "${step.protocol}" yet — only Aave is wired up`, step.id);
    }
    const aave = await getAaveSupplyApy(step.chainTo, step.tokenOut);
    const pool = getChain(step.chainTo)?.aavePool;
    if (!pool) throw new OrchestratorError(`Aave is not available on ${step.chainTo}`, step.id);
    // Aave V3 aTokens always mirror their underlying asset's decimals exactly
    // (a protocol invariant, not an assumption) — planner.ts's prompt already
    // requires tokenOut === tokenIn for protocol_supply, so step.tokenOut's
    // decimals is the right value here regardless of which asset this is,
    // not just USDC.
    const underlyingDecimals = aave.decimals;
    const amount = parseUnits(String(resolvedAmountIn), underlyingDecimals);
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "supply",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "onBehalfOf", type: "address" },
            { name: "referralCode", type: "uint16" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "supply",
      args: [aave.underlyingAddress, amount, recipientAddress, 0],
    });
    return {
      tx: { to: pool, data, value: "0x0" },
      outputSymbol: `a${step.tokenOut.toUpperCase()}`,
      outputTokenAddress: aave.aTokenAddress,
      outputDecimals: underlyingDecimals,
    };
  }
  if (step.action === "protocol_borrow") {
    if (step.protocol?.toLowerCase() !== "aave") {
      throw new OrchestratorError(`No borrowing adapter for protocol "${step.protocol}" yet — only Aave is wired up`, step.id);
    }
    const aave = await getAaveBorrowMarket(step.chainTo, step.tokenOut);
    const pool = getChain(step.chainTo)?.aavePool;
    if (!pool) throw new OrchestratorError(`Aave is not available on ${step.chainTo}`, step.id);
    const amount = parseUnits(String(resolvedAmountIn), aave.decimals);
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "borrow",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "interestRateMode", type: "uint256" },
            { name: "referralCode", type: "uint16" },
            { name: "onBehalfOf", type: "address" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "borrow",
      args: [aave.underlyingAddress, amount, 2n, 0, fromAddress],
    });
    return {
      tx: { to: pool, data, value: "0x0" },
      outputSymbol: aave.symbol,
      outputTokenAddress: aave.underlyingAddress,
      outputDecimals: aave.decimals,
    };
  }

  // Same-chain swaps can use OKX's DEX router or Enso. Cross-chain movement
  // remains on LI.FI/Relay because the OKX adapter here intentionally only
  // integrates its documented single-chain DEX route.
  const isNativeOut = step.tokenOut.toUpperCase() === NATIVE_SYMBOL[step.chainTo];
  const outputTokenAddress = isNativeOut ? null : (resolveTokenReference(step.chainTo, step.tokenOut) ?? null);
  const outputDecimals = await tokenReferenceDecimals(step.chainTo, step.tokenOut);

  if (step.action === "swap" && step.chainFrom === step.chainTo && step.vendorAdapter?.toLowerCase() !== "lifi") {
    const routeOutputAddress = isNativeOut ? NATIVE_PLACEHOLDER_EEEE : outputTokenAddress;
    if (!routeOutputAddress) {
      throw new OrchestratorError(`Same-chain swap output ${step.tokenOut} has no known token address`, step.id);
    }
    const preferred = (step.vendorAdapter?.toLowerCase() ?? process.env.SAME_CHAIN_SWAP_PRIMARY ?? "enso");
    const providers = preferred === "okx" ? ["okx", "enso"] : ["enso", "okx"];
    let lastError: unknown;
    for (const provider of providers) {
      try {
        if (provider === "okx") {
          const route = await getOkxDexSwapRoute({
            chainKey: step.chainFrom,
            fromAddress,
            tokenIn: step.tokenIn,
            tokenOut: step.tokenOut,
            amountIn: resolvedAmountIn,
            recipientAddress,
          });
          return {
            tx: route.transactionRequest,
            outputSymbol: step.tokenOut,
            outputTokenAddress,
            outputDecimals,
            approvalSpender: route.approvalSpender ?? undefined,
          };
        }
        const route = await getEnsoRoute({
          chainKey: step.chainFrom,
          fromAddress,
          tokenInSymbol: step.tokenIn,
          tokenOutAddress: routeOutputAddress,
          tokenOutDecimals: outputDecimals,
          amountIn: resolvedAmountIn,
          receiverAddress: recipientAddress,
        });
        return {
          tx: { to: route.transactionRequest.to, data: route.transactionRequest.data, value: route.transactionRequest.value },
          outputSymbol: step.tokenOut,
          outputTokenAddress,
          outputDecimals,
        };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  if (step.vendorAdapter?.toLowerCase() === "relay") {
    const quote = await getRelayQuote({
      fromChain: step.chainFrom,
      fromToken: step.tokenIn,
      fromAmount: resolvedAmountIn,
      fromAddress,
      toChain: step.chainTo,
      toToken: step.tokenOut,
      toAddress: recipientAddress,
    });
    if (!quote.transactionRequest) {
      throw new OrchestratorError("Relay quote returned no transactionRequest", step.id);
    }
    return {
      tx: quote.transactionRequest,
      outputSymbol: step.tokenOut,
      outputTokenAddress,
      outputDecimals,
      bridgeAdapter: "relay",
      relayRequestId: quote.requestId,
    };
  }

  let quote;
  try {
    quote = await getLifiQuote({
      fromChain: step.chainFrom,
      fromToken: step.tokenIn,
      fromAmount: resolvedAmountIn,
      fromAddress,
      toChain: step.chainTo,
      toToken: step.tokenOut,
      toAddress: recipientAddress,
    });
  } catch (lifiError) {
    if (step.chainFrom === step.chainTo) throw lifiError;
    const relay = await getRelayQuote({
      fromChain: step.chainFrom,
      fromToken: step.tokenIn,
      fromAmount: resolvedAmountIn,
      fromAddress,
      toChain: step.chainTo,
      toToken: step.tokenOut,
      toAddress: recipientAddress,
    });
    return {
      tx: relay.transactionRequest!,
      outputSymbol: step.tokenOut,
      outputTokenAddress,
      outputDecimals,
      bridgeAdapter: "relay",
      relayRequestId: relay.requestId,
    };
  }
  if (!quote.transactionRequest) {
    throw new OrchestratorError("LI.FI quote returned no transactionRequest", step.id);
  }
  return {
    tx: quote.transactionRequest,
    outputSymbol: step.tokenOut,
    outputTokenAddress,
    outputDecimals,
    bridgeAdapter: "lifi",
  };
}

export async function simulate(chainKey: string, tx: TxRequest, fromAddress: `0x${string}`): Promise<void> {
  const client = createPublicClient({ chain: VIEM_CHAIN[chainKey], transport: alchemyHttp(chainKey) });
  await client.call({ account: fromAddress, to: tx.to, data: tx.data, value: BigInt(tx.value) });
}

/** Server-signed wallets may send several confirmed transactions in one plan.
 * Always allocate from the node's pending nonce, rather than relying on a
 * wallet SDK's stale local nonce snapshot after the preceding confirmation. */
async function pendingNonce(chainKey: string, address: `0x${string}`): Promise<number> {
  const client = createPublicClient({ chain: VIEM_CHAIN[chainKey], transport: alchemyHttp(chainKey) });
  return client.getTransactionCount({ address, blockTag: "pending" });
}

/** A receipt and an immediately following eth_call can briefly observe
 * different state snapshots on an RPC. Before a later plan step spends the
 * just-produced output, wait until that output is observable through the
 * same Alchemy-backed read path. */
async function waitForOutputVisibility(step: PlanStep, result: StepResult, recipient: `0x${string}`): Promise<void> {
  if (result.actualAmountOut <= 0) return;
  const clients = alchemyApiKeys().map((_, index) =>
    createPublicClient({ chain: VIEM_CHAIN[step.chainTo], transport: alchemyHttpForKey(step.chainTo, index) })
  );

  // LI.FI/Relay confirms delivery from its own status service. Before a
  // dependent destination-chain action, also require every configured
  // Alchemy endpoint to see the successful destination receipt. A single
  // stale endpoint returning a valid old balance is not an RPC error, so a
  // fallback transport cannot detect or correct it by itself.
  if (step.chainFrom !== step.chainTo && result.destTxHash) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const receipts = await Promise.all(
        clients.map((client) => client.getTransactionReceipt({ hash: result.destTxHash! }).catch(() => null))
      );
      if (receipts.every((receipt) => receipt?.status === "success")) break;
      if (attempt === 59) {
        throw new OrchestratorError(
          `${step.id}: destination transaction ${result.destTxHash} is confirmed by the bridge but not yet visible on every ${step.chainTo} Alchemy endpoint`,
          step.id,
          result.txHash
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  // A confirmed Aave supply can be followed immediately by a dependent
  // borrow. Alchemy's load-balanced RPC keys do not always expose the new
  // collateral in the same instant as the receipt, so explicitly wait for
  // the real aToken balance instead of skipping receipt-token visibility.
  if (step.action === "protocol_supply") {
    const reserve = await getAaveSupplyApy(step.chainTo, step.tokenOut);
    for (let attempt = 0; attempt < 60; attempt++) {
      const balances = await Promise.all(clients.map(async (client) => {
        const raw = await client.readContract({
          address: reserve.aTokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [recipient],
        });
        return Number(formatUnits(raw, reserve.decimals));
      }));
      if (balances.every((balance) => balance + 1e-12 >= result.actualAmountOut)) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new OrchestratorError(
      `${step.id}: Aave collateral supply is confirmed but its aToken balance is not yet visible through ${step.chainTo} RPC`,
      step.id
    );
  }
  const expected = result.actualAmountOut;
  // outputSymbol is presentation metadata (for example "USDC"). The plan's
  // tokenOut is the canonical contract identifier resolved from live chain
  // state; visibility checks must never try to execute from a display label.
  const isNative = step.tokenOut.toUpperCase() === NATIVE_SYMBOL[step.chainTo];
  const tokenAddress = isNative ? null : resolveTokenReference(step.chainTo, step.tokenOut);
  const decimals = isNative ? 18 : await tokenReferenceDecimals(step.chainTo, step.tokenOut);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const balances = await Promise.all(clients.map(async (client) => {
        if (isNative) return Number(formatUnits(await client.getBalance({ address: recipient }), 18));
        const raw = await client.readContract({ address: tokenAddress!, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
        return Number(formatUnits(raw, decimals));
      }));
      if (balances.every((balance) => balance + 1e-12 >= expected)) return;
    } catch {
      // An unknown output token has no generic balance reader. Its own
      // dependent adapter will still simulate before it can be spent.
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new OrchestratorError(
    `${step.id}: ${result.outputSymbol} output is confirmed but not yet visible through ${step.chainTo} RPC`,
    step.id
  );
}

/**
 * ERC20 inputs need the router contract approved to pull them via
 * transferFrom before the actual swap/deposit tx can succeed — this isn't
 * optional, it's how ERC20 allowances work. Checks current allowance first
 * and only sends an approve() transaction if it's actually insufficient
 * (skips it on repeat calls to the same spender). Simulated before sending,
 * same as every other transaction this orchestrator sends.
 */
async function ensureAllowance(
  chainKey: string,
  tokenAddress: `0x${string}`,
  spender: `0x${string}`,
  amountNeededBaseUnits: bigint,
  account: Account,
  stepId: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const publicClient = createPublicClient({ chain: VIEM_CHAIN[chainKey], transport: alchemyHttp(chainKey) });
  const current = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });
  if (current >= amountNeededBaseUnits) return;

  console.log(`  approving ${spender} to spend ${tokenAddress} (current allowance insufficient)...`);
  onProgress?.({ type: "step_status", stepId, status: "approving", detail: `Approving ${spender} to spend ${tokenAddress}` });
  const { request } = await publicClient.simulateContract({
    account,
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
  });
  const walletClient = createWalletClient({ account, chain: VIEM_CHAIN[chainKey], transport: alchemyHttp(chainKey) });
  const approveHash = await walletClient.writeContract({ ...request, nonce: await pendingNonce(chainKey, account.address) });
  console.log(`  approval tx: ${approveHash} — waiting for confirmation...`);
  onProgress?.({ type: "step_tx", stepId, label: "approval", chainKey, txHash: approveHash });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  if (receipt.status !== "success") {
    throw new Error(`Approval transaction ${approveHash} reverted on-chain`);
  }
  // A receipt can be available a fraction before the RPC node serving the
  // following eth_call has incorporated its state transition. Do not run the
  // dependent router simulation against that stale state; wait until the
  // allowance itself is observable from the same Alchemy-backed client.
  for (let attempt = 0; attempt < 10; attempt++) {
    const observed = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender],
    });
    if (observed >= amountNeededBaseUnits) {
      console.log(`  approval confirmed in block ${receipt.blockNumber}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Approval ${approveHash} confirmed but its allowance is not yet visible through ${chainKey} RPC`);
}

/**
 * Reads how much of outputTokenAddress this specific transaction transferred
 * to `recipient`, by decoding the Transfer logs in its own receipt — not by
 * polling balance before/after (see the file-level comment for why).
 */
export function readActualOutputFromReceipt(
  receiptLogs: Parameters<typeof parseEventLogs>[0]["logs"],
  outputTokenAddress: `0x${string}`,
  recipient: `0x${string}`,
  decimals: number
): number {
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: receiptLogs,
  });
  const toUs = transfers.filter(
    (t) => t.address.toLowerCase() === outputTokenAddress.toLowerCase() && t.args.to.toLowerCase() === recipient.toLowerCase()
  );
  const total = toUs.reduce((sum, t) => sum + t.args.value, 0n);
  return Number(total) / 10 ** decimals;
}

/**
 * custom_call steps don't fit the swap/bridge/protocol_supply shape (no
 * tokenIn amount, no measurable token output — the escape-hatch action type
 * can be calling anything, e.g. a governance vote that moves no tokens at
 * all). Handled as its own path: cap by native value sent, simulate, send,
 * confirm — no Transfer-log output measurement.
 */
async function runCustomCallStep(step: PlanStep, account: Account, onProgress?: ProgressCallback): Promise<StepResult> {
  const valueEth = step.customCallValueEth ?? "0";
  if (!step.customCallTarget || !step.customCallFunction) {
    throw new OrchestratorError("custom_call step missing customCallTarget/customCallFunction", step.id);
  }

  const encoded = encodeCustomCall({
    target: step.customCallTarget,
    functionSignature: step.customCallFunction,
    args: step.customCallArgs ?? [],
    valueEth,
  });

  console.log(`  [${step.id}] simulating custom_call (eth_call)...`);
  onProgress?.({ type: "step_status", stepId: step.id, status: "simulating", detail: `${step.customCallTarget}.${step.customCallFunction}` });
  await simulate(step.chainFrom, { to: encoded.to, data: encoded.data, value: `0x${encoded.value.toString(16)}` }, account.address);
  console.log(`  [${step.id}] simulation OK, no revert`);

  const walletClient = createWalletClient({ account, chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
  onProgress?.({ type: "step_status", stepId: step.id, status: "sending" });
  const txHash = await walletClient.sendTransaction({
    to: encoded.to,
    data: encoded.data,
    value: encoded.value,
    nonce: await pendingNonce(step.chainFrom, account.address),
  });
  console.log(`  [${step.id}] tx sent: ${txHash} — waiting for confirmation...`);
  onProgress?.({ type: "step_tx", stepId: step.id, label: "source", chainKey: step.chainFrom, txHash });

  const publicClient = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
  onProgress?.({ type: "step_status", stepId: step.id, status: "confirming" });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new OrchestratorError(`Transaction ${txHash} reverted on-chain despite passing simulation`, step.id, txHash);
  }
  console.log(`  [${step.id}] confirmed in block ${receipt.blockNumber}`);

  return {
    stepId: step.id,
    txHash,
    resolvedAmountIn: Number(valueEth),
    actualAmountOut: 0,
    outputSymbol: "custom_call",
    gasUsed: receipt.gasUsed.toString(),
  };
}

/**
 * transfer: a plain same-chain send of the signer's own asset to a
 * third-party address — native value transfer or an ERC20 transfer() call,
 * whichever tokenIn calls for. Unlike swap/bridge/protocol_supply, there's
 * nothing to "measure" afterward (no exchange happened) — the amount
 * received by the recipient IS resolvedAmountIn by definition.
 */
async function runTransferStep(
  step: PlanStep,
  resolvedAmountIn: number,
  account: Account,
  onProgress?: ProgressCallback
): Promise<StepResult> {
  if (!step.transferTo) {
    throw new OrchestratorError("transfer step missing transferTo", step.id);
  }
  const isNative = step.tokenIn.toUpperCase() === NATIVE_SYMBOL[step.chainFrom];
  const decimals = isNative ? 18 : await tokenReferenceDecimals(step.chainFrom, step.tokenIn);
  let amountBaseUnits = parseUnits(String(resolvedAmountIn), decimals);

  let tx: { to: `0x${string}`; data: `0x${string}`; value: bigint };
  if (isNative) {
    // A native-token transfer that asks for the wallet's full balance is
    // otherwise self-defeating — that same balance is what pays this
    // transaction's own gas. goalParser only reserves gas when the user
    // explicitly says to (e.g. "keep some for gas"); this is the
    // deterministic backstop that holds regardless of what the plan
    // literally says, same discipline as the targetChain/decimals backstops
    // elsewhere in this codebase. A generous (3x) buffer on top of a live
    // EIP-1559 fee estimate, not a legacy gasPrice snapshot — L2 fees like
    // Polygon's can spike within seconds, and a tight margin here previously
    // failed a real send with "gas required exceeds allowance".
    const publicClient = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
    const balance = await publicClient.getBalance({ address: account.address });
    const maxFeePerGas = await publicClient
      .estimateFeesPerGas()
      .then((f) => f.maxFeePerGas)
      .catch(() => publicClient.getGasPrice());
    const gasReserve = maxFeePerGas * 21000n * 3n;
    if (amountBaseUnits > balance - gasReserve) {
      const clamped = balance - gasReserve;
      if (clamped <= 0n) {
        throw new OrchestratorError(
          `Not enough ${step.tokenIn} on ${step.chainFrom} to cover both this transfer and its own gas`,
          step.id
        );
      }
      amountBaseUnits = clamped;
      resolvedAmountIn = Number(formatUnits(amountBaseUnits, decimals));
    }
    tx = { to: step.transferTo as `0x${string}`, data: "0x", value: amountBaseUnits };
  } else {
    const tokenAddress = resolveTokenReference(step.chainFrom, step.tokenIn);
    if (!tokenAddress) throw new OrchestratorError(`No known address for ${step.tokenIn} on ${step.chainFrom}`, step.id);
    tx = {
      to: tokenAddress,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [step.transferTo as `0x${string}`, amountBaseUnits] }),
      value: 0n,
    };
  }

  console.log(`  [${step.id}] simulating transfer (eth_call)...`);
  onProgress?.({ type: "step_status", stepId: step.id, status: "simulating", detail: `Sending ${resolvedAmountIn} ${step.tokenIn} to ${step.transferTo}` });
  await simulate(step.chainFrom, { to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}` }, account.address);
  console.log(`  [${step.id}] simulation OK, no revert`);

  const walletClient = createWalletClient({ account, chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
  onProgress?.({ type: "step_status", stepId: step.id, status: "sending" });
  const txHash = await walletClient.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    nonce: await pendingNonce(step.chainFrom, account.address),
  });
  console.log(`  [${step.id}] tx sent: ${txHash} — waiting for confirmation...`);
  onProgress?.({ type: "step_tx", stepId: step.id, label: "source", chainKey: step.chainFrom, txHash });

  const publicClient = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
  onProgress?.({ type: "step_status", stepId: step.id, status: "confirming" });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new OrchestratorError(`Transaction ${txHash} reverted on-chain despite passing simulation`, step.id, txHash);
  }
  console.log(`  [${step.id}] confirmed in block ${receipt.blockNumber}`);

  return {
    stepId: step.id,
    txHash,
    resolvedAmountIn,
    actualAmountOut: resolvedAmountIn,
    outputSymbol: step.tokenIn,
    gasUsed: receipt.gasUsed.toString(),
  };
}

async function runStep(step: PlanStep, resolvedAmountIn: number, account: Account, onProgress?: ProgressCallback): Promise<StepResult> {
  // The plan can name a specific source wallet for ANY step (a real bug this
  // originally caught for transfer steps: the confirm UI let you pick ANY
  // execution wallet to "run from" regardless of which wallet the plan
  // actually named as the source — silently executing from the wrong
  // wallet's balance instead of refusing). This is the deterministic
  // backstop that holds even if a caller (runPlan's per-step signer
  // resolution, or a caller bypassing it) gets the wrong account here.
  if (step.transferFrom && step.transferFrom.toLowerCase() !== account.address.toLowerCase()) {
    throw new OrchestratorError(
      `${step.id}: this step's source is ${step.transferFrom}, but execution was requested from ${account.address} — refusing to run a step from the wrong wallet`,
      step.id
    );
  }
  if (step.action === "custom_call") {
    return runCustomCallStep(step, account, onProgress);
  }
  if (step.action === "transfer") {
    return runTransferStep(step, resolvedAmountIn, account, onProgress);
  }

  const isCrossChain = step.chainFrom !== step.chainTo;

  // For a non-transfer step, transferTo optionally redirects the output to a
  // different wallet than the one signing this step (e.g. consolidating
  // several execution wallets into one before a deposit) — see models.ts's
  // doc comment on transferTo. Defaults to the signer's own address, the
  // pre-existing behavior.
  const recipient = (step.transferTo?.toLowerCase() as `0x${string}` | undefined) ?? account.address;

  onProgress?.({ type: "step_status", stepId: step.id, status: "quoting", detail: `Getting a route for ${step.action}` });
  let built = await buildStepTx(step, resolvedAmountIn, account.address, recipient);
  // Native outputs do not emit an ERC20 Transfer log. For an ERC20 -> native
  // same-chain swap, measure the recipient's balance delta and add back the
  // transaction fee when the recipient is also the signer. This keeps
  // output_of() accurate without pretending a native transfer has a log.
  const nativeOutputClient =
    !isCrossChain && built.outputTokenAddress === null
      ? createPublicClient({ chain: VIEM_CHAIN[step.chainTo], transport: alchemyHttp(step.chainTo) })
      : null;
  const nativeOutputBefore = nativeOutputClient ? await nativeOutputClient.getBalance({ address: recipient }) : null;

  const isNativeIn = step.tokenIn.toUpperCase() === NATIVE_SYMBOL[step.chainFrom];
  let inputApproval: { tokenAddress: `0x${string}`; amountNeeded: bigint } | null = null;
  if (!isNativeIn && step.action !== "protocol_withdraw" && step.action !== "protocol_borrow") {
    const tokenInAddress = resolveTokenReference(step.chainFrom, step.tokenIn);
    if (!tokenInAddress) {
      throw new OrchestratorError(`No known address for input token ${step.tokenIn} on ${step.chainFrom}`, step.id);
    }
    const decimals = await tokenReferenceDecimals(step.chainFrom, step.tokenIn);
    const amountNeeded = parseUnits(String(resolvedAmountIn), decimals);
    inputApproval = { tokenAddress: tokenInAddress, amountNeeded };
    await ensureAllowance(step.chainFrom, tokenInAddress, built.approvalSpender ?? built.tx.to, amountNeeded, account, step.id, onProgress);
  }

  // A routed swap can contain an expiry/minimum-output constraint. Approval
  // confirmation may take a block or two, so never send the quote we fetched
  // before that wait: request a fresh route and simulate that exact payload
  // immediately before signing.
  if (step.action === "swap" || step.action === "bridge" || step.action === "cross_chain_swap") {
    built = await buildStepTx(step, resolvedAmountIn, account.address, recipient);
    // A freshly quoted route may use a different router/allowance target. The
    // first call is usually a no-op; this second check guarantees the exact
    // calldata about to be simulated has its required allowance.
    if (inputApproval) {
      await ensureAllowance(
        step.chainFrom,
        inputApproval.tokenAddress,
        built.approvalSpender ?? built.tx.to,
        inputApproval.amountNeeded,
        account,
        step.id,
        onProgress
      );
    }
  }

  console.log(`  [${step.id}] simulating (eth_call)...`);
  onProgress?.({ type: "step_status", stepId: step.id, status: "simulating" });
  await simulate(step.chainFrom, built.tx, account.address);
  console.log(`  [${step.id}] simulation OK, no revert`);

  const walletClient = createWalletClient({ account, chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
  console.log(`  [${step.id}] sending real transaction on ${step.chainFrom}...`);
  onProgress?.({ type: "step_status", stepId: step.id, status: "sending" });
  const txHash = await walletClient.sendTransaction({
    to: built.tx.to,
    data: built.tx.data,
    value: BigInt(built.tx.value),
    nonce: await pendingNonce(step.chainFrom, account.address),
  });
  console.log(`  [${step.id}] tx sent: ${txHash} — waiting for confirmation...`);
  onProgress?.({ type: "step_tx", stepId: step.id, label: "source", chainKey: step.chainFrom, txHash });

  const publicClient = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
  onProgress?.({ type: "step_status", stepId: step.id, status: "confirming" });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new OrchestratorError(`Transaction ${txHash} reverted on-chain despite passing simulation`, step.id, txHash);
  }
  console.log(`  [${step.id}] confirmed in block ${receipt.blockNumber}`);

  let actualAmountOut: number;
  let destTxHash: `0x${string}` | undefined;
  if (isCrossChain) {
    if (built.bridgeAdapter === "relay") {
      if (!built.outputTokenAddress) {
        throw new OrchestratorError(
          "Relay cross-chain step outputs a native token, which this orchestrator can't yet measure (needs an ERC20 Transfer log on the destination tx) — not supported",
          step.id
        );
      }
      console.log(`  [${step.id}] cross-chain step (Relay) — polling /intents/status/v3 for destination-chain delivery...`);
      onProgress?.({ type: "step_status", stepId: step.id, status: "bridging", detail: "Polling Relay for destination-chain delivery" });
      const status = await pollRelayStatus({ requestId: built.relayRequestId! });
      if (status.status !== "DONE" || !status.receivingTxHash) {
        throw new OrchestratorError(
          `Cross-chain delivery did not complete via Relay (status=${status.rawStatus}) — source tx ${txHash} succeeded but funds have not arrived on ${step.chainTo}`,
          step.id
        );
      }
      console.log(`  [${step.id}] destination delivery confirmed: tx ${status.receivingTxHash} on ${step.chainTo} — reading Transfer log...`);
      destTxHash = status.receivingTxHash;
      onProgress?.({ type: "step_tx", stepId: step.id, label: "destination", chainKey: step.chainTo, txHash: status.receivingTxHash });
      const destClient = createPublicClient({ chain: VIEM_CHAIN[step.chainTo], transport: alchemyHttp(step.chainTo) });
      const destReceipt = await destClient.getTransactionReceipt({ hash: status.receivingTxHash });
      actualAmountOut = readActualOutputFromReceipt(destReceipt.logs, built.outputTokenAddress, recipient, built.outputDecimals);
    } else {
      console.log(`  [${step.id}] cross-chain step (LI.FI) — polling /status for destination-chain delivery...`);
      onProgress?.({ type: "step_status", stepId: step.id, status: "bridging", detail: "Polling LI.FI for destination-chain delivery" });
      const status = await pollLifiStatus({
        sourceTxHash: txHash,
        fromChain: step.chainFrom,
        toChain: step.chainTo,
        toTokenDecimals: built.outputDecimals,
      });
      if (status.status !== "DONE" || status.receivedAmount === null) {
        throw new OrchestratorError(
          `Cross-chain delivery did not complete (status=${status.status}, substatus=${status.substatus}) — source tx ${txHash} succeeded but funds have not arrived on ${step.chainTo}`,
          step.id
        );
      }
      console.log(`  [${step.id}] destination delivery confirmed: tx ${status.receivingTxHash} on ${step.chainTo}`);
      if (status.receivingTxHash) {
        destTxHash = status.receivingTxHash;
        onProgress?.({ type: "step_tx", stepId: step.id, label: "destination", chainKey: step.chainTo, txHash: status.receivingTxHash });
      }
      actualAmountOut = status.receivedAmount;
    }
  } else {
    if (built.outputTokenAddress) {
      actualAmountOut = readActualOutputFromReceipt(receipt.logs, built.outputTokenAddress, recipient, built.outputDecimals);
    } else {
      const after = await nativeOutputClient!.getBalance({ address: recipient });
      const gasPaid = recipient.toLowerCase() === account.address.toLowerCase() ? receipt.gasUsed * receipt.effectiveGasPrice : 0n;
      const received = after - nativeOutputBefore! + gasPaid;
      actualAmountOut = Number(formatUnits(received > 0n ? received : 0n, built.outputDecimals));
    }
  }

  return {
    stepId: step.id,
    txHash,
    destTxHash,
    resolvedAmountIn,
    actualAmountOut,
    outputSymbol: built.outputSymbol,
    gasUsed: receipt.gasUsed.toString(),
  };
}

/**
 * Runs every step of a validated plan in order, stopping immediately on the
 * first failure. `onProgress`, if given, receives real-time events as each
 * step moves through simulate/send/confirm/measure — the same data that
 * ends up in the final StepResult, just surfaced as it happens instead of
 * only after the whole plan finishes.
 *
 * `resolveAccount`, if given, looks up the real signer for a step that names
 * a specific source wallet (step.transferFrom) OTHER than `account` — e.g. a
 * goal spanning several of the caller's own execution wallets ("consolidate
 * execution wallet 1, 2, and 3, then deposit into Aave") in ONE confirmed
 * plan, each step signed by whichever wallet it actually names, instead of
 * forcing that into several separate single-wallet plans. Every wallet this
 * can resolve to must itself be one this backend genuinely holds a key for
 * (an execution wallet) — the caller (server.ts) is what enforces that
 * scope, this function just uses whatever it's given. Without resolveAccount
 * (or when a step names no source), every step runs as `account` — the
 * pre-existing single-signer behavior, unchanged.
 */
export async function runPlan(
  plan: ExecutionPlan,
  account: Account,
  onProgress?: ProgressCallback,
  resolveAccount?: (address: string) => Promise<Account>
): Promise<StepResult[]> {
  // Resolve destination protocol assets from live chain state again at
  // execution time. A saved plan may be older than the current protocol
  // registry, and a new wallet need not already hold the destination token.
  const executablePlan = await resolveLiveProtocolTokenReferences(plan);
  const results = new Map<string, StepResult>();
  const ordered: StepResult[] = [];

  for (const step of executablePlan.steps) {
    const signerAccount =
      step.transferFrom && step.transferFrom.toLowerCase() !== account.address.toLowerCase() && resolveAccount
        ? await resolveAccount(step.transferFrom)
        : account;
    const resolvedAmountIn = await resolveAmountIn(step, results, signerAccount);
    console.log(`\n=== Executing ${step.id}: ${step.action} ${resolvedAmountIn} ${step.tokenIn} (${step.chainFrom}) -> ${step.tokenOut} (${step.chainTo}) [signer: ${signerAccount.address}] ===`);
    onProgress?.({
      type: "step_start",
      stepId: step.id,
      action: step.action,
      summary: `${step.action} ${resolvedAmountIn} ${step.tokenIn} (${step.chainFrom}) -> ${step.tokenOut} (${step.chainTo})`,
    });
    try {
      const result = await runStep(step, resolvedAmountIn, signerAccount, onProgress);
      const recipient = (step.transferTo?.toLowerCase() as `0x${string}` | undefined) ?? signerAccount.address;
      await waitForOutputVisibility(step, result, recipient);
      results.set(step.id, result);
      ordered.push(result);
      console.log(`  [${step.id}] done — received ${result.actualAmountOut} ${result.outputSymbol}`);
      onProgress?.({ type: "step_complete", stepId: step.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.({ type: "step_failed", stepId: step.id, error: message });
      throw err;
    }
  }

  return ordered;
}
