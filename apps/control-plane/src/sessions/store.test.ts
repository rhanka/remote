import type { SessionDescriptor } from "@sentropic/remote-protocol";
import { describe, expect, it } from "vitest";

import { SessionStore } from "./store.js";

function desc(id: string): SessionDescriptor {
  return {
    id,
    profile: "shell",
    target: "k3s",
    workspacePath: "/workspace",
    createdAt: new Date().toISOString(),
    createdBy: {
      id: "control-plane",
      kind: "control-plane",
      displayName: "Control Plane",
    },
  };
}

describe("SessionStore partition", () => {
  it("lists only the owner's sessions and hides others", () => {
    const s = new SessionStore();
    s.put(desc("a1"), "alice");
    s.put(desc("b1"), "bob");
    expect(s.list("alice").map((d) => d.id)).toEqual(["a1"]);
    expect(s.get("a1", "bob")).toBeUndefined();
    expect(s.get("a1", "alice")?.id).toBe("a1");
  });

  it("hides delete across owners", () => {
    const s = new SessionStore();
    s.put(desc("a1"), "alice");
    expect(s.delete("a1", "bob")).toBe(false);
    expect(s.get("a1", "alice")?.id).toBe("a1");
    expect(s.delete("a1", "alice")).toBe(true);
    expect(s.get("a1", "alice")).toBeUndefined();
  });
});
