import { describe, expect, it } from "vitest";
import { mapModel, toCodexRequest } from "./proxy-openai.js";

describe("OpenAI/Codex model mapping", () => {
  it("maps Claude Sonnet/Haiku defaults to gpt-5.5 for Codex OAuth", () => {
    expect(mapModel("claude-sonnet-4-6")).toBe("gpt-5.5");
    expect(mapModel("claude-sonnet-4-5")).toBe("gpt-5.5");
    expect(mapModel("claude-haiku-4-5-20251001")).toBe("gpt-5.5");
  });

  it("keeps xhigh Claude requests on a Codex-supported model", () => {
    const req = toCodexRequest({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "continue" }],
      max_tokens: 4096,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 50_000 },
    });

    expect(req).toMatchObject({
      model: "gpt-5.5",
      reasoning: { effort: "high" },
    });
  });

  it("serializes Anthropic system blocks into Codex instructions text", () => {
    const req = toCodexRequest({
      model: "claude-sonnet-4-6",
      system: [
        { type: "text", text: "You are precise." },
        { type: "text", text: "Use tools carefully." },
      ],
      messages: [{ role: "user", content: "continue" }],
      max_tokens: 4096,
      stream: true,
    });

    expect(req.instructions).toBe("You are precise.\n\nUse tools carefully.");
  });
});
