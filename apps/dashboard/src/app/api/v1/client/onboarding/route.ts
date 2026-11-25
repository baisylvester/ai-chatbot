import { withClientRequest, clientTrusted, clientPreflight, clientError } from "@/lib/client-api";
import { provisionNativeAccount } from "@/lib/native-onboarding";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
/** No owner, organization, or chatbot identifiers are accepted from the client. */
export async function POST(request: Request) {
  return withClientRequest(request, async user => {
    try { return Response.json(await clientTrusted(db => provisionNativeAccount(db,user))); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "42P01") return clientError(503,"unavailable","Account setup is temporarily unavailable. Please try again later.");
      throw error;
    }
  });
}
