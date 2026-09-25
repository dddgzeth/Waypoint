/**
 * One-time seed for the execution knowledge base (plan-finals-v2.md §1).
 * Every entry here maps to a real bug this project actually hit and fixed
 * this session (§1.1), or a real external data source (§1.2) — not
 * hypothetical content. Run with `npx tsx src/knowledge/seed.ts`. Safe to
 * re-run: clears the table first rather than appending duplicates.
 */
import "dotenv/config";
import { getDb } from "../accounts/store.js";
import { insertKnowledgeEntry, countKnowledgeEntries, ensureKnowledgeSchema } from "./store.js";

function clearExisting(): void {
  ensureKnowledgeSchema();
  const db = getDb();
  db.exec(`DELETE FROM execution_knowledge; DELETE FROM execution_knowledge_fts;`);
}

const EXECUTION_GOTCHAS: Array<{ title: string; keywords: string; body: string }> = [
  {
    title: "L2 gas price volatility on native-token transfers",
    keywords: "gas price polygon l2 native transfer eip-1559 fee spike allowance",
    body: "Polygon (and L2s generally) can have gas price spike within seconds. A native-token transfer that sends its full balance minus a gas reserve must use a live EIP-1559 fee estimate with a generous buffer (~3x), never a stale gasPrice snapshot — a real Polygon transfer once failed with \"gas required exceeds allowance\" from exactly this.",
  },
  {
    title: "A wallet with zero native balance can't pay gas for anything",
    keywords: "zero balance native gas erc20 transfer fund seed rpc read-after-write polling",
    body: "A wallet with zero native token can't afford gas even to move an ERC20 it holds — it needs a small native-token top-up from a funded wallet first. That top-up's confirmation isn't always visible on the very next RPC read (load-balanced RPC providers aren't guaranteed read-after-write consistent) — poll balance until it reflects the top-up rather than assuming one read is enough.",
  },
  {
    title: "Aave aToken decimals always match the underlying asset",
    keywords: "aave atoken decimals usdc weth precision supply deposit",
    body: "An Aave V3 aToken's decimals always equal its underlying asset's decimals — never assume a fixed value like 6 (USDC's decimals). A real bug here hard-coded 6 and silently corrupted WETH deposit amounts (18 decimals).",
  },
  {
    title: "Cross-chain arrival must be confirmed by the bridge's own status, not a balance diff",
    keywords: "bridge relayer solver status lifi relay cross-chain arrival balance diff intent",
    body: "Cross-chain arrival is a separate transaction minted by the bridge's own relayer/solver — never infer it by diffing the destination wallet's balance before/after (unrelated activity on that wallet collides with the comparison). Poll the bridge's own status endpoint (LI.FI's /status, Relay's /intents/status/v3) until it reports delivered, then read the real received amount from that transaction's own Transfer log.",
  },
  {
    title: "Cross-lingual crypto slang for currency amounts and token names",
    keywords: "usd dollar slang u kuai dabing chinese currency denomination amount token nickname bitcoin",
    body: "Crypto communities use cross-lingual shorthand for both amounts and token names — e.g. Chinese \"U\" or \"刀\" both commonly mean USDT/USD, and \"大饼\" (\"big pancake\", from the coin's round shape) is common Chinese crypto slang for Bitcoin. Read amount and token phrasing for what it actually means in context rather than requiring an explicit $, \"USD\", or ticker symbol marker; a regex trying to enumerate every such notation was tried and deleted here because it can't cover every phrasing and it overrides a correct model reading.",
  },
  {
    title: "Dollar-denominated amounts need a real live price, not a memorized one",
    keywords: "usd price conversion eth token live price stale training data",
    body: "A dollar-denominated amount (e.g. \"~$4 of ETH\") must be converted using a real, live price lookup — a model estimating the price from its own training data can be stale or wrong (a real bug here converted \"$4\" into an amount worth roughly half that). Always fetch a live price and use it as a given fact; if the amount was already token-denominated, use it as given without any conversion.",
  },
  {
    title: "Spam/phishing token filtering heuristics",
    keywords: "spam token phishing scam filter url airdrop heuristic",
    body: "Some ERC20 tokens that show up in a wallet's holdings are spam/phishing tokens (a URL embedded in the token name/symbol, or unsolicited \"claim your airdrop\" style naming) — these get filtered out of the real balance list before being shown or planned against. If asked, explain that a token was filtered for this reason rather than silently omitting it with no explanation.",
  },
];

const DATA_SOURCES: Array<{ title: string; keywords: string; body: string }> = [
  {
    title: "DefiLlama — TVL, yields, stablecoins, DEX volume, fees, bridge flows, raises",
    keywords: "defillama tvl yield apy stablecoin dex volume fees bridge raises defillama.com",
    body: "defillama.com is DeFi's standard TVL aggregator, spanning nearly every chain and protocol. Beyond TVL it also covers Yields (real-time APY ranking across protocols/pools), Stablecoins (supply and depeg monitoring), DEX volume, protocol fees/revenue, cross-chain bridge flow, and funding-round tracking (Raises). Has a free public API (api.llama.fi), well-structured and widely used — its Yields API is worth a real live integration to extend yield comparisons beyond Aave-only.",
  },
  {
    title: "RootData — project/funding/team database",
    keywords: "rootdata project funding investor team ecosystem rootdata.com",
    body: "rootdata.com is a crypto project/investment database — project background, funding rounds, investors, team, ecosystem classification. The right source for \"who built this project, how much did they raise, what ecosystem is it part of\" questions.",
  },
  {
    title: "DeBank — multi-chain wallet position aggregator",
    keywords: "debank wallet position portfolio multi-chain aggregator debank.com",
    body: "debank.com aggregates one address's positions across every protocol and chain into a single view — the reference for \"what does this wallet actually hold everywhere.\"",
  },
  {
    title: "Dune Analytics — SQL-queryable on-chain data",
    keywords: "dune analytics sql query dashboard on-chain data dune.com",
    body: "dune.com lets on-chain data be queried with SQL, with a large community-maintained library of dashboards — almost any specific on-chain metric already has a query someone's built.",
  },
  {
    title: "L2Beat — L2 security/decentralization ratings",
    keywords: "l2beat rollup security decentralization stage tvl l2beat.com",
    body: "l2beat.com rates Ethereum L2s on security/decentralization (Stage 0/1/2) plus TVL tracking — the standard reference for how trust-minimized a given L2 actually is.",
  },
  {
    title: "Token Terminal — protocol financial fundamentals",
    keywords: "token terminal revenue fees fundamentals protocol tokenterminal.com",
    body: "tokenterminal.com covers protocol financial fundamentals (revenue, fees) — more \"does this protocol actually make money\" than a pure TVL number.",
  },
  {
    title: "Nansen / Arkham — address labeling and fund-flow intelligence",
    keywords: "nansen arkham smart money address label fund flow tracking",
    body: "Nansen and Arkham Intelligence provide address labeling and fund-flow intelligence (\"smart money\" tracking, real-world identity behind an address) — mostly institutional/security-analysis use cases.",
  },
  {
    title: "CoinGecko / CoinMarketCap — price and market cap data",
    keywords: "coingecko coinmarketcap price market cap cmc",
    body: "Standard price and market-cap data sources; CoinMarketCap is already the live integration this project uses for USD pricing (priceUsd.ts).",
  },
  {
    title: "DeFiSafety / Immunefi — protocol security scoring and bug bounties",
    keywords: "defisafety immunefi audit security score bug bounty",
    body: "DeFiSafety and Immunefi cover protocol security scoring and bug-bounty coverage — the reference for \"has this protocol been audited, is it safe.\"",
  },
  {
    title: "Chain block explorers — Etherscan/Basescan/Arbiscan/Polygonscan",
    keywords: "etherscan basescan arbiscan polygonscan block explorer transaction",
    body: "Per-chain block explorers for raw transaction/contract lookups — already a real, live integration in this project (ETHERSCAN_API_KEY).",
  },
];

async function main(): Promise<void> {
  clearExisting();
  for (const g of EXECUTION_GOTCHAS) {
    insertKnowledgeEntry("execution_gotcha", g.title, g.keywords, g.body);
  }
  for (const d of DATA_SOURCES) {
    insertKnowledgeEntry("data_source", d.title, d.keywords, d.body);
  }
  console.log(`Seeded ${countKnowledgeEntries()} execution knowledge entries.`);
}

main();
