import { describe, it, expect } from "bun:test";
import { sendMessageSync, type Message } from "./client.ts";
import { getAuth } from "./auth.ts";
import { SYSTEM_PROMPT, DEFAULT_MODEL, buildSystemPrompt } from "./headers.ts";

describe("client", () => {
  describe("request body shape", () => {
    it("SYSTEM_PROMPT has 3 blocks: billing, identity, instructions", () => {
      expect(SYSTEM_PROMPT.length).toBeGreaterThanOrEqual(3);
      expect(SYSTEM_PROMPT[0].text).toContain("x-anthropic-billing-header");
      expect(SYSTEM_PROMPT[0].text).toContain("cc_version=2.1.91");
      expect(SYSTEM_PROMPT[1].text).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      );
      // cache_control is on system[2] (instructions), NOT system[1] (identity)
      expect(SYSTEM_PROMPT[1]).not.toHaveProperty("cache_control");
      expect(SYSTEM_PROMPT[2].cache_control).toEqual({ type: "ephemeral", scope: "global" });
    });

    it("buildSystemPrompt with session context produces 4 blocks", () => {
      const blocks = buildSystemPrompt({ sessionContext: "test context" });
      expect(blocks).toHaveLength(4);
      expect(blocks[3].text).toBe("test context");
      expect(blocks[3]).not.toHaveProperty("cache_control");
    });
  });

  describe("e2e", () => {
    const skip = !process.env.E2E;

    it.skipIf(skip)("sends a haiku request and gets a response", async () => {
      const auth = await getAuth();
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Reply with exactly: PONG" }] },
      ];

      const response = await sendMessageSync({
        auth,
        messages,
        model: "claude-haiku-4-5-20251001",
        maxTokens: 32,
        stream: true,
      });

      expect(response.length).toBeGreaterThan(0);
      expect(response.toUpperCase()).toContain("PONG");
    }, 30_000);

    it.skipIf(skip)("sends a non-streaming request", async () => {
      const auth = await getAuth();
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Reply with exactly: HELLO" }] },
      ];

      const response = await sendMessageSync({
        auth,
        messages,
        model: "claude-haiku-4-5-20251001",
        maxTokens: 32,
        stream: false,
      });

      expect(response.length).toBeGreaterThan(0);
      expect(response.toUpperCase()).toContain("HELLO");
    }, 30_000);
  });
});
