/**
 * Read-only same-input comparison for Enso and OKX DEX routes.
 *
 * Required local env values:
 * SWAP_COMPARISON_CHAIN, SWAP_COMPARISON_WALLET,
 * SWAP_COMPARISON_TOKEN_IN, SWAP_COMPARISON_TOKEN_OUT,
 * SWAP_COMPARISON_AMOUNT and optionally SWAP_COMPARISON_RUNS (default 3).
 *
 * The runner obtains fresh route calldata from each provider then simulates it
 * against Alchemy. It never signs or broadcasts, so it is safe to use as the
 * pre-flight test before the real >=$0.5 controlled-wallet execution.
 */
import "dotenv/config";
import { getAddress } from "viem";
import { getEnsoRoute } from "./adapters/enso.js";
import { getOkxDexSwapRoute } from "./adapters/okxDex.js";
import { simulate } from "./orchestrator.js";
import { NATIVE_PLACEHOLDER_EEEE } from "./tokenRegistry.js";
import { resolveTokenReference, tokenReferenceDecimals } from "./tokenReference.js";

type Provider = "enso" | "okx";
type Attempt = { provider: Provider; run: number; elapsedMs: number; ok: boolean; error?: string };

function displayError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // viem includes full calldata in a simulation error. That is useful for a
  // debugger, but it makes a provider-stability report unreadable.
  return message.split("\n\nRaw Call Arguments:")[0];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for the provider comparison`);
  return value;
}

async function routeAndSimulate(provider: Provider, config: {
  chain: string;
  wallet: `0x${string}`;
  tokenIn: string;
  tokenOut: string;
  amount: number;
}): Promise<void> {
  if (provider === "okx") {
    const route = await getOkxDexSwapRoute({
      chainKey: config.chain,
      fromAddress: config.wallet,
      tokenIn: config.tokenIn,
      tokenOut: config.tokenOut,
      amountIn: config.amount,
    });
    await simulate(config.chain, route.transactionRequest, config.wallet);
    return;
  }

  const outputAddress = resolveTokenReference(config.chain, config.tokenOut, NATIVE_PLACEHOLDER_EEEE);
  if (!outputAddress) throw new Error(`No address is available for ${config.tokenOut} on ${config.chain}`);
  const route = await getEnsoRoute({
    chainKey: config.chain,
    fromAddress: config.wallet,
    tokenInSymbol: config.tokenIn,
    tokenOutAddress: outputAddress,
    tokenOutDecimals: await tokenReferenceDecimals(config.chain, config.tokenOut),
    amountIn: config.amount,
  });
  await simulate(config.chain, route.transactionRequest, config.wallet);
}

async function main(): Promise<void> {
  const config = {
    chain: required("SWAP_COMPARISON_CHAIN"),
    wallet: getAddress(required("SWAP_COMPARISON_WALLET")) as `0x${string}`,
    tokenIn: required("SWAP_COMPARISON_TOKEN_IN"),
    tokenOut: required("SWAP_COMPARISON_TOKEN_OUT"),
    amount: Number(required("SWAP_COMPARISON_AMOUNT")),
  };
  if (!Number.isFinite(config.amount) || config.amount <= 0) throw new Error("SWAP_COMPARISON_AMOUNT must be a positive decimal amount");
  const runs = Number(process.env.SWAP_COMPARISON_RUNS ?? 3);
  const attempts: Attempt[] = [];
  for (const provider of ["enso", "okx"] as const) {
    for (let run = 1; run <= runs; run++) {
      const startedAt = Date.now();
      try {
        await routeAndSimulate(provider, config);
        attempts.push({ provider, run, elapsedMs: Date.now() - startedAt, ok: true });
      } catch (err) {
        attempts.push({ provider, run, elapsedMs: Date.now() - startedAt, ok: false, error: displayError(err) });
      }
    }
  }
  const summary = Object.fromEntries((['enso', 'okx'] as const).map((provider) => {
    const providerAttempts = attempts.filter((item) => item.provider === provider);
    const successful = providerAttempts.filter((item) => item.ok);
    const medianMs = successful.length
      ? [...successful].map((item) => item.elapsedMs).sort((a, b) => a - b)[Math.floor(successful.length / 2)]
      : null;
    return [provider, { successCount: successful.length, total: providerAttempts.length, medianMs }];
  }));
  console.log(JSON.stringify({ config: { ...config, wallet: config.wallet }, summary, attempts }, null, 2));
  if (attempts.some((item) => !item.ok)) process.exitCode = 1;
}

void main();
