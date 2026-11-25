import { clientPreflight } from "@/lib/client-api";
import { assistWriting } from "@/lib/mail-client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export const POST = assistWriting;
