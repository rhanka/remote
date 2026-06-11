import { describe, expect, it } from "vitest";

import { detectThrottle, THROTTLE_TAIL_LINES } from "./throttle-signatures.js";

describe("detectThrottle (per-tool provider rate-limit signatures)", () => {
  describe("claude positives", () => {
    it("matches the canonical 'temporarily limiting requests' transient", () => {
      const tail =
        "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
      const v = detectThrottle(tail, "claude");
      expect(v.throttled).toBe(true);
      expect(v.signature).toBe("claude:temporarily-limiting");
    });

    it("matches an API Error line carrying 'rate limit'", () => {
      const v = detectThrottle("API Error: 429 rate limit exceeded", "claude");
      expect(v.throttled).toBe(true);
    });

    it("matches 'overloaded' on an Error line", () => {
      const v = detectThrottle("Error: server overloaded, retry later", "claude");
      expect(v.throttled).toBe(true);
    });

    it("matches a bulleted '· Rate limited' marker", () => {
      const v = detectThrottle("some output\n · Rate limited", "claude");
      expect(v.throttled).toBe(true);
    });
  });

  describe("codex positives", () => {
    it("matches 'Rate limit reached'", () => {
      const v = detectThrottle("Rate limit reached for gpt-5", "codex");
      expect(v.throttled).toBe(true);
      expect(v.signature).toBe("codex:rate-limit-reached");
    });

    it("matches a 429 transport error", () => {
      const v = detectThrottle("stream error: server returned 429", "codex");
      expect(v.throttled).toBe(true);
    });
  });

  describe("agy positives", () => {
    it("matches RESOURCE_EXHAUSTED", () => {
      const v = detectThrottle("Error: RESOURCE_EXHAUSTED: quota", "agy");
      expect(v.throttled).toBe(true);
      expect(v.signature).toBe("agy:resource-exhausted");
    });

    it("matches a quota-exceeded transport error", () => {
      const v = detectThrottle("Error: 429 quota exceeded", "agy");
      expect(v.throttled).toBe(true);
    });
  });

  describe("negatives (conservatism guard — no bare-word matches)", () => {
    it("does NOT match the model quoting the phrase mid-sentence", () => {
      const prose =
        "Here is how rate limiting works: when you hit a rate limit the server returns 429. " +
        "I have updated the docs to mention overloaded servers.";
      expect(detectThrottle(prose, "claude").throttled).toBe(false);
      expect(detectThrottle(prose, "codex").throttled).toBe(false);
      expect(detectThrottle(prose, "agy").throttled).toBe(false);
    });

    it("does NOT match a normal successful run", () => {
      const tail = "Done.\nWrote 3 files.\nAll tests pass.";
      expect(detectThrottle(tail, "claude").throttled).toBe(false);
    });

    it("does NOT match a real (non-throttle) error", () => {
      const tail = "Error: ENOENT: no such file or directory, open 'x.ts'";
      expect(detectThrottle(tail, "claude").throttled).toBe(false);
      expect(detectThrottle(tail, "codex").throttled).toBe(false);
    });

    it("empty / whitespace tail is not throttled", () => {
      expect(detectThrottle("", "claude").throttled).toBe(false);
      expect(detectThrottle("   \n  ", "codex").throttled).toBe(false);
    });

    it("a 429 mentioned as a literal status code in prose without error shape is not matched", () => {
      // "the endpoint returns 429" — no error prefix, no 'too many requests'.
      expect(detectThrottle("the endpoint returns 429 sometimes", "claude").throttled).toBe(
        false,
      );
    });
  });

  describe("tail windowing (only the last ~60 lines)", () => {
    it("ignores a throttle signature OUTSIDE the tail window", () => {
      const old = "API Error: temporarily limiting requests";
      const filler = Array.from({ length: 80 }, (_v, i) => `line ${i}`).join("\n");
      const tail = `${old}\n${filler}`;
      // With a small window the old signature falls off → not matched.
      expect(detectThrottle(tail, "claude", 10).throttled).toBe(false);
    });

    it("matches a signature INSIDE the tail window", () => {
      const filler = Array.from({ length: 80 }, (_v, i) => `line ${i}`).join("\n");
      const tail = `${filler}\nAPI Error: temporarily limiting requests`;
      expect(detectThrottle(tail, "claude", 10).throttled).toBe(true);
    });

    it("default window is 60 lines", () => {
      expect(THROTTLE_TAIL_LINES).toBe(60);
    });
  });
});
