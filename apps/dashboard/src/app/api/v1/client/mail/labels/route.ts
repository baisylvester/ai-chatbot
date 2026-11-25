import { clientPreflight } from "@/lib/client-api";
import { listMailLabels, createMailLabel } from "@/lib/mail-client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = clientPreflight;
export const GET = listMailLabels;
export const POST = createMailLabel;
