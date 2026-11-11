import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// All authenticated pages are dynamic. No paid cache, bucket, queue or container bindings.
export default defineCloudflareConfig();
