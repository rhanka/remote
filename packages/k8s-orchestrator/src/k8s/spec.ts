import type { SessionDescriptor } from "@sentropic/remote-protocol";

export type ResourceQuantities = Readonly<Record<string, string>>;
export type K8sPvcAccessMode = "ReadWriteOnce" | "ReadWriteMany";

export type K8sVolumeMount = {
  readonly name: string;
  readonly mountPath: string;
  readonly subPath?: string;
  readonly readOnly?: boolean;
};

export type K8sVolume =
  | {
      readonly name: string;
      readonly persistentVolumeClaim: { readonly claimName: string };
    }
  | {
      readonly name: string;
      readonly secret: {
        readonly secretName: string;
        readonly defaultMode?: number;
      };
    };

export type K8sPodAffinityTerm = {
  readonly labelSelector: {
    readonly matchLabels: Readonly<Record<string, string>>;
  };
  readonly topologyKey: string;
};

export type K8sPodSpec = {
  readonly apiVersion: "v1";
  readonly kind: "Pod";
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly spec: {
    readonly restartPolicy: "Never";
    readonly nodeSelector?: Readonly<Record<string, string>>;
    readonly affinity?: {
      readonly podAffinity?: {
        readonly requiredDuringSchedulingIgnoredDuringExecution?: ReadonlyArray<K8sPodAffinityTerm>;
        readonly preferredDuringSchedulingIgnoredDuringExecution?: ReadonlyArray<{
          readonly weight: number;
          readonly podAffinityTerm: K8sPodAffinityTerm;
        }>;
      };
    };
    readonly containers: ReadonlyArray<{
      readonly name: string;
      readonly image: string;
      readonly imagePullPolicy: "Always" | "IfNotPresent" | "Never";
      readonly command?: ReadonlyArray<string>;
      readonly env: ReadonlyArray<{
        readonly name: string;
        readonly value: string;
      }>;
      readonly volumeMounts: ReadonlyArray<K8sVolumeMount>;
      readonly resources?: {
        readonly requests?: ResourceQuantities;
        readonly limits?: ResourceQuantities;
      };
    }>;
    readonly volumes: ReadonlyArray<K8sVolume>;
  };
};

export type K8sPvcSpec = {
  readonly apiVersion: "v1";
  readonly kind: "PersistentVolumeClaim";
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly spec: {
    readonly accessModes: ReadonlyArray<K8sPvcAccessMode>;
    readonly resources: { readonly requests: ResourceQuantities };
    readonly storageClassName?: string;
  };
};

export type K8sSecretSpec = {
  readonly apiVersion: "v1";
  readonly kind: "Secret";
  readonly type: "Opaque";
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly data: Readonly<Record<string, string>>;
};

export type SpecBuilderOptions = {
  readonly namespace: string;
  readonly image: string;
  readonly imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  readonly storageClassName?: string;
  readonly storageAccessMode?: K8sPvcAccessMode;
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly defaultWorkspaceSize: string;
  /**
   * Name of ONE shared RWX PVC holding ALL workspaces as subdirectories
   * (`<pvc>/<workspaceId>/`). When set, workspace-bound sessions mount this
   * claim with `subPath: <workspaceId>` instead of a per-workspace PVC — one
   * 100G File Storage volume per user instead of one per workspace (Scaleway
   * minimum is 100G/volume, and the filestorage CSI allows only ONE such
   * volume attachment per node, so per-workspace PVCs also pinned 1 session
   * per node).
   */
  readonly sharedWorkspacePvc?: string;
  /** Image for the ephemeral workspace-GC janitor pod (busybox-compatible
   * shell + find/stat/du/tar required). Defaults to JANITOR_IMAGE. */
  readonly janitorImage?: string;
  readonly controlPlaneEndpoint: string;
  readonly home: string;
};

// HOME-relative conversation/log dir each CLI writes, persisted on the PVC via a
// subPath mount (mirrors session-state's PROFILE_STATE_DIRS on the agent side).
const CONVERSATION_DIRS: Readonly<Record<string, string>> = {
  claude: ".claude/projects",
  "claude-code": ".claude/projects",
  codex: ".codex/sessions",
  agy: ".gemini/antigravity-cli/conversations",
  antigravity: ".gemini/antigravity-cli/conversations",
};

const PVC_VOLUME = "workspace";
const AUTH_VOLUME = "auth";
const POD_CONTAINER = "session-agent";
const AUTH_STAGING_DIR = "/run/auth-bundle";

/** Default janitor image: tiny, has sh/find/stat/du/tar — everything the GC
 * script needs. Pinned (never :latest). */
export const JANITOR_IMAGE = "busybox:1.37.0";
/** Where the janitor mounts the ROOT of the shared workspaces PVC. */
export const JANITOR_WORKSPACES_MOUNT = "/workspaces";
/** On-volume trash dir: GC'd workspaces are tar'd here BEFORE rm — recoverable. */
export const JANITOR_TRASH_DIR = ".trash";

export const DEFAULT_BUILDER_OPTIONS: SpecBuilderOptions = {
  namespace: "sentropic-remote",
  image: "ghcr.io/rhanka/sentropic-remote-session-agent:v0.4.2",
  storageAccessMode: "ReadWriteOnce",
  defaultWorkspaceSize: "1Gi",
  controlPlaneEndpoint: "http://sentropic-remote-control-plane:8080",
  home: "/root",
};

export function sessionLabels(
  descriptor: SessionDescriptor,
): Readonly<Record<string, string>> {
  return {
    "app.kubernetes.io/name": "sentropic-remote",
    "app.kubernetes.io/component": "session-agent",
    "app.kubernetes.io/managed-by": "control-plane",
    "sentropic.dev/session-id": descriptor.id,
    "sentropic.dev/profile": descriptor.profile,
    "sentropic.dev/target": descriptor.target,
  };
}

export function resourceNames(descriptor: SessionDescriptor): {
  readonly pod: string;
  readonly pvc: string;
  readonly authSecret: string;
} {
  return {
    pod: `session-${descriptor.id}`,
    pvc: `session-${descriptor.id}-workspace`,
    authSecret: `session-${descriptor.id}-auth`,
  };
}

export function workspacePvcName(workspaceId: string): string {
  return `workspace-${workspaceId}`;
}

export function buildWorkspacePvcSpec(
  workspaceId: string,
  options: SpecBuilderOptions = DEFAULT_BUILDER_OPTIONS,
): K8sPvcSpec {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: workspacePvcName(workspaceId),
      namespace: options.namespace,
      labels: {
        "app.kubernetes.io/name": "sentropic-remote",
        "app.kubernetes.io/component": "workspace",
        "app.kubernetes.io/managed-by": "control-plane",
        "sentropic.dev/workspace-id": workspaceId,
      },
    },
    spec: {
      accessModes: [options.storageAccessMode ?? "ReadWriteOnce"],
      resources: {
        requests: {
          storage: options.defaultWorkspaceSize,
        },
      },
      ...(options.storageClassName !== undefined
        ? { storageClassName: options.storageClassName }
        : {}),
    },
  };
}

/**
 * The ONE shared RWX PVC holding every workspace as a `<workspaceId>/` subdir
 * (see SpecBuilderOptions.sharedWorkspacePvc). Always RWX: many sessions across
 * many nodes mount it concurrently.
 */
export function buildSharedWorkspacePvcSpec(
  options: SpecBuilderOptions = DEFAULT_BUILDER_OPTIONS,
): K8sPvcSpec {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: options.sharedWorkspacePvc ?? "remote-workspaces",
      namespace: options.namespace,
      labels: {
        "app.kubernetes.io/name": "sentropic-remote",
        "app.kubernetes.io/component": "shared-workspaces",
        "app.kubernetes.io/managed-by": "control-plane",
      },
    },
    spec: {
      accessModes: ["ReadWriteMany"],
      resources: {
        requests: {
          storage: options.defaultWorkspaceSize,
        },
      },
      ...(options.storageClassName !== undefined
        ? { storageClassName: options.storageClassName }
        : {}),
    },
  };
}

export function buildSessionPvcSpec(
  descriptor: SessionDescriptor,
  options: SpecBuilderOptions = DEFAULT_BUILDER_OPTIONS,
): K8sPvcSpec {
  const names = resourceNames(descriptor);
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: names.pvc,
      namespace: options.namespace,
      labels: sessionLabels(descriptor),
    },
    spec: {
      accessModes: [options.storageAccessMode ?? "ReadWriteOnce"],
      resources: {
        requests: {
          storage: options.defaultWorkspaceSize,
        },
      },
      ...(options.storageClassName !== undefined
        ? { storageClassName: options.storageClassName }
        : {}),
    },
  };
}

export function credentialSecretKey(relativePath: string): string {
  return relativePath.replace(/^\.+/, "").replace(/\//g, "_");
}

export function buildSessionAuthSecret(
  descriptor: SessionDescriptor,
  credentials: Readonly<Record<string, string>>,
  options: SpecBuilderOptions = DEFAULT_BUILDER_OPTIONS,
): K8sSecretSpec {
  const names = resourceNames(descriptor);
  const data: Record<string, string> = {};
  for (const [relPath, value] of Object.entries(credentials)) {
    data[credentialSecretKey(relPath)] = value;
  }
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: names.authSecret,
      namespace: options.namespace,
      labels: sessionLabels(descriptor),
    },
    data,
  };
}

export function buildSessionPodSpec(
  descriptor: SessionDescriptor,
  options: SpecBuilderOptions = DEFAULT_BUILDER_OPTIONS,
  authPaths: ReadonlyArray<string> = [],
  workspaceSync = false,
  workspaceExport = false,
  sessionToken?: string,
): K8sPodSpec {
  const names = resourceNames(descriptor);
  const limits = descriptor.resourceLimits;
  const resourceLimits: ResourceQuantities = {};
  const resourceRequests: ResourceQuantities = {};
  if (limits?.cpu) {
    Object.assign(resourceLimits, { cpu: limits.cpu });
    Object.assign(resourceRequests, { cpu: limits.cpu });
  }
  if (limits?.memory) {
    Object.assign(resourceLimits, { memory: limits.memory });
    Object.assign(resourceRequests, { memory: limits.memory });
  }

  // Workspace volume: ONE shared RWX PVC with a per-workspace subPath when
  // configured; else the legacy per-workspace PVC; else the per-session PVC.
  const shared = Boolean(descriptor.workspaceId && options.sharedWorkspacePvc);
  const claimName = shared
    ? options.sharedWorkspacePvc!
    : descriptor.workspaceId
      ? workspacePvcName(descriptor.workspaceId)
      : names.pvc;
  const wsSubPath = shared ? `${descriptor.workspaceId}` : undefined;
  const volumeMounts: K8sVolumeMount[] = [
    {
      name: PVC_VOLUME,
      mountPath: descriptor.workspacePath,
      ...(wsSubPath ? { subPath: wsSubPath } : {}),
    },
  ];
  const volumes: K8sVolume[] = [
    {
      name: PVC_VOLUME,
      persistentVolumeClaim: { claimName },
    },
  ];

  // Persist the wrapped CLI's conversation log DURABLY by mounting it from the
  // (retained, RWX) workspace PVC via subPath — declarative, no runtime symlink
  // surgery. The migrate seeds the conversation at the matching PVC subPath, so
  // it surfaces here on resume and every in-session write lands on the volume
  // (survives pod restart/re-deport). Narrow on purpose: only the conversation
  // dir, never all of HOME (auth files stay Secret-sourced + ephemeral).
  const convRelDir = CONVERSATION_DIRS[descriptor.profile];
  if (convRelDir) {
    const sessionHome = descriptor.home ?? options.home;
    const convSubPath = `.remote/sessions/${descriptor.profile}/${convRelDir}`;
    volumeMounts.push({
      name: PVC_VOLUME,
      mountPath: `${sessionHome}/${convRelDir}`,
      // On the shared PVC the workspace lives under <workspaceId>/, so the
      // conversation dir does too.
      subPath: wsSubPath ? `${wsSubPath}/${convSubPath}` : convSubPath,
    });
  }

  if (authPaths.length > 0) {
    for (const relPath of authPaths) {
      volumeMounts.push({
        name: AUTH_VOLUME,
        mountPath: `${AUTH_STAGING_DIR}/${relPath}`,
        subPath: credentialSecretKey(relPath),
        readOnly: true,
      });
    }
    volumes.push({
      name: AUTH_VOLUME,
      secret: {
        secretName: names.authSecret,
        defaultMode: 0o400,
      },
    });
  }

  const startupArgs = (() => {
    const startup = descriptor.metadata?.startup;
    if (!startup || typeof startup !== "object") return [];
    const args = (startup as { args?: unknown }).args;
    if (!Array.isArray(args)) return [];
    return args.filter((value): value is string => typeof value === "string");
  })();

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: names.pod,
      namespace: options.namespace,
      labels: sessionLabels(descriptor),
    },
    spec: {
      restartPolicy: "Never",
      ...(options.nodeSelector && Object.keys(options.nodeSelector).length > 0
        ? { nodeSelector: options.nodeSelector }
        : {}),
      // Pack sessions into the INTERSTICE of the node that already runs the
      // control-plane (always present, on a shared-infra node), instead of
      // pinning a near-empty dedicated node. We target the control-plane
      // SPECIFICALLY (not any sentropic-remote pod): matching "any remote pod"
      // is satisfied on every node that holds a session too, so Scaleway's
      // spreading tiebreak (LeastAllocated) wins and the session lands on the
      // emptiest node anyway. Anchoring to the single control-plane node makes
      // the preference decisive. Soft: a session still schedules anywhere it
      // fits and only spills to a new node on real saturation.
      affinity: {
        podAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [
            {
              weight: 100,
              podAffinityTerm: {
                labelSelector: {
                  matchLabels: {
                    "app.kubernetes.io/name": "sentropic-remote",
                    "app.kubernetes.io/component": "control-plane",
                  },
                },
                topologyKey: "kubernetes.io/hostname",
              },
            },
          ],
        },
      },
      containers: [
        {
          name: POD_CONTAINER,
          image: options.image,
          imagePullPolicy: options.imagePullPolicy ?? "Always",
          env: [
            { name: "SESSION_ID", value: descriptor.id },
            { name: "SESSION_PROFILE", value: descriptor.profile },
            { name: "SESSION_TARGET", value: descriptor.target },
            {
              name: "CONTROL_PLANE_ENDPOINT",
              value: options.controlPlaneEndpoint,
            },
            { name: "WORKSPACE_PATH", value: descriptor.workspacePath },
            { name: "HOME", value: descriptor.home ?? options.home },
            // UTF-8 locale so accented output (é, è, à…) renders instead of
            // ASCII fallback ("_"). C.UTF-8 is always present in glibc (no
            // locale-gen needed).
            { name: "LANG", value: "C.UTF-8" },
            { name: "LC_ALL", value: "C.UTF-8" },
            // Run interactive CLIs inside a durable tmux session in the Pod
            // (detach-safe; enables `remote attach --exec`). The agent ignores
            // this for the one-shot `shell` profile.
            { name: "SESSION_TMUX", value: "1" },
            ...(descriptor.workspaceId
              ? [
                  {
                    name: "SESSION_WORKSPACE_ID",
                    value: descriptor.workspaceId,
                  },
                ]
              : []),
            ...(workspaceSync
              ? [{ name: "SESSION_WORKSPACE_SYNC", value: "1" }]
              : []),
            ...(workspaceExport
              ? [{ name: "SESSION_WORKSPACE_EXPORT", value: "1" }]
              : []),
            ...(sessionToken
              ? [{ name: "REMOTE_TOKEN", value: sessionToken }]
              : []),
            ...(authPaths.length > 0
              ? [
                  {
                    name: "SESSION_AUTH_STAGING_DIR",
                    value: AUTH_STAGING_DIR,
                  },
                  {
                    name: "SESSION_AUTH_BUNDLE_PATHS",
                    value: authPaths.join(":"),
                  },
                ]
              : []),
            ...(startupArgs.length > 0
              ? [
                  {
                    name: "SESSION_STARTUP_ARGS",
                    value: JSON.stringify(startupArgs),
                  },
                ]
              : []),
            // Announce parity: the agent re-announces these on every
            // (re)connect so a control-plane restarted from scratch rebuilds a
            // descriptor that keeps the custom name/labels/limits — without
            // them a post-restart `remote refresh` regenerated the Pod with
            // default resources.
            ...(descriptor.displayName
              ? [
                  {
                    name: "SESSION_DISPLAY_NAME",
                    value: descriptor.displayName,
                  },
                ]
              : []),
            ...(descriptor.labels && Object.keys(descriptor.labels).length > 0
              ? [
                  {
                    name: "SESSION_LABELS",
                    value: JSON.stringify(descriptor.labels),
                  },
                ]
              : []),
            ...(limits && Object.keys(limits).length > 0
              ? [
                  {
                    name: "SESSION_RESOURCE_LIMITS",
                    value: JSON.stringify(limits),
                  },
                ]
              : []),
          ],
          volumeMounts,
          ...(Object.keys(resourceLimits).length > 0 ||
          Object.keys(resourceRequests).length > 0
            ? {
                resources: {
                  ...(Object.keys(resourceRequests).length > 0
                    ? { requests: resourceRequests }
                    : {}),
                  ...(Object.keys(resourceLimits).length > 0
                    ? { limits: resourceLimits }
                    : {}),
                },
              }
            : {}),
        },
      ],
      volumes,
    },
  };
}

// ---------------------------------------------------------------------------
// Workspace GC janitor (shared RWX PVC mode only)
// ---------------------------------------------------------------------------
//
// Sessions only ever see their own `subPath: <workspaceId>` slice of the
// shared PVC, so enumerating/collecting stale workspace directories requires
// an ephemeral "janitor" pod that mounts the PVC at its ROOT (no subPath).
//
// DATA SAFETY (this volume holds claude/.jsonl conversations — a wild-delete
// incident already happened once):
//   1. Only first-level `ws-*` directories are ever considered. `.trash/`,
//      `lost+found` and anything else are structurally out of scope.
//   2. The keep-list (every workspace referenced by any known session + every
//      registered workspace) is re-checked INSIDE the janitor script, so even
//      an apply run launched from a stale dry-run skips newly-protected dirs.
//   3. Age is re-evaluated in the pod at apply time (find -mmin): a directory
//      touched between dry-run and apply is skipped (reported as RECENT).
//   4. apply NEVER deletes directly: `tar -czf .trash/<dir>.<epoch>.tar.gz`
//      on the SAME volume first, the `rm -rf` only runs if tar succeeded AND
//      the archive is non-empty; otherwise the dir is left untouched and a
//      FAILED line is reported.

export type WorkspaceGcJanitorOptions = {
  /** Janitor pod name (caller generates a unique one per run). */
  readonly name: string;
  /** Directories with NO entry modified in the last N days are candidates. */
  readonly olderThanDays: number;
  /** false = pure dry-run (list + du -sh); true = archive-to-trash then rm. */
  readonly apply: boolean;
  /** Workspace ids that must NEVER be collected (always skipped). */
  readonly keep: ReadonlyArray<string>;
  /**
   * Scheduling mode for the CSI constraint (filestorage.csi.scaleway.com
   * attaches at most ONE distinct File Storage volume per node, but any number
   * of pods on that node may mount the SAME volume):
   *
   * - true (sessions are running in this namespace): REQUIRED podAffinity to
   *   the session-agent pods (topologyKey kubernetes.io/hostname). Those nodes
   *   already mount THIS volume, so co-locating is the only placement that is
   *   guaranteed to succeed — any other node might already hold a different
   *   File Storage volume (another tenant's) and would refuse the mount.
   *
   * - false (no session running): required affinity would be unsatisfiable and
   *   the janitor would Pending forever, so we emit only a PREFERRED affinity
   *   (a no-op without sessions) and let the scheduler pick any node. Since no
   *   session of this tenant is running, this tenant's volume is attached
   *   nowhere; the pod lands on an arbitrary node and succeeds whenever that
   *   node has a free File Storage slot. If every node's slot is taken by
   *   other volumes the mount times out and gcWorkspaces fails CLEANLY (error,
   *   janitor deleted, no data touched).
   */
  readonly hasLiveSessions: boolean;
};

function janitorLabels(): Readonly<Record<string, string>> {
  return {
    "app.kubernetes.io/name": "sentropic-remote",
    "app.kubernetes.io/component": "workspace-janitor",
    "app.kubernetes.io/managed-by": "control-plane",
  };
}

/** Workspace ids are `ws-<base36>`; anything else cannot be safely embedded in
 * the janitor shell script, so reject it outright (defense in depth — these
 * values normally come from our own stores, never from raw user input). */
const SAFE_DIR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * POSIX/busybox sh script the janitor runs against the PVC root. Pure string
 * builder so tests can assert the exact dry-run vs apply behavior. Output
 * protocol (parsed from pod logs):
 *
 *   KEPT <dir>                      — in the keep-list, skipped
 *   RECENT <dir>                    — has activity newer than the cutoff, skipped
 *   CANDIDATE <dir> <sizeH> <epoch> — stale; would be (dry-run) / is about to
 *                                     be (apply) collected
 *   ARCHIVED <dir> <trashPath>      — apply only: tar'd to on-volume trash AND removed
 *   FAILED <dir> <reason>           — apply only: archive failed, dir LEFT UNTOUCHED
 *   GC_DONE                         — sentinel; without it the run is treated as failed
 */
export function buildWorkspaceGcScript(opts: {
  readonly olderThanDays: number;
  readonly apply: boolean;
  readonly keep: ReadonlyArray<string>;
}): string {
  if (!Number.isInteger(opts.olderThanDays) || opts.olderThanDays < 1) {
    throw new Error(
      `workspace GC: olderThanDays must be an integer >= 1 (got ${opts.olderThanDays})`,
    );
  }
  for (const id of opts.keep) {
    if (!SAFE_DIR_ID.test(id)) {
      throw new Error(
        `workspace GC: refusing shell-unsafe keep id ${JSON.stringify(id)}`,
      );
    }
  }
  const cutoffMinutes = opts.olderThanDays * 24 * 60;
  // Surrounding spaces make the `case " $d "` containment match exact ids.
  const keepList = ` ${opts.keep.join(" ")} `;
  const applyBlock = opts.apply
    ? `
    mkdir -p ${JANITOR_TRASH_DIR}
    TRASH="${JANITOR_TRASH_DIR}/$d.$EPOCH.tar.gz"
    if tar -czf "$TRASH" "$d" && [ -s "$TRASH" ]; then
      rm -rf "$d"
      echo "ARCHIVED $d $TRASH"
    else
      rm -f "$TRASH"
      echo "FAILED $d archive-failed-directory-left-untouched"
    fi`
    : "";
  return `set -eu
cd ${JANITOR_WORKSPACES_MOUNT}
KEEP="${keepList}"
EPOCH=$(date +%s)
for d in ws-*/; do
  [ -d "$d" ] || continue
  d="\${d%/}"
  case "$KEEP" in *" $d "*) echo "KEPT $d"; continue;; esac
  if [ -n "$(find "$d" -mmin -${cutoffMinutes} -print 2>/dev/null | head -n 1)" ]; then
    echo "RECENT $d"
    continue
  fi
  SIZE=$(du -sh "$d" 2>/dev/null | cut -f1)
  [ -n "$SIZE" ] || SIZE=?
  LAST=$(find "$d" -exec stat -c %Y {} \; 2>/dev/null | sort -n | tail -n 1)
  [ -n "$LAST" ] || LAST=0
  echo "CANDIDATE $d $SIZE $LAST"${applyBlock}
done
echo "GC_DONE"
`;
}

/**
 * Ephemeral janitor pod: mounts the shared workspaces PVC at its ROOT (no
 * subPath — this is the whole point: sessions can only see their own slice),
 * runs the GC script once and exits. Tiny requests; scheduling per
 * WorkspaceGcJanitorOptions.hasLiveSessions (see the CSI rationale there).
 */
export function buildWorkspaceGcJanitorPodSpec(
  gc: WorkspaceGcJanitorOptions,
  options: SpecBuilderOptions = DEFAULT_BUILDER_OPTIONS,
): K8sPodSpec {
  const claimName = options.sharedWorkspacePvc;
  if (!claimName) {
    throw new Error(
      "workspace GC requires sharedWorkspacePvc (per-workspace PVC mode has no shared volume to garbage-collect)",
    );
  }
  const sessionTerm: K8sPodAffinityTerm = {
    labelSelector: {
      matchLabels: {
        "app.kubernetes.io/name": "sentropic-remote",
        "app.kubernetes.io/component": "session-agent",
      },
    },
    topologyKey: "kubernetes.io/hostname",
  };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: gc.name,
      namespace: options.namespace,
      labels: janitorLabels(),
    },
    spec: {
      restartPolicy: "Never",
      affinity: {
        podAffinity: gc.hasLiveSessions
          ? { requiredDuringSchedulingIgnoredDuringExecution: [sessionTerm] }
          : {
              preferredDuringSchedulingIgnoredDuringExecution: [
                { weight: 100, podAffinityTerm: sessionTerm },
              ],
            },
      },
      containers: [
        {
          name: "janitor",
          image: options.janitorImage ?? JANITOR_IMAGE,
          imagePullPolicy: "IfNotPresent",
          command: [
            "sh",
            "-c",
            buildWorkspaceGcScript({
              olderThanDays: gc.olderThanDays,
              apply: gc.apply,
              keep: gc.keep,
            }),
          ],
          env: [],
          volumeMounts: [
            // ROOT mount — intentionally NO subPath, unlike session pods.
            { name: PVC_VOLUME, mountPath: JANITOR_WORKSPACES_MOUNT },
          ],
          resources: {
            requests: { cpu: "25m", memory: "32Mi" },
            limits: { cpu: "500m", memory: "256Mi" },
          },
        },
      ],
      volumes: [{ name: PVC_VOLUME, persistentVolumeClaim: { claimName } }],
    },
  };
}
