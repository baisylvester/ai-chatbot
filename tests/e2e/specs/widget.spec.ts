import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Route } from "@playwright/test";

const API = "https://platform.test";
const BOT = "cb_e2eTestChatbot0000000001";
const embedJs = readFileSync(fileURLToPath(new URL("../../../packages/embed-sdk/dist/embed.js", import.meta.url)), "utf8");

const cors = { "access-control-allow-origin": "http://localhost:4020", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
const config = {
  chatbotId: BOT,
  name: "Acme Helper",
  welcomeMessage: "Hi! Ask me about Acme.",
  suggestedQuestions: ["What are your hours?"],
  theme: "light",
  position: "bottom-right",
  voice: { mode: "off", autoSpeak: false },
};

/** Simulates the platform API for one page. `reply` is streamed as SSE tokens. */
async function mockPlatform(page: Page, opts: { configStatus?: number; reply?: string; citations?: unknown[] } = {}) {
  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (path === "/embed.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: embedJs });
    if (path === "/api/v1/embed/config") {
      return opts.configStatus && opts.configStatus !== 200
        ? route.fulfill({ status: opts.configStatus, headers: cors, json: { error: { code: "origin_not_allowed", message: "This website is not allowed to use this chatbot" } } })
        : route.fulfill({ status: 200, headers: cors, json: config });
    }
    if (path === "/api/v1/embed/sessions") {
      return route.fulfill({ status: 200, headers: cors, json: { token: "t.e2e", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), config } });
    }
    if (path === "/api/v1/embed/messages") {
      const reply = opts.reply ?? "We are open 9 to 5.";
      const events = [
        opts.citations ? `event: sources\ndata: ${JSON.stringify({ citations: opts.citations })}\n\n` : "",
        ...reply.split(/(?<= )/).map((t) => `event: token\ndata: ${JSON.stringify({ text: t })}\n\n`),
        "event: done\ndata: {}\n\n",
      ].join("");
      return route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: events });
    }
    return route.fulfill({ status: 404, headers: cors, body: "not found" });
  });
}

const shadow = (page: Page) => page.locator("ai-chatbot").first();

test.describe("script snippet on a hostile website", () => {
  test("loads with isolated styles, chats, shows sources, and leaves the host page working", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await mockPlatform(page, { citations: [{ n: 1, title: "Store hours", sourceUrl: "https://acme.example/hours", snippet: "Open 9 to 5" }] });
    await page.goto(`/index.html?bot=${BOT}&api=${API}`);

    const launcher = shadow(page).locator(".launcher");
    await expect(launcher).toBeVisible();
    // The host page forces hot-pink buttons and hides SVGs with !important; the widget is unaffected.
    await expect(launcher).toHaveCSS("background-color", "rgb(24, 24, 27)");
    await expect(launcher.locator("svg")).toBeVisible();

    await launcher.click();
    await expect(shadow(page).getByText("Hi! Ask me about Acme.")).toBeVisible();
    await expect(shadow(page).getByRole("button", { name: "What are your hours?" })).toBeVisible();
    await expect(shadow(page).locator("textarea")).toBeFocused();

    await shadow(page).locator("textarea").fill("When are you open?");
    await shadow(page).locator("textarea").press("Enter");
    await expect(shadow(page).getByText("We are open 9 to 5.")).toBeVisible();
    await expect(shadow(page).getByText("Sources (1)")).toBeVisible();
    await shadow(page).getByText("Sources (1)").click();
    await expect(shadow(page).getByRole("link", { name: "Store hours" })).toHaveAttribute("rel", "noopener noreferrer");

    // Close the chat first: on phones it covers the whole screen by design.
    await page.evaluate(() => (document.querySelector("ai-chatbot") as HTMLElement & { close(): void }).close());
    await page.locator("#host-button").click({ force: true });
    await expect(page.locator("#host-status")).toHaveText("Host button clicked.");
    expect(errors).toEqual([]);
  });

  test("renders replies as text, never as HTML", async ({ page }) => {
    await mockPlatform(page, { reply: '<img src=x onerror="window.__xss=1"> hello <b>bold</b>' });
    await page.goto(`/index.html?bot=${BOT}&api=${API}`);
    await shadow(page).locator(".launcher").click();
    await shadow(page).locator("textarea").fill("hi");
    await shadow(page).locator("textarea").press("Enter");
    await expect(shadow(page).getByText("hello <b>bold</b>", { exact: false })).toBeVisible();
    expect(await shadow(page).locator(".log img, .log b").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("stays hidden on a site that isn't allowed, without breaking it", async ({ page }) => {
    await mockPlatform(page, { configStatus: 403 });
    const warnings: string[] = [];
    page.on("console", (m) => m.type() === "warning" && warnings.push(m.text()));
    await page.goto(`/index.html?bot=${BOT}&api=${API}`);
    await expect.poll(() => warnings.some((w) => w.includes("not allowed"))).toBe(true);
    await expect(shadow(page).locator(".launcher")).toBeHidden();
    await page.locator("#host-button").click({ force: true });
    await expect(page.locator("#host-status")).toHaveText("Host button clicked.");
  });

  test("closes with Escape and returns focus to the launcher", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard behaviour is tested on desktop browsers");
    await mockPlatform(page);
    await page.goto(`/index.html?bot=${BOT}&api=${API}`);
    const launcher = shadow(page).locator(".launcher");
    await launcher.click();
    await expect(launcher).toHaveAttribute("aria-expanded", "true");
    await shadow(page).locator("textarea").press("Escape");
    await expect(shadow(page).locator(".panel")).toBeHidden();
    await expect(launcher).toHaveAttribute("aria-expanded", "false");
    await expect(launcher).toBeFocused();
  });

  test("uses the full screen on phones", async ({ page, isMobile }) => {
    test.skip(!isMobile, "phone layout only");
    await mockPlatform(page);
    await page.goto(`/index.html?bot=${BOT}&api=${API}`);
    await shadow(page).locator(".launcher").click();
    const box = await shadow(page).locator(".panel").boundingBox();
    const viewport = page.viewportSize()!;
    expect(Math.round(box!.width)).toBe(viewport.width);
    expect(Math.round(box!.height)).toBe(viewport.height);
  });
});

test("Web Component: two instances on one page work independently", async ({ page }) => {
  await mockPlatform(page);
  await page.goto(`/web-component.html?bot=${BOT}&api=${API}`);
  const inline = page.locator('ai-chatbot[mode="inline"]');
  const floating = page.locator('ai-chatbot:not([mode="inline"])');
  await expect(inline.locator(".panel")).toBeVisible();
  await expect(floating.locator(".launcher")).toBeVisible();
  await expect(floating).toHaveAttribute("data-theme", "dark");
  await inline.locator("textarea").fill("Hello");
  await inline.locator("textarea").press("Enter");
  await expect(inline.getByText("We are open 9 to 5.")).toBeVisible();
});
