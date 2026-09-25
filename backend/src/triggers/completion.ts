/**
 * Completion-condition evaluation: given a trigger's config and its real fire
 * history, decide whether it's done and should stop firing on its own. Pure
 * function over already-stored data (trigger_executions) — no new counters to
 * keep in sync, the execution log is the single source of truth.
 *
 * usd_spent uses each execution's own logged amount directly when the spent
 * token already IS a USD stablecoin (the common "buy $X of Y" DCA shape) —
 * no price lookup needed, exactly correct. For a non-stable spent asset this
 * falls back to a live price lookup and is flagged as an approximation
 * (historical fills happened at their own historical price, which isn't
 * stored) — same "advisory, honest about its own limits" spirit as the
 * review panel and the knowledge base, never silently wrong.
 */
import type { CompletionCondition } from "./types.js";
import type { TriggerExecution } from "./store.js";
import { getUsdPrice } from "../adapters/priceUsd.js";

const STABLECOINS = new Set(["USDC", "USDT", "DAI", "USDC.E", "USDBC"]);

export interface CompletionStatus {
  met: boolean;
  /** Human-readable progress, e.g. "3 / 10 buys" — null when there's no completionCondition to report against. */
  progress: string | null;
}

export async function evaluateCompletion(
  condition: CompletionCondition | null,
  executions: TriggerExecution[],
  spentToken: string
): Promise<CompletionStatus> {
  if (!condition) return { met: false, progress: null };

  const successful = executions.filter((e) => e.success);

  switch (condition.type) {
    case "tx_count": {
      const done = successful.length;
      return { met: done >= condition.count, progress: `${done} / ${condition.count} fires` };
    }
    case "time_elapsed": {
      if (successful.length === 0) return { met: false, progress: `0 / ${condition.days} days elapsed` };
      const first = successful[successful.length - 1]; // oldest — executions are newest-first from listExecutions
      const elapsedDays = (Date.now() - new Date(first.firedAt).getTime()) / (1000 * 60 * 60 * 24);
      return {
        met: elapsedDays >= condition.days,
        progress: `${Math.floor(elapsedDays)} / ${condition.days} days elapsed`,
      };
    }
    case "token_amount_spent": {
      // amountIn on every execution row for this trigger is always the same
      // spent asset (config.tokenIn) — no per-row filtering needed.
      const spent = successful.reduce((sum, e) => sum + (e.amountIn ?? 0), 0);
      return {
        met: spent >= condition.amount,
        progress: `${spent.toFixed(4)} / ${condition.amount} ${condition.token} spent`,
      };
    }
    case "usd_spent": {
      const totalTokenSpent = successful.reduce((sum, e) => sum + (e.amountIn ?? 0), 0);
      let usdSpent: number;
      let approximate = false;
      if (STABLECOINS.has(spentToken.toUpperCase())) {
        usdSpent = totalTokenSpent; // 1:1, exact — no price lookup needed
      } else {
        approximate = true;
        try {
          const price = await getUsdPrice(spentToken);
          usdSpent = totalTokenSpent * price; // approximation: today's price applied to historical fills
        } catch {
          // No live price available — can't evaluate this condition right now, don't
          // false-negative it into "never complete."
          return { met: false, progress: `spent amount unknown (no live price for ${spentToken})` };
        }
      }
      return {
        met: usdSpent >= condition.amountUsd,
        progress: `$${usdSpent.toFixed(2)} / $${condition.amountUsd}${approximate ? " (approx, current price)" : ""} spent`,
      };
    }
  }
}
