import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

// Supabase Auth. Users and sessions live in the auth schema of the Supabase project; the app mirrors
// each signed-in user into public.users (see lib/session.ts). Session cookies are set by @supabase/ssr.

export function supabaseConfig(): { url: string; key: string } {
  return { url: process.env.NEXT_PUBLIC_SUPABASE_URL!, key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY! };
}

/** A Supabase client bound to this request's cookies. Create one per request; never share it. */
export async function createAuthClient() {
  const cookieStore = await cookies();
  const { url, key } = supabaseConfig();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components can't set cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}
