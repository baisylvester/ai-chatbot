import { defineConfig } from "vitest/config";

// The integration suites share one database, and maintenance purges every organization's expired data,
// so files must not run side by side.
export default defineConfig({ test: { fileParallelism: false } });
