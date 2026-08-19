/*
 * Hup Gift — shared deployment config, the ONE place an address lives. Both the claim frame
 * (app.js) and the admin page (admin.js) read from here, so a new chain or a redeploy is a
 * single edit. Loaded as a plain script before the page scripts — no build step, no imports.
 */

// Declared inside a closure and exported by assignment so no extension-injected global
// can collide with the declarations (assignment never throws; a bare top-level const does).
(() => {


// The Hup host: the embed loads the SDK from it, the admin page reads the leaderboard from it.
// Detected, not hardcoded — a hardcoded value has to be flipped between dev and production on
// every deploy, and a deploy with the wrong one strands the frame loading the SDK from the
// viewer's own localhost (this happened). The embedding page's origin arrives in
// document.referrer (Hup's strict-origin-when-cross-origin policy sends exactly the origin),
// and only known Hup origins are honored — an unknown embedder must not get to choose which
// script runs inside this frame. Standalone pages (admin, direct opens) have no referrer and
// fall back by where this copy itself is served: a local copy talks to the local dev server, a
// hosted one to production. www is the canonical production host (the apex 307s to it).
const HUP_ORIGINS = ["https://www.hup.social", "https://hup.social", "https://localhost:3000"];

const referrerOrigin = (() => {
  try {
    return new URL(document.referrer).origin;
  } catch {
    return "";
  }
})();

const isLocalCopy = ["localhost", "127.0.0.1"].includes(location.hostname);
const HUP_ORIGIN = HUP_ORIGINS.includes(referrerOrigin)
  ? referrerOrigin
  : isLocalCopy
    ? "https://localhost:3000"
    : "https://www.hup.social";

// One entry per chain HupGift is deployed on. Everything campaign-specific lives in the round
// onchain, so adding a chain is one entry here and nothing else.
const DEPLOYMENTS = {
  4201: {
    address: "0xBa0EdfeAF5C75Ba891Bf179FDF4abdA744693103",
    name: "LUKSO Testnet",
    symbol: "LYXt",
    explorer: "https://explorer.execution.testnet.lukso.network",
  },
  42: {
    address: "0xF94B71443c944Da57137f0C196433a9f8e601B3E",
    name: "LUKSO",
    symbol: "LYX",
    explorer: "https://explorer.execution.mainnet.lukso.network",
  },
};

// Fallback chain when the host context does not name one
const PRIMARY_CHAIN_ID = 4201;

  Object.assign(globalThis, { HUP_ORIGIN, DEPLOYMENTS, PRIMARY_CHAIN_ID });
})();
