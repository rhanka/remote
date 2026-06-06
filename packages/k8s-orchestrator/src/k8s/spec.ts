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
        readonly preferredDuringSchedulingIgnoredDuringExecution: ReadonlyArray<{
          readonly weight: number;
          readonly podAffinityTerm: {
            readonly labelSelector: {
              readonly matchLabels: Readonly<Record<string, string>>;
            };
            readonly topologyKey: string;
          };
        }>;
      };
    };
    readonly containers: ReadonlyArray<{
      readonly name: string;
      readonly image: string;
      readonly imagePullPolicy: "Always" | "IfNotPresent" | "Never";
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

  const claimName = descriptor.workspaceId
    ? workspacePvcName(descriptor.workspaceId)
    : names.pvc;
  const volumeMounts: K8sVolumeMount[] = [
    { name: PVC_VOLUME, mountPath: descriptor.workspacePath },
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
    volumeMounts.push({
      name: PVC_VOLUME,
      mountPath: `${sessionHome}/${convRelDir}`,
      subPath: `.remote/sessions/${descriptor.profile}/${convRelDir}`,
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
      // Pack sessions into the INTERSTICES of nodes that already run remote
      // workloads (the control-plane is always present), instead of pinning a
      // near-empty dedicated node. Soft preference: a session still schedules
      // anywhere it fits, but prefers a node already hosting a sentropic-remote
      // pod — so remote adds ~0 dedicated nodes and only spills to a new node on
      // real saturation, never hypothetical.
      affinity: {
        podAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [
            {
              weight: 100,
              podAffinityTerm: {
                labelSelector: {
                  matchLabels: { "app.kubernetes.io/name": "sentropic-remote" },
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
