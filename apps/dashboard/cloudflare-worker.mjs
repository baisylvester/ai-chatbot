import handler from "./.open-next/worker.js";

export default {
  fetch: handler.fetch,
  async scheduled(_event, env, ctx) {
    const response = await handler.fetch(new Request(`${env.NEXT_PUBLIC_PLATFORM_URL}/api/internal/maintenance`, {
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
    }), env, ctx);
    await response.text();
    if (!response.ok) throw new Error(`Maintenance failed (${response.status})`);
  },
};
