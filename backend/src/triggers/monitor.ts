/**
 * Trigger monitor: polls every active trigger on an interval and dispatches
 * by type — no user needs to be present, that's the entire point. Every fire
 * attempt (success or failure) is logged via triggers/store.ts's execution
 * log, so the Automations UI can show real history (tx hash, gas, amounts,
 * error) instead of just a pass/fail dot.
 */
import { getHealthFactor } from "../adapters/aaveHealthFactor.js";
import { getAssetDebt } from "../adapters/aaveYield.js";
import { repayAaveDebt } from "./repay.js";
import { runDcaBuy } from "./dcaBuy.js";
import { OrchestratorError } from "../orchestrator.js";
import { getExecutionAccount } from "../wallets/privy.js";
import { beginAttempt, finishAttempt, listActiveTriggers, recordCheck, recordFire, logExecution, listExecutions, setActive, type Trigger } from "./store.js";
import { getExecutionWalletById } from "../wallets/store.js";
import { evaluateCompletion } from "./completion.js";
import { appendTurn } from "../memory/store.js";
import { publicErrorMessage } from "../errors.js";

/** Deliver material automation outcomes to the chat that created the rule.
 * A monitor may run when the browser is closed, so the durable chat history
 * is the source of truth; the UI can replay or poll it later. */
function notifyChat(trigger: Trigger, content: string): void {
  if (!trigger.chatSessionId) return;
  appendTurn(trigger.accountId, trigger.chatSessionId, "assistant", content, {
    kind: "automation_update",
    triggerId: trigger.triggerId,
  });
}

/**
 * True (and auto-pauses the trigger) if its completionCondition has already
 * been met by real fire history — checked right before a fire, not after,
 * so a trigger stops exactly at its target instead of one fire past it.
 */
async function stopIfComplete(trigger: Trigger, spentToken: string): Promise<boolean> {
  const condition = trigger.config.completionCondition;
  if (!condition) return false;
  const executions = listExecutions(trigger.accountId, trigger.triggerId);
  const status = await evaluateCompletion(condition, executions, spentToken);
  if (!status.met) return false;
  setActive(trigger.accountId, trigger.triggerId, false);
  console.log(`[monitor] trigger ${trigger.triggerId}: completion condition met (${status.progress}) — auto-paused`);
  return true;
}

// Once fired, don't fire again for a while — repaying takes a few blocks to
// reflect in the read health factor, and we don't want to double-spend the
// same breach into repeated repayments before that settles.
const FIRE_COOLDOWN_MS = 10 * 60 * 1000;

async function checkHealthFactor(trigger: Trigger, config: Extract<Trigger["config"], { type: "health_factor" }>): Promise<void> {
  const wallet = getExecutionWalletById(trigger.accountId, trigger.executionWalletId);
  if (!wallet) return; // wallet was deleted or belongs to a different account somehow — skip

  recordCheck(trigger.triggerId);
  if (await stopIfComplete(trigger, config.repayAsset)) return;

  const snapshot = await getHealthFactor(config.chain, wallet.address as `0x${string}`);
  const hf = Number.isFinite(snapshot.healthFactor) ? snapshot.healthFactor : Number.MAX_SAFE_INTEGER;
  console.log(`[monitor] trigger ${trigger.triggerId} (health_factor): hf ${hf} (threshold ${config.threshold})`);

  if (hf >= config.threshold) return;

  const cooldownActive = trigger.lastFiredAt && Date.now() - new Date(trigger.lastFiredAt).getTime() < FIRE_COOLDOWN_MS;
  if (cooldownActive) {
    console.log(`[monitor] trigger ${trigger.triggerId}: breached but still in cooldown, skipping`);
    return;
  }

  try {
    const account = getExecutionAccount(wallet.walletId, wallet.address as `0x${string}`);
    const debt = await getAssetDebt(config.chain, config.repayAsset, wallet.address as `0x${string}`);
    const repayAmount = debt.amount * (config.repayPercent / 100);
    if (repayAmount <= 0) {
      console.log(`[monitor] trigger ${trigger.triggerId}: breached but current ${config.repayAsset} debt is 0 — nothing to repay`);
      return;
    }
    console.log(
      `[monitor] trigger ${trigger.triggerId}: BREACHED (hf=${hf} < ${config.threshold}) — repaying ${config.repayPercent}% of ` +
        `${debt.amount} ${config.repayAsset} debt = ${repayAmount}`
    );
    const result = await repayAaveDebt({ chainKey: config.chain, account, assetSymbol: config.repayAsset, amount: repayAmount });
    recordFire(trigger.triggerId);
    logExecution({
      triggerId: trigger.triggerId,
      accountId: trigger.accountId,
      success: true,
      txHash: result.txHash,
      gasUsed: result.gasUsed,
      amountIn: result.repaidAmount,
      outputSymbol: config.repayAsset,
    });
    notifyChat(trigger, `Automation update — repaid ${result.repaidAmount} ${config.repayAsset} on ${config.chain}. Transaction confirmed: ${result.txHash}`);
    await stopIfComplete(trigger, config.repayAsset);
    console.log(`[monitor] trigger ${trigger.triggerId}: repaid, tx ${result.txHash}`);
  } catch (err) {
    const message = publicErrorMessage(err);
    logExecution({ triggerId: trigger.triggerId, accountId: trigger.accountId, success: false, errorMessage: message });
    notifyChat(trigger, `Automation update — the ${config.chain} health-factor repayment did not complete: ${message}`);
    console.error(`[monitor] trigger ${trigger.triggerId}: repay failed —`, message);
  }
}

/** Default DCA semantics: first buy happens immediately. A caller can opt into
 * an explicit UTC start time or delay; only later buys use intervalMinutes. */
function isDcaDue(config: Extract<Trigger["config"], { type: "dca" }>, lastFiredAt: string | null, createdAt: string): boolean {
  if (!lastFiredAt) {
    if (config.startAfterMinutes !== undefined) {
      return Date.now() - new Date(createdAt).getTime() >= config.startAfterMinutes * 60_000;
    }
    if (!config.timeOfDayUtc) return true;
    const [hh, mm] = config.timeOfDayUtc.split(":").map(Number);
    const now = new Date();
    const scheduledToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm);
    return now.getTime() >= scheduledToday;
  }
  if (config.intervalMinutes) return Date.now() - new Date(lastFiredAt).getTime() >= config.intervalMinutes * 60_000;
  if (!config.timeOfDayUtc) return false;
  const [hh, mm] = config.timeOfDayUtc.split(":").map(Number);
  const now = new Date();
  const scheduledToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm);
  if (now.getTime() < scheduledToday) return false;
  const last = new Date(lastFiredAt);
  const isSameUtcDay =
    last.getUTCFullYear() === now.getUTCFullYear() && last.getUTCMonth() === now.getUTCMonth() && last.getUTCDate() === now.getUTCDate();
  return !isSameUtcDay;
}

async function checkDca(trigger: Trigger, config: Extract<Trigger["config"], { type: "dca" }>, force = false): Promise<void> {
  recordCheck(trigger.triggerId);
  const wallet = getExecutionWalletById(trigger.accountId, trigger.executionWalletId);
  if (!wallet) return;

  if (await stopIfComplete(trigger, config.tokenIn)) return;
  if (!force && !isDcaDue(config, trigger.lastFiredAt, trigger.createdAt)) return;

  console.log(`[monitor] trigger ${trigger.triggerId} (dca): due — buying ${config.amountPerBuy} ${config.tokenIn} of ${config.tokenOut}`);
  try {
    const account = getExecutionAccount(wallet.walletId, wallet.address as `0x${string}`);
    const result = await runDcaBuy(config, account, ({ txHash, error }) => {
      // Retried route failures remain visible to the user, but they are not
      // counted toward a tx_count completion condition.
      const message = publicErrorMessage(error);
      logExecution({ triggerId: trigger.triggerId, accountId: trigger.accountId, success: false, txHash, errorMessage: message });
      notifyChat(trigger, `Automation update — a route attempt for this DCA failed${txHash ? ` after submitting ${txHash}` : " before a transaction was submitted"}: ${message}. Retrying with a fresh route.`);
    });
    recordFire(trigger.triggerId);
    logExecution({
      triggerId: trigger.triggerId,
      accountId: trigger.accountId,
      success: true,
      txHash: result.txHash,
      gasUsed: result.gasUsed,
      amountIn: result.resolvedAmountIn,
      amountOut: result.actualAmountOut,
      outputSymbol: result.outputSymbol,
    });
    notifyChat(
      trigger,
      `Automation update — DCA purchase confirmed on ${config.chain}: spent ${result.resolvedAmountIn} ${config.tokenIn}, received ${result.actualAmountOut} ${result.outputSymbol}. Transaction: ${result.txHash}`
    );
    await stopIfComplete(trigger, config.tokenIn);
    console.log(`[monitor] trigger ${trigger.triggerId}: bought, tx ${result.txHash}`);
  } catch (err) {
    const message = publicErrorMessage(err);
    // A failed attempt still consumes this cadence slot. Without an anchor a
    // just-created immediate DCA would be due again on every monitor pass,
    // which is not what "every N minutes" means and can repeatedly submit a
    // stale route. Success remains separately visible in the execution log.
    recordFire(trigger.triggerId);
    const txHash = err instanceof OrchestratorError ? err.txHash : undefined;
    logExecution({ triggerId: trigger.triggerId, accountId: trigger.accountId, success: false, txHash, errorMessage: message });
    notifyChat(trigger, `Automation update — this DCA purchase failed${txHash ? ` after submitting ${txHash}` : " before an on-chain transaction was submitted"}: ${message}`);
    console.error(`[monitor] trigger ${trigger.triggerId}: dca buy failed —`, message);
  }
}

/** Run one trigger's real condition check and, when due, its real action. */
export async function checkTrigger(trigger: Trigger, options: { force?: boolean } = {}): Promise<void> {
  if (trigger.config.type === "health_factor") {
    await checkHealthFactor(trigger, trigger.config);
  } else if (trigger.config.type === "dca") {
    await checkDca(trigger, trigger.config, options.force);
  }
}

/** The sole entry point for a trigger evaluation. It makes an attempt visible
 * and exclusive before any RPC work starts, then always releases it. Both the
 * background scheduler and the UI's Check now action use this exact path. */
export async function runTriggerAttempt(trigger: Trigger, options: { force?: boolean } = {}): Promise<{ started: boolean }> {
  if (!beginAttempt(trigger.triggerId)) return { started: false };
  try {
    await checkTrigger(trigger, options);
    return { started: true };
  } finally {
    finishAttempt(trigger.triggerId);
  }
}

let loopHandle: ReturnType<typeof setInterval> | null = null;

export function startMonitorLoop(intervalMs = 60_000): void {
  if (loopHandle) return;
  loopHandle = setInterval(() => {
    const triggers = listActiveTriggers();
    for (const trigger of triggers) {
      // One account's slow RPC call must never hold every other account's
      // automation hostage. The durable attempt lease prevents overlapping
      // checks for the same rule even if a user clicks Check now concurrently.
      runTriggerAttempt(trigger)
        .catch((err) => console.error(`[monitor] check failed for ${trigger.triggerId}:`, err));
    }
  }, intervalMs);
  console.log(`[monitor] trigger loop started (every ${intervalMs}ms)`);
}
