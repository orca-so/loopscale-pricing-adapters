// markets only accepts traffic through the tars load balancer, not the Cloud Run url.
export const MARKETS_URL =
  process.env.LOOPSCALE_MARKETS_URL || "https://tars.loopscale.com/v1/markets";
