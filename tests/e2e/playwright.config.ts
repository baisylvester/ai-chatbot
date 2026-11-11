import { defineConfig, devices } from "@playwright/test";

/**
 * Cross-browser tests for the embeddable widget on an unrelated, deliberately hostile website
 * (apps/embed-demo). The platform API is simulated per test (page.route), so these run without a
 * database or AI provider and test the widget itself in each browser engine.
 * Run: pnpm --filter @chatbot/embed-sdk build && pnpm --filter @chatbot/e2e test:e2e
 */
export default defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:4020", trace: "retain-on-failure" },
  webServer: {
    command: "node ../../apps/embed-demo/server.mjs",
    url: "http://localhost:4020/index.html",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  ],
});
