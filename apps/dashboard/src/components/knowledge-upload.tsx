"use client";

import Link from "next/link";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { detectFormat, MAX_UPLOAD_BYTES, UPLOAD_ACCEPT } from "@chatbot/rag-engine/formats";
import type { ActionState } from "@/lib/action-result";
import { extractInBrowser } from "@/lib/browser-extraction";

type UploadAction = (state: ActionState, data: FormData) => Promise<ActionState>;

/** Files per batch. Each file is still authorized, validated and stored by its own server action call. */
export const MAX_FILES_PER_UPLOAD = 10;

type ItemStatus = "queued" | "reading" | "uploading" | "done" | "failed";
interface Item { key: string; file: File; status: ItemStatus; message?: string }

const statusLabel: Record<ItemStatus, string> = {
  queued: "Ready to upload", reading: "Reading…", uploading: "Uploading…", done: "Added", failed: "Failed",
};
const statusClass: Record<ItemStatus, string> = {
  queued: "text-zinc-500",
  reading: "text-blue-700 dark:text-blue-400",
  uploading: "text-blue-700 dark:text-blue-400",
  done: "text-emerald-700 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
};

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Why a file can't be queued, or null when it can. The server action repeats these checks. */
function rejection(file: File): string | null {
  if (!file.size) return "is empty";
  if (file.size > MAX_UPLOAD_BYTES) return "is larger than 10 MB";
  if (!detectFormat(file.name, file.type)) return "is not a PDF, DOC, DOCX, TXT, Markdown or HTML file";
  return null;
}

/**
 * Uploads one or more knowledge files: a keyboard-accessible picker and drop target, a queue with
 * per-file progress, and a server-validated destination. Files go up one after another, so a failure
 * in one never blocks the rest and failed files can be retried on their own.
 */
export function KnowledgeUpload({ action, sourceId, chatbotId, sources = [] }: {
  action: UploadAction;
  sourceId?: string;
  chatbotId?: string;
  sources?: { id: string; name: string }[];
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [destination, setDestination] = useState(sources[0]?.id ?? "");
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const [resultSourceId, setResultSourceId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const waiting = items.filter((item) => item.status === "queued" || item.status === "failed");
  const finished = items.filter((item) => item.status === "done").length;
  const update = (key: string, patch: Partial<Item>) =>
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  function add(files: FileList | File[]) {
    if (pending) return;
    const problems: string[] = [];
    const next = items.filter((item) => item.status !== "done");
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (next.some((item) => item.key === key)) continue;
      const problem = rejection(file);
      if (problem) { problems.push(`"${file.name}" ${problem}`); continue; }
      if (next.length >= MAX_FILES_PER_UPLOAD) { problems.push(`Only ${MAX_FILES_PER_UPLOAD} files can be uploaded at a time; "${file.name}" was left out`); continue; }
      next.push({ key, file, status: "queued" });
    }
    setItems(next);
    setError(problems.length ? `${problems.join(". ")}.` : null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!waiting.length) { setError("Choose at least one file to upload."); return; }
    setError(null);
    const form = new FormData(event.currentTarget);
    const title = waiting.length === 1 ? String(form.get("title") ?? "").trim() : "";
    const sourceName = String(form.get("sourceName") ?? "").trim();
    let target = sourceId ?? destination;
    startTransition(async () => {
      for (const { key, file } of waiting) {
        try {
          const data = new FormData();
          if (target) data.set("sourceId", target);
          if (chatbotId) data.set("chatbotId", chatbotId);
          if (!target && sourceName) data.set("sourceName", sourceName);
          if (title) data.set("title", title);
          if (process.env.NEXT_PUBLIC_BROWSER_EXTRACTION === "1") {
            update(key, { status: "reading", message: undefined });
            data.set("extractedContent", await extractInBrowser(file));
            data.set("fileSizeBytes", String(file.size));
            // The original binary stays in the browser. Only metadata and extracted text are sent.
            data.set("file", new File(["."], file.name, { type: file.type }));
          } else {
            data.set("file", file, file.name);
          }
          update(key, { status: "uploading", message: undefined });
          const result = await action(null, data);
          if (result?.error) { update(key, { status: "failed", message: result.error }); continue; }
          update(key, { status: "done", message: result?.ok });
          if (result?.sourceId) {
            // A source created by the first file receives the rest of the batch too.
            if (!target && chatbotId) setCreated({ id: result.sourceId, name: sourceName || "Uploaded files" });
            target = result.sourceId;
            setDestination(result.sourceId);
            setResultSourceId(result.sourceId);
          }
        } catch (err) {
          update(key, { status: "failed", message: err instanceof Error ? err.message : "Could not read this file." });
        }
      }
    });
  }

  const options = created && !sources.some((source) => source.id === created.id) ? [...sources, created] : sources;
  const inputClass = "rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700";
  return (
    <form onSubmit={submit} className="space-y-4" aria-busy={pending}>
      <div
        onDragOver={(event) => { event.preventDefault(); if (!pending) setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); add(event.dataTransfer.files); }}
        className={`rounded-lg border-2 border-dashed p-5 ${pending ? "opacity-60" : ""} ${dragging ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/50"}`}
      >
        <label htmlFor={`${id}-file`} className="block font-medium">Choose files or drop them here</label>
        <p id={`${id}-hint`} className="mt-1 text-sm text-zinc-500">
          PDF, Word (.doc or .docx), TXT, Markdown or HTML · Up to 10 MB each · {MAX_FILES_PER_UPLOAD} files at a time
        </p>
        <input ref={inputRef} id={`${id}-file`} type="file" multiple accept={UPLOAD_ACCEPT} disabled={pending}
          aria-describedby={`${id}-hint`} onChange={(event) => add(event.currentTarget.files ?? [])}
          className="mt-3 block max-w-full text-sm file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-2 file:font-medium file:text-zinc-900 dark:file:border-zinc-600 dark:file:bg-zinc-800 dark:file:text-zinc-100" />
      </div>

      {items.length > 0 && (
        <ul aria-label="Files" className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
          {items.map((item) => (
            <li key={item.key} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="break-all font-medium">{item.file.name}</div>
                <div className="text-xs text-zinc-500">{formatSize(item.file.size)}</div>
                {item.status === "failed" && item.message && <div className="mt-0.5 text-xs text-red-600 dark:text-red-400">{item.message}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span role="status" className={`text-xs font-medium ${statusClass[item.status]}`}>{statusLabel[item.status]}</span>
                {!pending && item.status !== "done" && (
                  <button type="button" onClick={() => setItems((list) => list.filter((other) => other.key !== item.key))}
                    aria-label={`Remove ${item.file.name}`} className="rounded px-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
                    ✕
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <fieldset disabled={pending} className="min-w-0 space-y-4 disabled:opacity-60">
        <legend className="sr-only">Upload options</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {waiting.length === 1 && <label className="flex min-w-0 flex-col gap-1 text-sm" htmlFor={`${id}-title`}>
            <span className="font-medium">Document title <span className="font-normal text-zinc-500">(optional)</span></span>
            <input id={`${id}-title`} name="title" maxLength={300} placeholder="Defaults to the file name" className={inputClass} />
          </label>}
          {chatbotId && <label className="flex min-w-0 flex-col gap-1 text-sm" htmlFor={`${id}-source`}>
            <span className="font-medium">Knowledge source</span>
            <select id={`${id}-source`} value={destination} onChange={(e) => setDestination(e.target.value)} className={inputClass}>
              {options.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
              <option value="">Create a new source</option>
            </select>
          </label>}
          {chatbotId && !destination && <label className="flex min-w-0 flex-col gap-1 text-sm" htmlFor={`${id}-source-name`}>
            <span className="font-medium">New source name</span>
            <input id={`${id}-source-name`} name="sourceName" defaultValue="Uploaded files" maxLength={200} required className={inputClass} />
          </label>}
        </div>
        <p className="text-xs text-zinc-500">Text is extracted for the knowledge base. Original files are not retained. Scanned PDFs need OCR before uploading.</p>
        <button type="submit" disabled={pending || !waiting.length} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
          {pending ? "Uploading…" : waiting.length > 1 ? `Upload ${waiting.length} files` : waiting.some((item) => item.status === "failed") ? "Retry upload" : "Upload to knowledge base"}
        </button>
      </fieldset>

      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!pending && finished > 0 && <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
        <p>
          {finished === 1 ? items.find((item) => item.status === "done")?.message ?? "1 file added." : `${finished} files added to the knowledge base.`}
          {waiting.length > 0 && ` ${waiting.length} still ${waiting.length === 1 ? "needs" : "need"} attention.`}
        </p>
        {resultSourceId && <Link href={`/knowledge/${resultSourceId}`} className="mt-1 inline-block font-medium underline">View documents and processing status</Link>}
      </div>}
    </form>
  );
}
