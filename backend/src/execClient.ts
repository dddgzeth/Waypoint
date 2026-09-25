/**
 * Client-signed execution: the counterpart to orchestrator.ts's server-signed
 * path, for a plan whose source is the user's own LINKED wallet — a wallet
 * this backend has never held a key for (only Privy execution wallets are
 * signable server-side). Same real safety properties as orchestrator.ts's
 * path (every tx simulated before it's ever signed, ERC20 approvals resolved
 * before the main tx, real receipt confirmation, real output measurement via
 * the tx's own Transfer logs / bridge status polling) — the only difference
 * is WHO signs: the browser wallet extension via eth_sendTransaction, not a
 * viem WalletClient holding a private key on this server.
 *
 * Three-call protocol per step, driven by the frontend:
 *   1. buildClientStep()   -> an unsigned tx ready to sign, OR (if an ERC20
 *      allowance is missing) an approvalTx to sign+confirm FIRST — a fresh
 *      eth_call simulate of the main tx would revert without it, so the
 *      caller re-invokes buildClientStep() after the approval lands to get
 *      the real, simulated main tx.
 *   2. (frontend signs+sends via window.ethereum, gets a real txHash back)
 *   3. confirmClientStep() -> waits for the real receipt, measures the real
 *      output, returns the same StepResult shape orchestrator.ts produces —
 *      so the frontend's rendering code doesn't need to know which path ran.
 *
 * Deliberately does NOT modify orchestrator.ts's existing runStep/runPlan —
 * those are the already-proven execution-wallet path (Privy/EXECUTOR key,
 * hands-free execution). This reuses their internal building blocks
 * (buildStepTx, simulate, readActualOutputFromReceipt, now exported) without
 * changing their behavior, so the tested path stays untouched.
 */
import { createPublicClient, erc20Abi, maxUint256, encodeFunctionData, formatUnits } from "viem";
import type { PlanStep } from "./models.js";
import { VIEM_CHAIN, NATIVE_SYMBOL } from "./tokenRegistry.js";
import { alchemyHttp } from "./adapters/alchemyTransport.js";
import { pollLifiStatus } from "./adapters/lifi.js";
import { pollRelayStatus } from "./adapters/relay.js";
import { encodeCustomCall } from "./customCall/execute.js";
import { OrchestratorError, buildStepTx, simulate, readActualOutputFromReceipt, type StepResult, type TxRequest } from "./orchestrator.js";
import { resolveTokenReference, tokenReferenceDecimals } from "./tokenReference.js";

export interface ClientStepBuild {
  tx: TxRequest;
  approvalTx: TxRequest | null;
  outputSymbol: string;
  outputTokenAddress: `0x${string}` | null;
  outputDecimals: number;
  bridgeAdapter?: "lifi" | "relay";
  relayRequestId?: string;
  resolvedAmountIn: number;
}

async function buildApprovalTxIfNeeded(
  chainKey: string,
  tokenAddress: `0x${string}`,
  spender: `0x${string}`,
  amountNeededBaseUnits: bigint,
  ownerAddress: `0x${string}`
): Promise<TxRequest | null> {
  const publicClient = createPublicClient({ chain: VIEM_CHAIN[chainKey], transport: alchemyHttp(chainKey) });
  const current = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: [ownerAddress, spender],
  });
  if (current >= amountNeededBaseUnits) return null;
  return {
    to: tokenAddress,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }),
    value: "0x0",
  };
}

/**
 * Builds the next unsigned tx for a step given the (linked wallet) address
 * it'll run from. Mirrors orchestrator.ts's transfer/custom_call/swap-bridge-
 * protocol_supply branches exactly, just without ever holding a signing key —
 * every tx here is real and simulated (or, for a required approval, deferred
 * until that approval is confirmed and this is called again).
 */
export async function buildClientStep(
  step: PlanStep,
  resolvedAmountIn: number,
  fromAddress: `0x${string}`
): Promise<ClientStepBuild> {
  if (step.transferFrom && step.transferFrom.toLowerCase() !== fromAddress.toLowerCase()) {
    throw new OrchestratorError(
      `${step.id}: this step's source is ${step.transferFrom}, but building was requested for ${fromAddress}`,
      step.id
    );
  }

  if (step.action === "custom_call") {
    if (!step.customCallTarget || !step.customCallFunction) {
      throw new OrchestratorError("custom_call step missing customCallTarget/customCallFunction", step.id);
    }
    const encoded = encodeCustomCall({
      target: step.customCallTarget,
      functionSignature: step.customCallFunction,
      args: step.customCallArgs ?? [],
      valueEth: step.customCallValueEth ?? "0",
    });
    const tx: TxRequest = { to: encoded.to, data: encoded.data, value: `0x${encoded.value.toString(16)}` as `0x${string}` };
    await simulate(step.chainFrom, tx, fromAddress);
    return {
      tx,
      approvalTx: null,
      outputSymbol: "custom_call",
      outputTokenAddress: null,
      outputDecimals: 18,
      resolvedAmountIn: Number(step.customCallValueEth ?? "0"),
    };
  }

  if (step.action === "transfer") {
    if (!step.transferTo) throw new OrchestratorError("transfer step missing transferTo", step.id);
    const isNative = step.tokenIn.toUpperCase() === NATIVE_SYMBOL[step.chainFrom];
    const decimals = isNative ? 18 : await tokenReferenceDecimals(step.chainFrom, step.tokenIn);
    let amountBaseUnits = BigInt(Math.round(resolvedAmountIn * 10 ** decimals));
    let finalResolvedAmountIn = resolvedAmountIn;
    let tx: TxRequest;
    if (isNative) {
      // Same gas-reserve safety clamp as orchestrator.ts's runTransferStep —
      // a full-balance native send would otherwise leave nothing to pay this
      // same transaction's own gas.
      const publicClient = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
      const balance = await publicClient.getBalance({ address: fromAddress });
      const maxFeePerGas = await publicClient
        .estimateFeesPerGas()
        .then((f) => f.maxFeePerGas)
        .catch(() => publicClient.getGasPrice());
      const gasReserve = maxFeePerGas * 21000n * 3n;
      if (amountBaseUnits > balance - gasReserve) {
        const clamped = balance - gasReserve;
        if (clamped <= 0n) {
          throw new OrchestratorError(`Not enough ${step.tokenIn} on ${step.chainFrom} to cover both this transfer and its own gas`, step.id);
        }
        amountBaseUnits = clamped;
        finalResolvedAmountIn = Number(formatUnits(amountBaseUnits, decimals));
      }
      tx = { to: step.transferTo as `0x${string}`, data: "0x", value: `0x${amountBaseUnits.toString(16)}` as `0x${string}` };
    } else {
      const tokenAddress = resolveTokenReference(step.chainFrom, step.tokenIn);
      if (!tokenAddress) throw new OrchestratorError(`No known address for ${step.tokenIn} on ${step.chainFrom}`, step.id);
      tx = {
        to: tokenAddress,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [step.transferTo as `0x${string}`, amountBaseUnits] }),
        value: "0x0",
      };
    }
    await simulate(step.chainFrom, tx, fromAddress);
    return { tx, approvalTx: null, outputSymbol: step.tokenIn, outputTokenAddress: null, outputDecimals: decimals, resolvedAmountIn: finalResolvedAmountIn };
  }

  // swap / bridge / cross_chain_swap / protocol_supply / protocol_borrow — same adapter-built tx
  // orchestrator.ts's server-signed path uses, just not simulated/returned
  // until any required approval is confirmed.
  const built = await buildStepTx(step, resolvedAmountIn, fromAddress);
  const isNativeIn = step.tokenIn.toUpperCase() === NATIVE_SYMBOL[step.chainFrom];
  if (!isNativeIn && step.action !== "protocol_borrow") {
    const tokenInAddress = resolveTokenReference(step.chainFrom, step.tokenIn);
    if (!tokenInAddress) throw new OrchestratorError(`No known address for input token ${step.tokenIn} on ${step.chainFrom}`, step.id);
    const decimals = await tokenReferenceDecimals(step.chainFrom, step.tokenIn);
    const amountNeeded = BigInt(Math.round(resolvedAmountIn * 10 ** decimals));
    const approvalTx = await buildApprovalTxIfNeeded(step.chainFrom, tokenInAddress, built.tx.to, amountNeeded, fromAddress);
    if (approvalTx) {
      return {
        tx: built.tx,
        approvalTx,
        outputSymbol: built.outputSymbol,
        outputTokenAddress: built.outputTokenAddress,
        outputDecimals: built.outputDecimals,
        bridgeAdapter: built.bridgeAdapter,
        relayRequestId: built.relayRequestId,
        resolvedAmountIn,
      };
    }
  }
  await simulate(step.chainFrom, built.tx, fromAddress);
  return {
    tx: built.tx,
    approvalTx: null,
    outputSymbol: built.outputSymbol,
    outputTokenAddress: built.outputTokenAddress,
    outputDecimals: built.outputDecimals,
    bridgeAdapter: built.bridgeAdapter,
    relayRequestId: built.relayRequestId,
    resolvedAmountIn,
  };
}

/** Waits for a real receipt — used to confirm an approval tx has landed before the caller re-requests the main tx. */
export async function waitForClientTx(chainKey: string, txHash: `0x${string}`): Promise<{ success: boolean; gasUsed: string }> {
  const publicClient = createPublicClient({ chain: VIEM_CHAIN[chainKey], transport: alchemyHttp(chainKey) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { success: receipt.status === "success", gasUsed: receipt.gasUsed.toString() };
}

/** Waits for the main tx's real receipt, then measures the real output — same technique as orchestrator.ts's server-signed path (Transfer-log decoding same-chain, bridge status polling cross-chain). */
export async function confirmClientStep(
  step: PlanStep,
  built: ClientStepBuild,
  txHash: `0x${string}`,
  fromAddress: `0x${string}`
): Promise<StepResult> {
  const publicClient = createPublicClient({ chain: VIEM_CHAIN[step.chainFrom], transport: alchemyHttp(step.chainFrom) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new OrchestratorError(`Transaction ${txHash} reverted on-chain despite passing simulation`, step.id);
  }

  if (step.action === "transfer") {
    return {
      stepId: step.id,
      txHash,
      resolvedAmountIn: built.resolvedAmountIn,
      actualAmountOut: built.resolvedAmountIn,
      outputSymbol: built.outputSymbol,
      gasUsed: receipt.gasUsed.toString(),
    };
  }
  if (step.action === "custom_call") {
    return {
      stepId: step.id,
      txHash,
      resolvedAmountIn: built.resolvedAmountIn,
      actualAmountOut: 0,
      outputSymbol: "custom_call",
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  const isCrossChain = step.chainFrom !== step.chainTo;
  let actualAmountOut: number;
  let destTxHash: `0x${string}` | undefined;
  if (isCrossChain) {
    if (built.bridgeAdapter === "relay") {
      if (!built.outputTokenAddress) {
        throw new OrchestratorError("Relay cross-chain step outputs a native token, which can't yet be measured — not supported", step.id);
      }
      const status = await pollRelayStatus({ requestId: built.relayRequestId! });
      if (status.status !== "DONE" || !status.receivingTxHash) {
        throw new OrchestratorError(
          `Cross-chain delivery did not complete via Relay (status=${status.rawStatus}) — source tx ${txHash} succeeded but funds have not arrived on ${step.chainTo}`,
          step.id
        );
      }
      destTxHash = status.receivingTxHash;
      const destClient = createPublicClient({ chain: VIEM_CHAIN[step.chainTo], transport: alchemyHttp(step.chainTo) });
      const destReceipt = await destClient.getTransactionReceipt({ hash: status.receivingTxHash });
      actualAmountOut = readActualOutputFromReceipt(destReceipt.logs, built.outputTokenAddress, fromAddress, built.outputDecimals);
    } else {
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
      if (status.receivingTxHash) destTxHash = status.receivingTxHash;
      actualAmountOut = status.receivedAmount;
    }
  } else {
    actualAmountOut = readActualOutputFromReceipt(receipt.logs, built.outputTokenAddress!, fromAddress, built.outputDecimals);
  }

  return {
    stepId: step.id,
    txHash,
    destTxHash,
    resolvedAmountIn: built.resolvedAmountIn,
    actualAmountOut,
    outputSymbol: built.outputSymbol,
    gasUsed: receipt.gasUsed.toString(),
  };
}
