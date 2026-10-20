import { Connection } from "@solana/web3.js";
import { switchBaseDecimals, switchBaseDecimalsBn } from "../utils";
import { reportError } from "../utils/errorContext";
import { MARKETS_URL } from "../utils/markets";

// Converts collateral without public pricing (tranche receipts, uncovered
// Exponent PTs, deal tokens) into a DefiLlama-priceable underlying at the
// token/underlying USD ratio from Loopscale's public switchboard price
// endpoints. Only the RATIO comes from Loopscale — absolute USD pricing of the
// resulting underlying stays with the consumer. A static 1:1 map (like the
// exponent handler) would misprice these by 4-13%: e.g. srONyc trades at
// ~0.89x ONYC and oneSOL at ~1.11x SOL.

const ONYC = "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5";
const EUSX = "3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC";
const XSOL = "4sWNB8zGWHkh6UnmwiEtzNxL4XrN7uK9tosbESbJFfVs";
const BULKSOL = "BULKoNSGzxtCqzwTvg5hFJg8fx6dqZRScyXe5LYMfxrn";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const RATIO_CONVERSION_DATA: { [tokenMint: string]: string } = {
  "dawn7ZUF7h7anFuEsDdAU1Y3HYwikwqNMAENZsQJdNL": USDC, // USD.infra
  "9J8VvigcjFTkN3jhZH2ieTi2hdGVBVpEXbcA1JDo7QpA": ONYC, // srONyc (senior tranche)
  "HSbdobdvfGAfqKWSWZ7s2XfFx1P1FJutTa96MHJtkm5": ONYC, // PT-srONyc-10JAN27
  "FvQP1fjox2GPSwkEhENuZisz8UeRURLWf7GYF9n2mURD": EUSX, // srEHYUSD (senior tranche)
  "AzEcgo4PTjnUX7k7RYxFe9KHYyTSHEXtmT262hr8uLnd": EUSX, // PT-srEHYUSD-12DEC26
  "GMGm82jMiMCVQZfnHcD96b8YF8BXvLHteKhEaj3fZjDe": WSOL, // oneSOL
  "F17tzaQaFf1x3tC5gQFVvXAF2hcgq1qX6Mc9595zo3FD": USDC, // srAUTO (AUTO itself has no public price)
  "HgyWqTZ6JdGYF5TfrYmScTyvsyuopwYRJXwqA2LzCrz6": BULKSOL, // PT-bulkSOL-31OCT26
  "CukzxRH74NMVx1SZrjHjAYz65HsgYYW9EAMu2Whqx5hc": BULKSOL, // ELP-bulkSOL-26FEB26
  "3bFbFU1dtap35fgBY6ityikjv41YSyxHCWnJkAiEteWR": XSOL, // PT-xSOL-12DEC26
  "Af4kuyVwhoWK91YcsaoRQE4YbSknuWjwVM4xet7hRHB6": XSOL, // PT-xSOL-12AUG26 (matured)
  "7unas46TRngwSZ5bDpaL2y2tth5nAMSuCY4wbuKgMsTf": XSOL, // xSOL APR26
};

// Fed into getDecimalMap alongside the exponent/ratex underlying mints so
// decimal lookups succeed even when the underlying isn't in the request.
export const RATIO_UNDERLYING_MINTS = [...new Set(Object.values(RATIO_CONVERSION_DATA))];

const PRICE_FETCH_ATTEMPTS = 3;

async function fetchUsdPrice(mint: string, cache: Map<string, number>): Promise<number> {
  const cached = cache.get(mint);
  if (cached !== undefined) return cached;

  let lastError: unknown;
  for (let attempt = 0; attempt < PRICE_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
    try {
      const res = await fetch(`${MARKETS_URL}/prices/switchboard/${mint}`);
      if (!res.ok) {
        throw new Error(`price fetch for ${mint} returned ${res.status}`);
      }
      const body = (await res.json()) as { usdPrice?: number };
      const price = body.usdPrice;
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
        throw new Error(`invalid usdPrice for ${mint}: ${price}`);
      }
      cache.set(mint, price);
      return price;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const RATIO_SCALE = 1_000_000_000_000n; // 1e12

export async function getRatioConvertedBalancesBn(
  _connection: Connection,
  balances: { [mint: string]: bigint },
  decimalMap: Map<string, number>
) {
  const priceCache = new Map<string, number>();

  for (const [tokenMint, underlyingMint] of Object.entries(RATIO_CONVERSION_DATA)) {
    try {
      const balance = balances[tokenMint];
      if (balance === undefined) continue;

      const tokenDecimals = decimalMap.get(tokenMint);
      const underlyingDecimals = decimalMap.get(underlyingMint);
      if (tokenDecimals == null || underlyingDecimals == null) {
        throw new Error(`Missing decimals for token ${tokenMint} or underlying ${underlyingMint}`);
      }

      const [tokenPrice, underlyingPrice] = await Promise.all([
        fetchUsdPrice(tokenMint, priceCache),
        fetchUsdPrice(underlyingMint, priceCache),
      ]);

      const scaledRatio = BigInt(Math.round((tokenPrice / underlyingPrice) * Number(RATIO_SCALE)));
      const underlyingAmount = switchBaseDecimalsBn(
        (balance * scaledRatio) / RATIO_SCALE,
        tokenDecimals,
        underlyingDecimals
      );

      balances[underlyingMint] = (balances[underlyingMint] || 0n) + underlyingAmount;
      delete balances[tokenMint];
    } catch (error) {
      console.error(`Error in getRatioConvertedBalancesBn for mint ${tokenMint}:`, error);
      reportError(`ratio(${tokenMint})`, error);
    }
  }

  return balances;
}

export async function getRatioConvertedBalances(
  _connection: Connection,
  balances: { [mint: string]: number },
  decimalMap: Map<string, number>
) {
  const priceCache = new Map<string, number>();

  for (const [tokenMint, underlyingMint] of Object.entries(RATIO_CONVERSION_DATA)) {
    try {
      const balance = balances[tokenMint];
      if (balance === undefined) continue;

      const tokenDecimals = decimalMap.get(tokenMint);
      const underlyingDecimals = decimalMap.get(underlyingMint);
      if (tokenDecimals == null || underlyingDecimals == null) {
        throw new Error(`Missing decimals for token ${tokenMint} or underlying ${underlyingMint}`);
      }

      const [tokenPrice, underlyingPrice] = await Promise.all([
        fetchUsdPrice(tokenMint, priceCache),
        fetchUsdPrice(underlyingMint, priceCache),
      ]);

      const underlyingAmount = switchBaseDecimals(
        balance * (tokenPrice / underlyingPrice),
        tokenDecimals,
        underlyingDecimals
      );

      balances[underlyingMint] = (balances[underlyingMint] || 0) + underlyingAmount;
      delete balances[tokenMint];
    } catch (error) {
      console.error(`Error in getRatioConvertedBalances for mint ${tokenMint}:`, error);
      // Gracefully fail and keep the original balance, matching the legacy handlers
    }
  }

  return balances;
}
