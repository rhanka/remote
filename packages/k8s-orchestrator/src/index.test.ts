import type { SessionDescriptor } from "@sentropic/remote-protocol";
import { describe, expect, it } from "vitest";

import { InMemoryProvisioner, type ProvisionerEmit } from "./index.js";

const descriptor: SessionDescriptor = {
  id: "sess-abc",
  profile: "codex",
  target: "k3s",
  workspacePath: "/workspace",
  createdAt: "2026-05-14T18:00:00.000Z",
  createdBy: {
    id: "control-plane",
    kind: "control-plane",
    displayName: "Control Plane",
  },
};

describe("InMemoryProvisioner", () => {
  it("emits requested→provisioning→starting→ready lifecycle events", async () => {
    const provisioner = new InMemoryProvisioner();
    const events: Array<{
      sessionId: string;
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    const emit: ProvisionerEmit = (sessionId, type, payload) => {
      events.push({ sessionId, type, payload });
    };

    await provisioner.provision(descriptor, emit);

    expect(events).toHaveLength(3);
    expect(events.map((event) => event.payload.nextState)).toEqual([
      "provisioning",
      "starting",
      "ready",
    ]);
    expect(events.every((event) => event.sessionId === descriptor.id)).toBe(
      true,
    );

    const inspected = await provisioner.inspect(descriptor.id);
    expect(inspected?.phase).toBe("ready");
  });

  it("emits stopping then stopped on destroy and forgets the session", async () => {
    const provisioner = new InMemoryProvisioner();
    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const emit: ProvisionerEmit = (_id, type, payload) => {
      events.push({ type, payload });
    };

    await provisioner.provision(descriptor, () => {});
    await provisioner.destroy(descriptor.id, emit);

    expect(events).toHaveLength(2);
    expect(events[0]!.payload.nextState).toBe("stopping");
    expect(events[1]!.payload.nextState).toBe("stopped");
    expect(await provisioner.inspect(descriptor.id)).toBeUndefined();
  });
});
