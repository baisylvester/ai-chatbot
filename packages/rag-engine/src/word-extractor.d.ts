declare module "word-extractor" {
  interface WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getTextboxes(): string;
  }
  export default class WordExtractor {
    extract(contents: Buffer): Promise<WordDocument>;
  }
}
