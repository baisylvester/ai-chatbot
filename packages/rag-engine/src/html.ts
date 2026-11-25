/** HTML to readable text. Kept apart from extract.ts so it can be used without the document parsers. */
import { convert } from "html-to-text";

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "footer", format: "skip" },
      { selector: "noscript", format: "skip" },
    ],
  });
}
