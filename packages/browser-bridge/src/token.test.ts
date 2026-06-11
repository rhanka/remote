import { describe, expect, it } from "vitest";

import { mintNoVncToken, toHex, type RandomBytes } from "./token.js";

describe("noVNC token", () => {
  it("encodes bytes to lower-case hex", () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xab, 0xff]))).toBe("000fabff");
  });

  it("mints a 32-char hex token (16 bytes) from the injected RNG", () => {
    const rng: RandomBytes = (n) => new Uint8Array(n).fill(0xab);
    const token = mintNoVncToken(rng);
    expect(token).toBe("ab".repeat(16));
    expect(token).toHaveLength(32);
  });

  it("is deterministic under a deterministic RNG (test seam works)", () => {
    let counter = 0;
    const rng: RandomBytes = (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (counter + i) & 0xff;
      counter += n;
      return out;
    };
    const a = mintNoVncToken(rng);
    const b = mintNoVncToken(rng);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("default RNG produces 128-bit hex without throwing", () => {
    const token = mintNoVncToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});
