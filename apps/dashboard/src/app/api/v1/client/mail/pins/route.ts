import { clientPreflight } from "@/lib/client-api";
import { listPinned, pinMessage } from "@/lib/mail-client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export const GET = listPinned;
export const POST = pinMessage;
