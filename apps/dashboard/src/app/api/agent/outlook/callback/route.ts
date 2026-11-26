/** GET /api/agent/outlook/callback — Microsoft returns here after a native (app) Outlook connection. */
import { NextResponse, type NextRequest } from "next/server";
import { handleNativeCallback } from "@/lib/native-mail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const native = await handleNativeCallback(request.nextUrl.searchParams);
  if (native) return native;
  // Outlook is connected from the app only; an unknown state has nothing to return to.
  return NextResponse.redirect(new URL("/agent?error=state", process.env.NEXT_PUBLIC_PLATFORM_URL || request.url));
}
