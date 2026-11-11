import { describe, expect, it } from "vitest";
import { publicChatbotIdSchema } from "@chatbot/shared";
import { generatePublicChatbotId } from "../src/ids.ts";

describe("generatePublicChatbotId", () => {
  it("produces ids accepted by the shared schema and the database check", () => {
    for (let i = 0; i < 100; i++) {
      const value = generatePublicChatbotId();
      expect(publicChatbotIdSchema.safeParse(value).success).toBe(true);
      expect(value).toMatch(/^cb_[A-Za-z0-9]{24}$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generatePublicChatbotId()));
    expect(seen.size).toBe(1000);
  });
});
