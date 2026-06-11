import { describe, expect, it } from "vitest";

import {
  buildForwardCommand,
  buildNoVncUrl,
  NOVNC_POD_PORT,
} from "./forward-url.js";

describe("noVNC forward URL", () => {
  it("defaults to interactive + autoconnect on the pod port, token on the path", () => {
    const url = buildNoVncUrl({ token: "deadbeef" });
    const u = new URL(url);
    expect(u.hostname).toBe("localhost");
    expect(Number(u.port)).toBe(NOVNC_POD_PORT);
    expect(u.pathname).toBe("/vnc.html");
    expect(u.searchParams.get("path")).toBe("websockify?token=deadbeef");
    expect(u.searchParams.get("autoconnect")).toBe("true");
    // interactive default → NO view_only param.
    expect(u.searchParams.get("view_only")).toBeNull();
  });

  it("sets view_only=true when not interactive", () => {
    const url = buildNoVncUrl({ token: "t", interactive: false });
    expect(new URL(url).searchParams.get("view_only")).toBe("true");
  });

  it("honours a local port and host override", () => {
    const url = buildNoVncUrl({
      token: "t",
      localPort: 7090,
      host: "127.0.0.1",
    });
    const u = new URL(url);
    expect(u.hostname).toBe("127.0.0.1");
    expect(Number(u.port)).toBe(7090);
  });

  it("never leaks the token outside the path param", () => {
    const url = buildNoVncUrl({ token: "s3cr3t" });
    // token appears exactly once, inside the encoded path value.
    const occurrences = url.split("s3cr3t").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("remote forward command", () => {
  it("targets the noVNC pod port", () => {
    expect(buildForwardCommand("sess-1")).toBe(
      `remote forward sess-1 ${NOVNC_POD_PORT}`,
    );
  });

  it("appends a local port when given", () => {
    expect(buildForwardCommand("sess-1", 7090)).toBe(
      `remote forward sess-1 ${NOVNC_POD_PORT} 7090`,
    );
  });
});
