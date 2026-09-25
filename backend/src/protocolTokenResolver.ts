/**
 * Resolves protocol assets from the protocol's live on-chain registry.
 *
 * A destination token is often absent from a new wallet by definition. Wallet
 * holdings therefore cannot be the authority for a route such as
 * Base ETH -> Arbitrum WETH -> Aave. For Aave steps, resolve the reserve from
 * Pool.getReservesList/getReserveData and ERC-20 ABI metadata on every call,
 * then propagate that canonical address through output_of() dependencies.
 */
import type { ExecutionPlan } from "./models.js";
import { getAaveBorrowMarket, getAaveSupplyApy } from "./adapters/aaveYield.js";
import { isContractTokenReference } from "./tokenReference.js";

const OUTPUT_OF_RE = /^output_of\(([^)]+)\)$/;

export async function resolveLiveProtocolTokenReferences(plan: ExecutionPlan): Promise<ExecutionPlan> {
  const steps = plan.steps.map((step) => ({ ...step }));

  for (const step of steps) {
    if (!step.action.startsWith("protocol_") || step.protocol?.toLowerCase() !== "aave") continue;
    const chain = step.chainTo;
    const reference = isContractTokenReference(step.tokenOut) ? step.tokenOut : step.tokenOut || step.tokenIn;
    const reserve = step.action === "protocol_borrow"
      ? await getAaveBorrowMarket(chain, reference)
      : await getAaveSupplyApy(chain, reference);
    step.tokenIn = reserve.underlyingAddress;
    step.tokenOut = reserve.underlyingAddress;
  }

  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    const match = OUTPUT_OF_RE.exec(step.amountIn);
    if (!match) continue;
    const source = byId.get(match[1]);
    if (!source || source.chainTo.toLowerCase() !== step.chainFrom.toLowerCase()) continue;
    if (isContractTokenReference(step.tokenIn)) source.tokenOut = step.tokenIn;
    else if (isContractTokenReference(source.tokenOut)) step.tokenIn = source.tokenOut;
  }

  return { ...plan, steps };
}
