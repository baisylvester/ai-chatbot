/// <reference path="./word-extractor.d.ts" />
import { createRequire } from "node:module";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import WordExtractor from "word-extractor";

/** Legacy OLE documents use a separate thread so a corrupt sector chain cannot stall the web server. */
export function extractLegacyDoc(bytes: Uint8Array): Promise<string> {
  // The static import also lets deployment tracing include the worker's parser and its dependencies.
  if (typeof WordExtractor !== "function") throw new Error("Word reader is unavailable");
  // A bundler module ID is not a filesystem path the worker can require. Resolve through Node at runtime.
  const nativeRequire = Reflect.apply(createRequire, undefined, [import.meta.url]) as NodeJS.Require;
  let extractorPath: string;
  try { extractorPath = nativeRequire.resolve("word-extractor"); }
  catch { extractorPath = (Reflect.apply(createRequire, undefined, [join(process.cwd(), "package.json")]) as NodeJS.Require).resolve("word-extractor"); }
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const WordExtractor = require(workerData.extractorPath);
      new WordExtractor().extract(Buffer.from(workerData.bytes)).then((doc) => {
        const text = [doc.getBody(), doc.getFootnotes(), doc.getEndnotes(), doc.getTextboxes()].join('\\n\\n');
        if (text.length > 2000000) throw new Error('Too much text');
        parentPort.postMessage({ text });
      }).catch(() => parentPort.postMessage({ error: true }));
    `, { eval: true, execArgv: [], workerData: { bytes, extractorPath }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    let settled = false;
    const finish = (text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      if (text !== undefined) resolve(text);
      else reject(new Error("Could not read the DOC file. Save it as DOCX and try again."));
    };
    const timer = setTimeout(() => finish(), 10_000);
    worker.once("message", (message: { text?: string }) => finish(typeof message.text === "string" ? message.text : undefined));
    worker.once("error", () => finish());
    worker.once("exit", () => finish());
  });
}
