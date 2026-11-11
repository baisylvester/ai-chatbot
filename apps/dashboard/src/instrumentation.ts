/**
 * Runs once when the server starts. In production, refuse to start with missing or weak secrets
 * rather than failing later on a visitor's request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  if (process.env.SKIP_ENV_CHECK === "1") return; // build-time only (e.g. CI builds without secrets)
  const { productionEnvProblems } = await import("./lib/env");
  const problems = productionEnvProblems();
  if (problems.length) {
    console.error(JSON.stringify({ level: "fatal", event: "startup.env_invalid", problems }));
    throw new Error(`Invalid production configuration: ${problems.join("; ")}`);
  }
}
