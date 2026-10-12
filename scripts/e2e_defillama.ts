/**
 * End-to-end check of the path DefiLlama uses: run the real DefiLlama loopscale
 * adapter (projects/loopscale in DefiLlama-Adapters) against a pricing-adapters
 * server built from this checkout, and compare with the deployed service.
 *
 * The adapter is executed as-is except for its hardcoded endpoint, which is made
 * overridable so the same code can target each server in turn.
 *
 * Env:
 *   DEFILLAMA_ADAPTERS_DIR   path to a DefiLlama-Adapters checkout with node_modules
 *   CANDIDATE_ENDPOINT       /v1/decompile_mints url of the server under test
 *   BASELINE_ENDPOINT        url to compare against (default: the adapter's own endpoint);
 *                            set to "none" to skip the comparison
 *   SOLANA_RPC               RPC url used by the adapter (SOLANA_RPC_URL also accepted)
 *   MINT_DIVERGENCE_PCT      fail when a mint's balance differs by more than this (default 1)
 */

import * as fs from 'fs';
import * as path from 'path';

const MINT_DIVERGENCE_PCT = Number(process.env.MINT_DIVERGENCE_PCT || 1);

type BalanceMap = Record<string, bigint>;

interface RunResult {
  balances: BalanceMap;
  requestMints: number;
  status: number;
  ms: number;
}

function loadPatchedAdapter(adaptersDir: string): { tvl: (api: unknown) => Promise<void>; defaultEndpoint: string } {
  const dir = path.join(adaptersDir, 'projects', 'loopscale');
  const source = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');

  const endpointMatch = source.match(/const endpoint = '([^']+)'/);
  if (!endpointMatch || !source.includes('fetch(endpoint,')) {
    throw new Error('DefiLlama loopscale adapter changed shape; update scripts/e2e_defillama.ts');
  }

  // Written next to the original so its relative requires (../helper/solana) still resolve.
  const patchedPath = path.join(dir, 'index.e2e.js');
  fs.writeFileSync(patchedPath, source.replace('fetch(endpoint,', 'fetch(process.env.E2E_PRICING_ENDPOINT || endpoint,'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const adapter = require(patchedPath);
  return { tvl: adapter.solana.tvl, defaultEndpoint: endpointMatch[1] };
}

async function runAdapter(tvl: (api: unknown) => Promise<void>, endpoint: string): Promise<RunResult> {
  process.env.E2E_PRICING_ENDPOINT = endpoint;

  let status = 0;
  let requestMints = 0;
  let ms = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input) !== endpoint) return realFetch(input, init);
    requestMints = Object.keys(JSON.parse(init.body).rawBalances).length;
    const start = Date.now();
    const res = await realFetch(input, init);
    ms = Date.now() - start;
    status = res.status;
    if (!res.ok) {
      throw new Error(`${endpoint} returned ${res.status}: ${await res.clone().text()}`);
    }
    return res;
  }) as typeof fetch;

  const balances: BalanceMap = {};
  const api = {
    addTokens(mints: string[], amounts: (bigint | string | number)[]) {
      mints.forEach((mint, i) => {
        balances[mint] = (balances[mint] ?? 0n) + BigInt(amounts[i]);
      });
    },
  };

  try {
    await tvl(api);
  } finally {
    globalThis.fetch = realFetch;
  }
  return { balances, requestMints, status, ms };
}

function pctDiff(a: bigint, b: bigint): number {
  const max = a > b ? a : b;
  if (max === 0n) return 0;
  const diff = a > b ? a - b : b - a;
  return Number((diff * 1_000_000n) / max) / 10_000;
}

async function main() {
  const adaptersDir = process.env.DEFILLAMA_ADAPTERS_DIR;
  const candidate = process.env.CANDIDATE_ENDPOINT;
  if (!adaptersDir || !candidate) {
    console.error('DEFILLAMA_ADAPTERS_DIR and CANDIDATE_ENDPOINT are required');
    process.exit(1);
  }
  if (!process.env.SOLANA_RPC && process.env.SOLANA_RPC_URL) {
    process.env.SOLANA_RPC = process.env.SOLANA_RPC_URL;
  }

  const { tvl, defaultEndpoint } = loadPatchedAdapter(adaptersDir);
  const baseline = process.env.BASELINE_ENDPOINT || defaultEndpoint;

  const cand = await runAdapter(tvl, candidate);
  console.log(`candidate ${candidate}: HTTP ${cand.status} in ${cand.ms} ms, ${cand.requestMints} mints in, ${Object.keys(cand.balances).length} out`);

  let failed = false;
  if (Object.keys(cand.balances).length === 0) {
    console.error('FAIL: candidate returned no balances');
    failed = true;
  }

  let base: RunResult | undefined;
  if (baseline !== 'none') {
    // The baseline is only a reference: if the deployed service is down, report it
    // but judge the candidate on its own result.
    try {
      base = await runAdapter(tvl, baseline);
    } catch (err) {
      console.warn(`WARN: baseline ${baseline} failed, skipping comparison: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (base) {
    console.log(`baseline  ${baseline}: HTTP ${base.status} in ${base.ms} ms, ${base.requestMints} mints in, ${Object.keys(base.balances).length} out`);

    const mints = [...new Set([...Object.keys(cand.balances), ...Object.keys(base.balances)])].sort();
    console.log('\nmint                                          candidate                 baseline                  diff');
    for (const mint of mints) {
      const c = cand.balances[mint] ?? 0n;
      const b = base.balances[mint] ?? 0n;
      const d = pctDiff(c, b);
      const flag = d > MINT_DIVERGENCE_PCT ? '  <-- FAIL' : '';
      if (flag) failed = true;
      console.log(`${mint.padEnd(46)}${c.toString().padStart(24)}  ${b.toString().padStart(24)}  ${d.toFixed(4).padStart(8)}%${flag}`);
    }
  }

  if (failed) process.exit(1);
  console.log('\nOK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
