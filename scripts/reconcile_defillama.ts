/**
 * Reconcile DefiLlama's view of Loopscale deposits against our own accounting.
 *
 * Left side  — the real DefiLlama adapter (projects/loopscale in DefiLlama-Adapters),
 *              loaded from a local checkout and executed as-is, so we're testing the
 *              exact code DefiLlama runs (including the deployed pricing-adapters
 *              service it calls).
 * Right side — the latest `historical_balances` snapshot served by the Markets
 *              service at GET /tvl/balances (written to the DB every 5 minutes
 *              by arrakis' refresh_historical_market_tvl_stats).
 *
 * Both sides are mint -> native-unit balance maps of decompiled deposits
 * (collateral + idle lending capital). We value both with DefiLlama's public
 * coins API so the comparison uses one consistent price source, then fail if
 * they diverge past the configured thresholds.
 *
 * Env:
 *   DEFILLAMA_ADAPTERS_DIR   path to a DefiLlama-Adapters checkout with node_modules
 *   LOOPSCALE_MARKETS_URL    Markets service base url (defaults to the tars load balancer;
 *                            the Cloud Run url no longer accepts direct traffic)
 *   SOLANA_RPC               RPC url used by the adapter (SOLANA_RPC_URL also accepted)
 *   TOTAL_DIVERGENCE_PCT     fail when totals diverge more than this (default 5)
 *   MINT_DIVERGENCE_USD      fail when a single mint diverges more than this (default 250000)
 *   SNAPSHOT_MAX_AGE_MIN     fail when the snapshot is older than this (default 30)
 *
 * Flags:
 *   --llama-only             skip the Markets side; just print the adapter's priced output
 */

import * as path from 'path';

const LLAMA_COINS_API = 'https://coins.llama.fi/prices/current/';
const PRICE_CHUNK_SIZE = 25;

// Direct Cloud Run url for the markets service (project bridgesplit-backend,
// us-central1). The public tars.loopscale.com edge fronts the same service but
// rejects requests without beta access, so the reconciler skips it.
const DEFAULT_MARKETS_URL = 'https://tars.loopscale.com/v1/markets';

const TOTAL_DIVERGENCE_PCT = Number(process.env.TOTAL_DIVERGENCE_PCT || 5);
const MINT_DIVERGENCE_USD = Number(process.env.MINT_DIVERGENCE_USD || 250_000);
const SNAPSHOT_MAX_AGE_MIN = Number(process.env.SNAPSHOT_MAX_AGE_MIN || 30);

type BalanceMap = Record<string, bigint>;

interface CoinPrice {
  price: number;
  decimals: number;
  symbol: string;
}

async function getLlamaAdapterDeposits(adaptersDir: string): Promise<BalanceMap> {
  // The adapter reads SOLANA_RPC; accept SOLANA_RPC_URL as an alias so this
  // script and the pricing service can share one env file.
  if (!process.env.SOLANA_RPC && process.env.SOLANA_RPC_URL) {
    process.env.SOLANA_RPC = process.env.SOLANA_RPC_URL;
  }

  const adapterPath = path.join(adaptersDir, 'projects', 'loopscale', 'index.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const adapter = require(adapterPath);

  const balances: BalanceMap = {};
  const fakeApi = {
    addTokens(mints: string[], amounts: (bigint | string | number)[]) {
      mints.forEach((mint, i) => {
        balances[mint] = (balances[mint] ?? 0n) + BigInt(amounts[i]);
      });
    },
    addToken(mint: string, amount: bigint | string | number) {
      this.addTokens([mint], [amount]);
    },
  };

  await adapter.solana.tvl(fakeApi);
  return balances;
}

interface DbSnapshot {
  balances: BalanceMap;
  timestamp: number;
}

async function getLoopscaleDeposits(marketsUrl: string): Promise<DbSnapshot> {
  const res = await fetch(`${marketsUrl.replace(/\/$/, '')}/tvl/balances`);
  if (!res.ok) {
    throw new Error(`markets /tvl/balances returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const rows = (await res.json()) as { mint: string; balance: number | string; timestamp: number }[];

  if (rows.length === 0) {
    throw new Error('markets /tvl/balances returned no rows — nothing to reconcile against');
  }

  const balances: BalanceMap = {};
  for (const row of rows) {
    // Balances are u64 serialized as JSON numbers; round-trip through String
    // keeps BigInt() from throwing on scientific notation for huge values.
    balances[row.mint] = (balances[row.mint] ?? 0n) + BigInt(String(row.balance));
  }

  return { balances, timestamp: rows[0].timestamp };
}

async function fetchPrices(mints: string[]): Promise<Record<string, CoinPrice>> {
  const out: Record<string, CoinPrice> = {};
  for (let i = 0; i < mints.length; i += PRICE_CHUNK_SIZE) {
    const chunk = mints.slice(i, i + PRICE_CHUNK_SIZE);
    const keys = chunk.map((m) => `solana:${m}`).join(',');
    const res = await fetch(LLAMA_COINS_API + keys);
    if (!res.ok) {
      throw new Error(`coins.llama.fi returned ${res.status} for chunk starting at ${chunk[0]}`);
    }
    const body = (await res.json()) as { coins: Record<string, CoinPrice> };
    for (const [key, coin] of Object.entries(body.coins)) {
      out[key.replace(/^solana:/, '')] = coin;
    }
  }
  return out;
}

function toUsd(balance: bigint, coin: CoinPrice): number {
  // Number(bigint) rounds above 2^53, but the relative error (~1e-16) is
  // irrelevant for USD threshold checks.
  return (Number(balance) / 10 ** coin.decimals) * coin.price;
}

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

interface MintRow {
  mint: string;
  symbol: string;
  llamaUsd: number;
  loopUsd: number;
  diffUsd: number;
}

async function main() {
  const llamaOnly = process.argv.includes('--llama-only');

  const adaptersDir = process.env.DEFILLAMA_ADAPTERS_DIR;
  if (!adaptersDir) {
    throw new Error('DEFILLAMA_ADAPTERS_DIR must point at a DefiLlama-Adapters checkout (with node_modules installed)');
  }

  console.log('Running DefiLlama loopscale adapter (tvl)...');
  const llamaBalances = await getLlamaAdapterDeposits(adaptersDir);
  console.log(`  adapter returned ${Object.keys(llamaBalances).length} mints`);

  let snapshot: DbSnapshot | undefined;
  if (!llamaOnly) {
    const marketsUrl = process.env.LOOPSCALE_MARKETS_URL || DEFAULT_MARKETS_URL;
    console.log(`Fetching latest balances snapshot from ${marketsUrl}/tvl/balances ...`);
    snapshot = await getLoopscaleDeposits(marketsUrl);
    const ageMin = (Date.now() / 1000 - snapshot.timestamp) / 60;
    console.log(
      `  snapshot at ${new Date(snapshot.timestamp * 1000).toISOString()} ` +
        `(${ageMin.toFixed(1)} min old, ${Object.keys(snapshot.balances).length} mints)`
    );
    if (ageMin > SNAPSHOT_MAX_AGE_MIN) {
      console.error(
        `FAIL: snapshot is ${ageMin.toFixed(1)} min old (limit ${SNAPSHOT_MAX_AGE_MIN}); ` +
          'the arrakis TVL writer may be down'
      );
      process.exit(1);
    }
  }

  const allMints = [...new Set([...Object.keys(llamaBalances), ...Object.keys(snapshot?.balances ?? {})])];
  console.log(`Pricing ${allMints.length} mints via coins.llama.fi...`);
  const prices = await fetchPrices(allMints);

  const unpriced = allMints.filter((m) => !prices[m]);

  if (llamaOnly) {
    console.log('\n--- DefiLlama adapter deposits (priced) ---');
    const rows = Object.entries(llamaBalances)
      .map(([mint, bal]) => ({
        mint,
        symbol: prices[mint]?.symbol ?? mint.slice(0, 8),
        usd: prices[mint] ? toUsd(bal, prices[mint]) : NaN,
      }))
      .sort((a, b) => (b.usd || 0) - (a.usd || 0));
    for (const r of rows) {
      console.log(`  ${r.symbol.padEnd(12)} ${Number.isNaN(r.usd) ? '(unpriced)' : fmtUsd(r.usd)}`);
    }
    const total = rows.reduce((acc, r) => acc + (Number.isNaN(r.usd) ? 0 : r.usd), 0);
    console.log(`  ${'TOTAL'.padEnd(12)} ${fmtUsd(total)}`);
    if (unpriced.length) console.log(`  unpriced mints: ${unpriced.join(', ')}`);
    return;
  }

  // snapshot is always set past this point
  const loopBalances = snapshot!.balances;

  const rows: MintRow[] = allMints
    .filter((m) => prices[m])
    .map((mint) => {
      const coin = prices[mint];
      const llamaUsd = llamaBalances[mint] ? toUsd(llamaBalances[mint], coin) : 0;
      const loopUsd = loopBalances[mint] ? toUsd(loopBalances[mint], coin) : 0;
      return { mint, symbol: coin.symbol, llamaUsd, loopUsd, diffUsd: llamaUsd - loopUsd };
    })
    .sort((a, b) => Math.abs(b.diffUsd) - Math.abs(a.diffUsd));

  const llamaTotal = rows.reduce((acc, r) => acc + r.llamaUsd, 0);
  const loopTotal = rows.reduce((acc, r) => acc + r.loopUsd, 0);
  const totalDiffPct = (Math.abs(llamaTotal - loopTotal) / Math.max(llamaTotal, loopTotal)) * 100;

  console.log('\n=== DefiLlama vs Loopscale deposits ===');
  console.log(`DefiLlama total:  ${fmtUsd(llamaTotal)}`);
  console.log(`Loopscale total:  ${fmtUsd(loopTotal)}`);
  console.log(`Divergence:       ${fmtPct(totalDiffPct)} (limit ${fmtPct(TOTAL_DIVERGENCE_PCT)})`);

  console.log('\nPer-mint (sorted by |diff|, > $1k shown):');
  console.log(
    `  ${'symbol'.padEnd(12)} ${'DefiLlama'.padStart(14)} ${'Loopscale'.padStart(14)} ${'diff'.padStart(14)}`
  );
  for (const r of rows) {
    if (Math.abs(r.diffUsd) < 1_000) continue;
    console.log(
      `  ${r.symbol.padEnd(12)} ${fmtUsd(r.llamaUsd).padStart(14)} ${fmtUsd(r.loopUsd).padStart(14)} ${fmtUsd(r.diffUsd).padStart(14)}`
    );
  }

  const onlyLlama = rows.filter((r) => r.loopUsd === 0 && r.llamaUsd > 1_000);
  const onlyLoop = rows.filter((r) => r.llamaUsd === 0 && r.loopUsd > 1_000);
  if (onlyLlama.length) {
    console.log(`\nOnly in DefiLlama: ${onlyLlama.map((r) => `${r.symbol} (${fmtUsd(r.llamaUsd)})`).join(', ')}`);
  }
  if (onlyLoop.length) {
    console.log(`Only in Loopscale: ${onlyLoop.map((r) => `${r.symbol} (${fmtUsd(r.loopUsd)})`).join(', ')}`);
  }
  if (unpriced.length) {
    console.log(`\nUnpriced mints (excluded from totals): ${unpriced.join(', ')}`);
  }

  const mintBreaches = rows.filter((r) => Math.abs(r.diffUsd) > MINT_DIVERGENCE_USD);
  let failed = false;
  if (totalDiffPct > TOTAL_DIVERGENCE_PCT) {
    console.error(`\nFAIL: total divergence ${fmtPct(totalDiffPct)} exceeds ${fmtPct(TOTAL_DIVERGENCE_PCT)}`);
    failed = true;
  }
  if (mintBreaches.length) {
    console.error(
      `FAIL: per-mint divergence over ${fmtUsd(MINT_DIVERGENCE_USD)}: ` +
        mintBreaches.map((r) => `${r.symbol} (${fmtUsd(r.diffUsd)})`).join(', ')
    );
    failed = true;
  }

  if (failed) process.exit(1);
  console.log('\nOK: within thresholds');
}

main().catch((err) => {
  console.error('Reconciliation errored:', err);
  process.exit(1);
});
