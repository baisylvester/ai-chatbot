/** Parsing runs in a disposable browser worker; corrupt documents cannot stall the page. */
export function extractInBrowser(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker("/knowledge-parser.js");
    let settled = false;
    const finish = (text?: string, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (typeof text === "string") resolve(text);
      else reject(new Error(error || "Could not read this file."));
    };
    const timer = setTimeout(() => finish(undefined, "Reading timed out. Try a smaller file or save it as plain text."), 30_000);
    worker.onmessage = ({ data }: MessageEvent<{ kind?: string; text?: string; error?: string }>) => {
      // PDF.js can send its own internal worker handshake before extraction finishes.
      if (data?.kind === "knowledge-extraction") finish(data.text, data.error);
    };
    worker.onerror = () => finish();
    worker.postMessage(file);
  });
}
