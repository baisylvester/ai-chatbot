/** GET /api/v1/openapi.json — OpenAPI 3.1 description of the public API. */
import { openApiSpec } from "@/lib/openapi";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const server = process.env.NEXT_PUBLIC_PLATFORM_URL ?? new URL(request.url).origin;
  return Response.json(openApiSpec(server), { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
}
