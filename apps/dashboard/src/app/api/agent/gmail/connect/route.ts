/** GET /api/agent/gmail/connect — sends the signed-in user to Google's consent screen for Gmail. */
import { NextResponse } from "next/server";
import { googleAuthUrl, toBase64Url } from "@chatbot/mail-agent";
import { mailSetup } from "@/lib/mail-agent";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "mail_oauth_state";

export async function GET(request: Request) {
  const home = process.env.NEXT_PUBLIC_PLATFORM_URL || request.url;
  if (!(await getCurrentUser())) return NextResponse.redirect(new URL("/auth/sign-in", home));
  const { oauth, tokenSecret } = mailSetup();
  if (!oauth || !tokenSecret) return NextResponse.redirect(new URL("/agent?error=setup", home));

  // The state ties Google's answer to this browser; the callback rejects anything else.
  const state = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const response = NextResponse.redirect(googleAuthUrl(oauth, state));
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true, secure: oauth.redirectUri.startsWith("https://"), sameSite: "lax", path: "/api/agent/gmail", maxAge: 600,
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
