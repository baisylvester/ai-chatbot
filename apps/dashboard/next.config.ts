import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Monorepo root: workspace packages live outside apps/dashboard.
const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Headers for dashboard pages: no framing, no sniffing, no stray device access. */
const dashboardSecurityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Ignored over plain http (local dev); enforces https once deployed.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Workspace packages ship TypeScript source; let Next compile them.
  transpilePackages: ["@chatbot/shared", "@chatbot/core", "@chatbot/database", "@chatbot/ai-engine", "@chatbot/ai-providers", "@chatbot/rag-engine", "@chatbot/voice-engine"],
  // Native Node driver: keep it out of the bundle.
  serverExternalPackages: ["pg", "word-extractor"],
  poweredByHeader: false,
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  // Knowledge file uploads go through server actions (10 MB extraction limit plus form overhead).
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
  async headers() {
    return [
      // Everything except the embeddable surfaces (iframe page, widget script) and the API,
      // which set their own headers (CORS, CSP frame-ancestors from allowed domains).
      { source: "/((?!embed/|embed\\.js|api/).*)", headers: dashboardSecurityHeaders },
      {
        source: "/embed.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=86400" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
      { source: "/api/:path*", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] },
    ];
  },
};

export default nextConfig;
