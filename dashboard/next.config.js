const path = require("path");

const backendUrl = (
  process.env.API_SERVER_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://127.0.0.1:4000"
).replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname),

  // `next dev` refuses to serve its dev assets to unknown origins, which
  // breaks a development hostname reached through a reverse proxy or tunnel
  // (oms.reygent.com → localhost:3000). Production builds don't have this
  // check at all.
  allowedDevOrigins: ["*.e2b.app", "oms.reygent.com", "*.reygent.com"],

  async rewrites() {
    return {
      // Shopify opens the App URL itself to start an install
      // (`/?shop=…&hmac=…&timestamp=…`). With a single-host development
      // topology that URL is this server's root, and Next resolves a real page
      // before it applies an afterFiles rewrite — so the install entry has to
      // be rewritten *before* filesystem routes, or `/` keeps rendering the
      // dashboard and the install never reaches the API.
      beforeFiles: [
        {
          source: "/",
          has: [{ type: "query", key: "shop" }],
          destination: `${backendUrl}/`,
        },
      ],

      afterFiles: [
      // The browser only ever calls this server, same-origin. Rewrites are
      // transparent byte-for-byte proxies, which is what makes the webhook
      // route below (and the API's HMAC verification) safe to pass through.
      {
        source: "/api/:path*",
        destination: `${backendUrl}/:path*`,
      },

      // Shopify's webhook endpoint, reachable on the dashboard's own host.
      //
      // Why: in development the whole project lives on one hostname
      // (oms.reygent.com), so APP_URL — and therefore the URI Shopify posts
      // to, `<APP_URL>/webhooks/shopify` — resolves to this server and is
      // forwarded to the API. Verified against the real intake: a correctly
      // signed delivery passes (HMAC over the exact bytes), a forged one is
      // still rejected with 401.
      //
      // In production, put the API on its own host (api.reygent.com) and set
      // APP_URL to that origin: webhook traffic shouldn't depend on the
      // frontend process being up.
      {
        source: "/webhooks/:path*",
        destination: `${backendUrl}/webhooks/:path*`,
      },

      // Shopify's OAuth callback, same reason as above: with the single-host
      // topology the App URL is this server, so Shopify's redirect back to
      // `/auth/shopify/callback` would 404 here instead of reaching the API,
      // which validates the callback HMAC against SHOPIFY_API_SECRET and
      // completes the token exchange.
      //
      // In production the API has its own host (api.reygent.com) and the App
      // URL points straight at it, so neither rewrite is on the critical path.
      {
        source: "/auth/shopify/:path*",
        destination: `${backendUrl}/auth/shopify/:path*`,
      },
      ],
    };
  },
};

module.exports = nextConfig;
