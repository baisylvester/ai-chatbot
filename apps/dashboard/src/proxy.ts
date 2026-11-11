import { auth } from "@/lib/auth/server";

// Redirects signed-out visitors away from the dashboard and refreshes sessions.
// Pages and server actions still check the session themselves (see lib/session.ts).
export default auth.middleware({ loginUrl: "/auth/sign-in" });

export const config = {
  matcher: ["/orgs/:path*", "/workspaces/:path*", "/websites/:path*", "/chatbots/:path*"],
};
