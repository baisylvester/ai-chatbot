import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createAuthClient } from "@/lib/auth/server";

const OTP_TYPES = new Set<EmailOtpType>(["signup", "invite", "magiclink", "recovery", "email_change", "email"]);

/** Landing page for Supabase email links (sign-up confirmation). Starts the session, then opens the dashboard. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type") as EmailOtpType | null;
  const supabase = await createAuthClient();

  let ok = false;
  if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  } else if (tokenHash && type && OTP_TYPES.has(type)) {
    ok = !(await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error;
  }

  // Only ever redirect within this site.
  const target = new URL(ok ? "/orgs" : "/auth/sign-in?error=link", request.nextUrl.origin);
  const response = NextResponse.redirect(target);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
