import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev route badge renders bottom-left, which is exactly where the chat
  // composer sits — it covers the input and reads as part of the product when
  // the app is shown from a dev server. Compile and runtime errors are still
  // surfaced; only the route indicator is hidden.
  devIndicators: false,
  // In hosted environments the web app proxies /api/* to the API service so
  // auth cookies stay first-party on this origin (same-origin requirement).
  // Set API_PROXY_TARGET to the API base URL (no trailing slash) and leave
  // NEXT_PUBLIC_API_URL empty so the client fetches relative /api paths.
  // Unset in local dev — the client calls http://localhost:4000 directly.
  async rewrites() {
    const target = process.env.API_PROXY_TARGET;
    if (!target) return [];
    return [
      { source: "/api/:path*", destination: `${target}/api/:path*` },
      // The live connection (price alerts) takes the same route, for the same
      // reason. The client asks for "/socket.io" without a trailing slash, so
      // it is not redirected first; the API expects the slash.
      { source: "/socket.io", destination: `${target}/socket.io/` },
    ];
  },
};

export default nextConfig;
