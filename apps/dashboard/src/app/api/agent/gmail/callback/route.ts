/** GET /api/agent/gmail/callback — Google returns here; the mailbox token is encrypted and stored. */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { encryptSecret, exchangeCode, GmailClient, MailAuthError, saveConnection } from "@chatbot/mail-agent";
import { log } from "@/lib/log";
import { mailDb, mailSetup } from "@/lib/mail-agent";
import { handleNativeCallback } from "@/lib/native-mail";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "mail_oauth_state";

export async function GET(request: NextRequest) {
  const home = process.env.NEXT_PUBLIC_PLATFORM_URL || request.url;
  const done = (query: string) => {
    const response = NextResponse.redirect(new URL(`/agent?${query}`, home));
    response.cookies.set(STATE_COOKIE, "", { path: "/api/agent/gmail", maxAge: 0 });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };

  // A native app (Android/iOS) has no state cookie in this browser: when the cookie does not match, the
  // state may belong to a single-use native transaction, which returns to the app. The browser flow below
  // is unchanged.
  const cookieState = Buffer.from(request.cookies.get(STATE_COOKIE)?.value ?? "");
  const queryState = Buffer.from(request.nextUrl.searchParams.get("state") ?? "");
  if (!cookieState.length || cookieState.length !== queryState.length || !timingSafeEqual(cookieState, queryState)) {
    const native = await handleNativeCallback(request.nextUrl.searchParams);
    if (native) return native;
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/auth/sign-in", home));
  const { oauth, tokenSecret } = mailSetup();
  if (!oauth || !tokenSecret) return done("error=setup");

  const params = request.nextUrl.searchParams;
  const expected = Buffer.from(request.cookies.get(STATE_COOKIE)?.value ?? "");
  const given = Buffer.from(params.get("state") ?? "");
  if (!expected.length || expected.length !== given.length || !timingSafeEqual(expected, given)) return done("error=state");
  const code = params.get("code");
  if (params.get("error") || !code) return done("error=denied");

  try {
    const tokens = await exchangeCode(oauth, code);
    const { email } = await new GmailClient(tokens.accessToken).profile();
    const sealed = await encryptSecret(tokens.refreshToken, tokenSecret);
    await mailDb((db) => saveConnection(db, user.id, email, sealed));
    log.info("mail.connected", { userId: user.id });
    return done("connected=1");
  } catch (err) {
    log.warn("mail.connect_failed", { error: err });
    return done(err instanceof MailAuthError ? "error=permission" : "error=failed");
  }
}
