import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Refreshes the Supabase session cookie and redirects signed-out visitors away from the dashboard.
// Pages and server actions still check the session themselves (see lib/session.ts).
export default async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");
  const authCacheHeaders: Record<string, string> = {};
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        const existingCookies = response.cookies.getAll();
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const cookie of existingCookies) response.cookies.set(cookie);
        Object.assign(authCacheHeaders, headers);
        response.headers.set("Cache-Control", "private, no-store");
        for (const [name, value] of Object.entries(authCacheHeaders)) response.headers.set(name, value);
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getClaims() verifies the access token (refreshing it when needed); don't trust getSession() here.
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/sign-in";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Cache-Control", "private, no-store");
    for (const [name, value] of Object.entries(authCacheHeaders)) redirect.headers.set(name, value);
    for (const c of response.cookies.getAll()) redirect.cookies.set(c);
    return redirect;
  }
  return response;
}

export const config = {
  matcher: ["/orgs/:path*", "/workspaces/:path*", "/websites/:path*", "/chatbots/:path*", "/knowledge/:path*", "/conversations/:path*"],
};
