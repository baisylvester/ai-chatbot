import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source; let Next compile them.
  transpilePackages: ["@chatbot/shared", "@chatbot/core", "@chatbot/database", "@chatbot/ai-engine", "@chatbot/ai-providers", "@chatbot/rag-engine"],
  // Native Node driver: keep it out of the bundle.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // Knowledge file uploads go through server actions (10 MB extraction limit plus form overhead).
  experimental: { serverActions: { bodySizeLimit: "11mb" } },
};

export default nextConfig;
