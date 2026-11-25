import { clientPreflight } from "@/lib/client-api";
import { modifyMailbox } from "@/lib/mail-client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export const POST = modifyMailbox;
