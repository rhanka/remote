import type { SessionDescriptor } from "@sentropic/remote-protocol";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUILDER_OPTIONS,
  JANITOR_IMAGE,
  JANITOR_TRASH_DIR,
  JANITOR_WORKSPACES_MOUNT,
  buildSessionPodSpec,
  buildSessionPvcSpec,
  buildWorkspaceGcJanitorPodSpec,
  buildWorkspaceGcScript,
  buildWorkspacePvcSpec,
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

  it("can build File Storage RWX PVCs when the access mode is overridden", () => {
    const sessionPvc = buildSessionPvcSpec(baseDescriptor, {
      ...DEFAULT_BUILDER_OPTIONS,
      storageClassName: "matchid-rwx",
      storageAccessMode: "ReadWriteMany",
    });
    expect(sessionPvc.spec.storageClassName).toBe("matchid-rwx");
    expect(sessionPvc.spec.accessModes).toEqual(["ReadWriteMany"]);

    const workspacePvc = buildWorkspacePvcSpec("ws-rwx", {
      ...DEFAULT_BUILDER_OPTIONS,
      storageClassName: "matchid-rwx",
      storageAccessMode: "ReadWriteMany",
    });
    expect(workspacePvc.spec.storageClassName).toBe("matchid-rwx");
    expect(workspacePvc.spec.accessModes).toEqual(["ReadWriteMany"]);
  });

  it("mounts the shared workspace PVC with per-workspace subPaths when configured", () => {
    const pod = buildSessionPodSpec(
      { ...baseDescriptor, workspaceId: "ws-abc1234", profile: "claude" },
      {
        ...DEFAULT_BUILDER_OPTIONS,
        sharedWorkspacePvc: "remote-workspaces",
        home: "/home/antoinefa",
      },
    );
    const volume = pod.spec.volumes[0]!;
    expect(
      "persistentVolumeClaim" in volume && volume.persistentVolumeClaim.claimName,
    ).toBe("remote-workspaces");
    // workspace mount: shared claim + subPath <workspaceId>
    const ws = pod.spec.containers[0]!.volumeMounts.find(
      (m) => m.mountPath === baseDescriptor.workspacePath,
    );
    expect(ws?.subPath).toBe("ws-abc1234");
    // conversation mount nests under the workspace subdir
    const conv = pod.spec.containers[0]!.volumeMounts.find((m) =>
      m.mountPath.endsWith(".claude/projects"),
    );
    expect(conv?.subPath).toBe(
      "ws-abc1234/.remote/sessions/claude/.claude/projects",
    );
  });

  it("prefers co-locating sessions with existing remote pods (interstice packing)", () => {
    const pod = buildSessionPodSpec(baseDescriptor);
    const pref =
      pod.spec.affinity?.podAffinity
        ?.preferredDuringSchedulingIgnoredDuringExecution?.[0];
    expect(pref?.podAffinityTerm.topologyKey).toBe("kubernetes.io/hostname");
    expect(pref?.podAffinityTerm.labelSelector.matchLabels).toEqual({
      "app.kubernetes.io/name": "sentropic-remote",
      "app.kubernetes.io/component": "control-plane",
    });
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
    expect("persistentVolumeClaim" in volume).toBe(true);
    if ("persistentVolumeClaim" in volume) {
      expect(volume.persistentVolumeClaim.claimName).toBe(
        resourceNames(baseDescriptor).pvc,
      );
    }
  });

  it("can target session Pods to a specific node pool", () => {
    const pod = buildSessionPodSpec(baseDescriptor, {
      ...DEFAULT_BUILDER_OPTIONS,
      nodeSelector: { "k8s.scaleway.com/pool-name": "burst" },
    });

    expect(pod.spec.nodeSelector).toEqual({
      "k8s.scaleway.com/pool-name": "burst",
    });
  });

  it("mounts the retained workspace PVC when the session is bound to a workspace", () => {
    const bound: SessionDescriptor = {
      ...baseDescriptor,
      workspaceId: "ws-abc",
    };
    const pod = buildSessionPodSpec(bound);
    const vol = pod.spec.volumes.find((v) => v.name === "workspace");
    expect(vol).toBeDefined();
    if (vol && "persistentVolumeClaim" in vol) {
      expect(vol.persistentVolumeClaim.claimName).toBe("workspace-ws-abc");
    } else {
      throw new Error("expected a PVC-backed workspace volume");
    }

    const unbound = buildSessionPodSpec(baseDescriptor);
    const uvol = unbound.spec.volumes.find((v) => v.name === "workspace");
    if (uvol && "persistentVolumeClaim" in uvol) {
      expect(uvol.persistentVolumeClaim.claimName).toMatch(
        /^session-.*-workspace$/,
      );
    }
  });

  it("sets SESSION_WORKSPACE_SYNC=1 only when workspaceSync is requested", () => {
    const off = buildSessionPodSpec(baseDescriptor);
    expect(
      off.spec.containers[0]!.env.find(
        (e) => e.name === "SESSION_WORKSPACE_SYNC",
      ),
    ).toBeUndefined();

    const on = buildSessionPodSpec(
      baseDescriptor,
      DEFAULT_BUILDER_OPTIONS,
      [],
      true,
    );
    expect(
      on.spec.containers[0]!.env.find(
        (e) => e.name === "SESSION_WORKSPACE_SYNC",
      )?.value,
    ).toBe("1");
  });

  it("sets HOME from descriptor.home, falling back to the builder option", () => {
    const withHome = buildSessionPodSpec({
      ...baseDescriptor,
      home: "/home/user",
    });
    expect(
      withHome.spec.containers[0]!.env.find((e) => e.name === "HOME")?.value,
    ).toBe("/home/user");

    const withoutHome = buildSessionPodSpec(baseDescriptor);
    expect(
      withoutHome.spec.containers[0]!.env.find((e) => e.name === "HOME")?.value,
    ).toBe(DEFAULT_BUILDER_OPTIONS.home);
  });

  it("passes startup args metadata into SESSION_STARTUP_ARGS", () => {
    const descriptor: SessionDescriptor = {
      ...baseDescriptor,
      metadata: {
        startup: { args: ["config", "install"] },
      },
    };
    const pod = buildSessionPodSpec(descriptor);
    const env = pod.spec.containers[0]!.env;
    const startupEnv = env.find(
      (entry) => entry.name === "SESSION_STARTUP_ARGS",
    );
    expect(startupEnv?.value).toBe(JSON.stringify(["config", "install"]));
  });

  it("stages the auth Secret under /run/auth-bundle and advertises the paths via env", () => {
    const pod = buildSessionPodSpec(baseDescriptor, DEFAULT_BUILDER_OPTIONS, [
      ".codex/auth.json",
      ".claude/.credentials.json",
    ]);
    const container = pod.spec.containers[0]!;
    const authMounts = container.volumeMounts.filter(
      (mount) => mount.name === "auth",
    );
    expect(authMounts).toHaveLength(2);
    expect(authMounts[0]!.mountPath).toBe("/run/auth-bundle/.codex/auth.json");
    expect(authMounts[0]!.subPath).toBe("codex_auth.json");
    expect(authMounts[0]!.readOnly).toBe(true);
    expect(authMounts[1]!.mountPath).toBe(
      "/run/auth-bundle/.claude/.credentials.json",
    );

    const stagingEnv = container.env.find(
      (entry) => entry.name === "SESSION_AUTH_STAGING_DIR",
    );
    const pathsEnv = container.env.find(
      (entry) => entry.name === "SESSION_AUTH_BUNDLE_PATHS",
    );
    expect(stagingEnv?.value).toBe("/run/auth-bundle");
    expect(pathsEnv?.value).toBe(".codex/auth.json:.claude/.credentials.json");

    const authVolume = pod.spec.volumes.find((vol) => vol.name === "auth");
    expect(authVolume).toBeDefined();
    expect("secret" in authVolume!).toBe(true);
    if ("secret" in authVolume!) {
      expect(authVolume.secret.secretName).toBe(
        resourceNames(baseDescriptor).authSecret,
      );
    }
  });
});

describe("workspace GC janitor spec", () => {
  const sharedOptions = {
    ...DEFAULT_BUILDER_OPTIONS,
    namespace: "user-abc12345",
    sharedWorkspacePvc: "remote-workspaces",
  };
  const gcBase = {
    name: "workspace-gc-test1",
    olderThanDays: 30,
    apply: false,
    keep: ["ws-keep1", "ws-keep2"],
    hasLiveSessions: false,
  };

  it("mounts the shared PVC at its ROOT — no subPath (sessions only see their slice)", () => {
    const pod = buildWorkspaceGcJanitorPodSpec(gcBase, sharedOptions);
    expect(pod.metadata.name).toBe("workspace-gc-test1");
    expect(pod.metadata.namespace).toBe("user-abc12345");
    expect(pod.metadata.labels["app.kubernetes.io/component"]).toBe(
      "workspace-janitor",
    );
    const mount = pod.spec.containers[0]!.volumeMounts[0]!;
    expect(mount.mountPath).toBe(JANITOR_WORKSPACES_MOUNT);
    expect(mount.subPath).toBeUndefined();
    expect(pod.spec.volumes[0]).toEqual({
      name: "workspace",
      persistentVolumeClaim: { claimName: "remote-workspaces" },
    });
  });

  it("uses a tiny pinned busybox with small requests", () => {
    const pod = buildWorkspaceGcJanitorPodSpec(gcBase, sharedOptions);
    const container = pod.spec.containers[0]!;
    expect(container.image).toBe(JANITOR_IMAGE);
    expect(container.resources?.requests).toEqual({
      cpu: "25m",
      memory: "32Mi",
    });
  });

  it("REQUIRES co-location with session pods when sessions are live (CSI: their node already mounts the volume)", () => {
    const pod = buildWorkspaceGcJanitorPodSpec(
      { ...gcBase, hasLiveSessions: true },
      sharedOptions,
    );
    const affinity = pod.spec.affinity!.podAffinity!;
    expect(affinity.requiredDuringSchedulingIgnoredDuringExecution).toEqual([
      {
        labelSelector: {
          matchLabels: {
            "app.kubernetes.io/name": "sentropic-remote",
            "app.kubernetes.io/component": "session-agent",
          },
        },
        topologyKey: "kubernetes.io/hostname",
      },
    ]);
    expect(
      affinity.preferredDuringSchedulingIgnoredDuringExecution,
    ).toBeUndefined();
  });

  it("relaxes to PREFERRED affinity when no session is live (required would be unsatisfiable)", () => {
    const pod = buildWorkspaceGcJanitorPodSpec(gcBase, sharedOptions);
    const affinity = pod.spec.affinity!.podAffinity!;
    expect(
      affinity.requiredDuringSchedulingIgnoredDuringExecution,
    ).toBeUndefined();
    expect(
      affinity.preferredDuringSchedulingIgnoredDuringExecution![0]!
        .podAffinityTerm.topologyKey,
    ).toBe("kubernetes.io/hostname");
  });

  it("refuses to build without the shared PVC (per-workspace mode has nothing to GC)", () => {
    expect(() =>
      buildWorkspaceGcJanitorPodSpec(gcBase, DEFAULT_BUILDER_OPTIONS),
    ).toThrow(/sharedWorkspacePvc/);
  });

  it("dry-run script lists ws-* dirs with size + last mtime and NEVER deletes", () => {
    const script = buildWorkspaceGcScript({
      olderThanDays: 30,
      apply: false,
      keep: ["ws-keep1", "ws-keep2"],
    });
    expect(script).toContain(`cd ${JANITOR_WORKSPACES_MOUNT}`);
    // only first-level ws-* dirs are in scope (never .trash, never lost+found)
    expect(script).toContain("for d in ws-*/");
    // keep-list containment match, space-delimited exact ids
    expect(script).toContain('KEEP=" ws-keep1 ws-keep2 "');
    // 30 days -> 43200 minutes recency probe
    expect(script).toContain("-mmin -43200");
    expect(script).toContain("du -sh");
    expect(script).toContain("stat -c %Y");
    expect(script).toContain('echo "CANDIDATE $d $SIZE $LAST"');
    expect(script).toContain('echo "GC_DONE"');
    // a dry-run must not contain ANY destructive or archive command
    expect(script).not.toContain("rm -rf");
    expect(script).not.toContain("tar ");
    expect(script).not.toContain(".trash");
  });

  it("apply script archives to on-volume .trash BEFORE rm, and only rm's when the tar is non-empty", () => {
    const script = buildWorkspaceGcScript({
      olderThanDays: 7,
      apply: true,
      keep: [],
    });
    expect(script).toContain("-mmin -10080");
    expect(script).toContain(`mkdir -p ${JANITOR_TRASH_DIR}`);
    expect(script).toContain(
      `TRASH="${JANITOR_TRASH_DIR}/$d.$EPOCH.tar.gz"`,
    );
    // archive-then-delete gate: rm -rf only inside the tar-success branch
    expect(script).toContain(
      'if tar -czf "$TRASH" "$d" && [ -s "$TRASH" ]; then',
    );
    const tarIdx = script.indexOf("tar -czf");
    const rmIdx = script.indexOf('rm -rf "$d"');
    expect(tarIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeGreaterThan(tarIdx);
    expect(script).toContain('echo "ARCHIVED $d $TRASH"');
    // tar failure path: remove the bad archive, keep the directory
    expect(script).toContain(
      'echo "FAILED $d archive-failed-directory-left-untouched"',
    );
  });

  it("rejects shell-unsafe keep ids and non-positive cutoffs", () => {
    expect(() =>
      buildWorkspaceGcScript({
        olderThanDays: 30,
        apply: false,
        keep: ['ws-a"; rm -rf /; "'],
      }),
    ).toThrow(/shell-unsafe/);
    expect(() =>
      buildWorkspaceGcScript({ olderThanDays: 0, apply: false, keep: [] }),
    ).toThrow(/olderThanDays/);
    expect(() =>
      buildWorkspaceGcScript({ olderThanDays: 1.5, apply: true, keep: [] }),
    ).toThrow(/olderThanDays/);
  });
});
