import type { SessionDescriptor } from "@sentropic/remote-protocol";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUILDER_OPTIONS,
  buildSessionPodSpec,
  buildSessionPvcSpec,
  resourceNames,
  sessionLabels,
} from "./spec.js";

const baseDescriptor: SessionDescriptor = {
  id: "sess-abcdef",
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

describe("k8s spec builders", () => {
  it("produces stable names and labels for the session", () => {
    const names = resourceNames(baseDescriptor);
    expect(names.pod).toBe("session-sess-abcdef");
    expect(names.pvc).toBe("session-sess-abcdef-workspace");

    const labels = sessionLabels(baseDescriptor);
    expect(labels["sentropic.dev/session-id"]).toBe(baseDescriptor.id);
    expect(labels["sentropic.dev/profile"]).toBe("codex");
    expect(labels["sentropic.dev/target"]).toBe("k3s");
    expect(labels["app.kubernetes.io/component"]).toBe("session-agent");
  });

  it("builds a PVC with the default workspace size when no limit is set", () => {
    const pvc = buildSessionPvcSpec(baseDescriptor);
    expect(pvc.kind).toBe("PersistentVolumeClaim");
    expect(pvc.metadata.namespace).toBe(DEFAULT_BUILDER_OPTIONS.namespace);
    expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(pvc.spec.resources.requests.storage).toBe(
      DEFAULT_BUILDER_OPTIONS.defaultWorkspaceSize,
    );
    expect(pvc.spec.storageClassName).toBeUndefined();
  });

  it("respects descriptor resource limits and override options", () => {
    const descriptor: SessionDescriptor = {
      ...baseDescriptor,
      resourceLimits: { cpu: "500m", memory: "256Mi" },
    };
    const pvc = buildSessionPvcSpec(descriptor, {
      ...DEFAULT_BUILDER_OPTIONS,
      storageClassName: "local-path",
      defaultWorkspaceSize: "5Gi",
    });
    expect(pvc.spec.resources.requests.storage).toBe("5Gi");
    expect(pvc.spec.storageClassName).toBe("local-path");

    const pod = buildSessionPodSpec(descriptor);
    const container = pod.spec.containers[0]!;
    expect(container.resources?.limits?.cpu).toBe("500m");
    expect(container.resources?.requests?.memory).toBe("256Mi");
  });

  it("builds a Pod that mounts the PVC at the workspace path", () => {
    const pod = buildSessionPodSpec(baseDescriptor);
    expect(pod.kind).toBe("Pod");
    expect(pod.spec.restartPolicy).toBe("Never");

    const container = pod.spec.containers[0]!;
    expect(container.image).toBe(DEFAULT_BUILDER_OPTIONS.image);
    expect(container.volumeMounts[0]!.mountPath).toBe(
      baseDescriptor.workspacePath,
    );
    expect(
      container.env.find((entry) => entry.name === "SESSION_ID")?.value,
    ).toBe(baseDescriptor.id);
    expect(
      container.env.find((entry) => entry.name === "CONTROL_PLANE_ENDPOINT")
        ?.value,
    ).toBe(DEFAULT_BUILDER_OPTIONS.controlPlaneEndpoint);

    const volume = pod.spec.volumes[0]!;
    expect(volume.persistentVolumeClaim.claimName).toBe(
      resourceNames(baseDescriptor).pvc,
    );
  });
});
