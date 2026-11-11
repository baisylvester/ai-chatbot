"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { detectFormat, MAX_UPLOAD_BYTES, UPLOAD_ACCEPT } from "@chatbot/rag-engine/formats";
import type { ActionState } from "@/lib/action-result";
import { extractInBrowser } from "@/lib/browser-extraction";

type UploadAction = (state: ActionState, data: FormData) => Promise<ActionState>;

/** One-file upload with a keyboard-accessible picker, drop target and server-validated destination. */
export function KnowledgeUpload({ action, sourceId, chatbotId, sources = [] }: {
  action: UploadAction;
  sourceId?: string;
  chatbotId?: string;
  sources?: { id: string; name: string }[];
}) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const [destination, setDestination] = useState(sources[0]?.id ?? "");
  const [state, formAction, actionPending] = useActionState(action, null);
  const [transitionPending, startTransition] = useTransition();
  const pending = actionPending || transitionPending;

  useEffect(() => {
    if (state?.ok) {
      setFile(null);
      setError(null);
      formRef.current?.reset();
      if (state.sourceId) setDestination(state.sourceId);
    }
  }, [state]);

  function choose(files: FileList | File[]) {
    if (pending) return;
    const selected = files[0];
    setFeedbackVisible(false);
    setError(null);
    setFile(null);
    if (files.length > 1) { setError("Choose one file at a time."); return; }
    if (!selected) return;
    if (!selected.size) { setError("The file is empty. Choose a file containing text."); return; }
    if (selected.size > MAX_UPLOAD_BYTES) { setError("The file is larger than 10 MB."); return; }
    if (!detectFormat(selected.name, selected.type)) {
      setError("Choose a PDF, DOC, DOCX, TXT, Markdown or HTML file."); return;
    }
    setFile(selected);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) { setError("Choose a file to upload."); return; }
    setError(null);
    setFeedbackVisible(true);
    const data = new FormData(event.currentTarget);
    data.set("file", file, file.name);
    startTransition(async () => {
      try {
        if (process.env.NEXT_PUBLIC_BROWSER_EXTRACTION === "1") {
          const text = await extractInBrowser(file);
          data.set("extractedContent", text);
          data.set("fileSizeBytes", String(file.size));
          // The original binary stays in the browser. Only metadata and extracted text are sent.
          data.set("file", new File(["."], file.name, { type: file.type }));
        }
        formAction(data);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Could not read this file.");
      }
    });
  }

  const inputClass = "rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700";
  return (
    <form ref={formRef} action={formAction} onSubmit={submit} className="space-y-4" aria-busy={pending}>
      {sourceId && <input type="hidden" name="sourceId" value={sourceId} />}
      {chatbotId && <input type="hidden" name="chatbotId" value={chatbotId} />}
      <fieldset disabled={pending} className="min-w-0 space-y-4 disabled:opacity-60">
        <legend className="sr-only">Upload a knowledge file</legend>
        <div
          onDragOver={(event) => { event.preventDefault(); if (!pending) setDragging(true); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files); }}
          className={`rounded-lg border-2 border-dashed p-5 ${dragging ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/50"}`}
        >
          <label htmlFor={`${id}-file`} className="block font-medium">Choose a file or drop it here</label>
          <p id={`${id}-hint`} className="mt-1 text-sm text-zinc-500">PDF, Word (.doc or .docx), or text · Up to 10 MB</p>
          <input id={`${id}-file`} type="file" name="file" accept={UPLOAD_ACCEPT}
            aria-describedby={`${id}-hint`} onChange={(event) => choose(event.currentTarget.files ?? [])}
            className="mt-3 block max-w-full text-sm file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-2 file:font-medium file:text-zinc-900 dark:file:border-zinc-600 dark:file:bg-zinc-800 dark:file:text-zinc-100" />
          {file && <p className="mt-3 break-all text-sm" role="status">Selected: {file.name} · {file.size < 1024 * 1024 ? `${Math.max(1, Math.ceil(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1 text-sm" htmlFor={`${id}-title`}>
            <span className="font-medium">Document title <span className="font-normal text-zinc-500">(optional)</span></span>
            <input id={`${id}-title`} name="title" maxLength={300} placeholder="Defaults to the file name" className={inputClass} />
          </label>
          {chatbotId && <label className="flex min-w-0 flex-col gap-1 text-sm" htmlFor={`${id}-source`}>
            <span className="font-medium">Knowledge source</span>
            <select id={`${id}-source`} name="sourceId" value={destination} onChange={(e) => setDestination(e.target.value)} className={inputClass}>
              {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
              <option value="">Create a new source</option>
            </select>
          </label>}
          {chatbotId && !destination && <label className="flex min-w-0 flex-col gap-1 text-sm" htmlFor={`${id}-source-name`}>
            <span className="font-medium">New source name</span>
            <input id={`${id}-source-name`} name="sourceName" defaultValue="Uploaded files" maxLength={200} required className={inputClass} />
          </label>}
        </div>
        <p className="text-xs text-zinc-500">Text is extracted for the knowledge base. Original files are not retained. Scanned PDFs need OCR before uploading.</p>
        <button type="submit" disabled={pending || !file} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
          {pending ? "Uploading and reading…" : "Upload knowledge file"}
        </button>
      </fieldset>
      {(error || (feedbackVisible && !pending && state?.error)) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error || state?.error}</p>}
      {feedbackVisible && !pending && state?.ok && <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
        <p>{state.ok}</p>
        {state.sourceId && <Link href={`/knowledge/${state.sourceId}`} className="mt-1 inline-block font-medium underline">View documents and processing status</Link>}
      </div>}
    </form>
  );
}
