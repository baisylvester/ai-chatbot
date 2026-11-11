import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source; let Next compile them.
  transpilePackages: ["@chatbot/shared", "@chatbot/core", "@chatbot/database"],
  // Native Node driver: keep it out of the bundle.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default nextConfig;
