import { createNeonAuth } from "@neon/auth/next/server";

// Neon Auth (Managed Better Auth). Users and sessions live in the neon_auth schema of the same database.
export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
});
