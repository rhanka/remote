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
    }
  | {
      readonly name: string;
      readonly emptyDir: { readonly sizeLimit?: string };
    };

export type K8sPodAffinityTerm = {
  readonly labelSelector: {
    readonly matchLabels: Readonly<Record<string, string>>;
  };
  readonly topologyKey: string;
};

export type K8sContainer = {
  readonly name: string;
  readonly image: string;
  readonly imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  readonly command?: ReadonlyArray<string>;
  readonly env: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
  readonly envFrom?: ReadonlyArray<{
    readonly secretRef: { readonly name: string };
  }>;
  readonly volumeMounts: ReadonlyArray<K8sVolumeMount>;
  readonly resources?: {
    readonly requests?: ResourceQuantities;
    readonly limits?: ResourceQuantities;
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
        readonly requiredDuringSchedulingIgnoredDuringExecution?: ReadonlyArray<K8sPodAffinityTerm>;
        readonly preferredDuringSchedulingIgnoredDuringExecution?: ReadonlyArray<{
          readonly weight: number;
          readonly podAffinityTerm: K8sPodAffinityTerm;
        }>;
      };
      readonly nodeAffinity?: {
        readonly requiredDuringSchedulingIgnoredDuringExecution?: {
          readonly nodeSelectorTerms: ReadonlyArray<{
            readonly matchExpressions?: ReadonlyArray<{
              readonly key: string;
              readonly operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist' | 'Gt' | 'Lt';
              readonly values?: ReadonlyArray<string>;
            }>;
          }>;
        };
      };
    };
    readonly topologySpreadConstraints?: ReadonlyArray<{
      readonly maxSkew: number;
      readonly topologyKey: string;
      readonly whenUnsatisfiable: 'DoNotSchedule' | 'ScheduleAnyway';
      readonly labelSelector: {
        readonly matchLabels?: Readonly<Record<string, string>>;
        readonly matchExpressions?: ReadonlyArray<{
          readonly key: string;
          readonly operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist';
          readonly values?: ReadonlyArray<string>;
        }>;
      };
    }>;
    readonly containers: ReadonlyArray<K8sContainer>;
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
  /**
   * Image for the opt-in headful-browser SIDECAR (WP7 noVNC: Xvfb + Chromium +
   * x11vnc + websockify + noVNC). Only added to a Pod when a browser session is
   * requested (buildSessionPodSpec `browser: true`). Defaults to
   * BROWSER_SIDECAR_IMAGE. NOT baked into the session-agent image: the X stack
   * is heavy and unused by ~all sessions, so it lives in its own image and is
   * scheduled as an opt-in sidecar (separate lifecycle + resource budget). */
  readonly browserSidecarImage?: string;
  readonly controlPlaneEndpoint: string;
  readonly home: string;
  /**
   * When true, sets resource request == limit (Guaranteed QoS). The kubelet
   * only evicts Guaranteed pods when they exceed their own limits, never for
   * other pods' pressure. Use for long-running sessions where eviction cost is
   * high. Default false = low-request/high-limit (Burstable QoS, denser
   * packing).
   */
  readonly strictLimits?: boolean;
  /**
   * WP16 Slice 3 — LLM gateway URL (e.g. "https://llm.sent-tech.ca"). When
   * set, pods receive `ANTHROPIC_BASE_URL` pointing to the gateway so every
   * Anthropic API call routes through the pooled egress gateway instead of
   * going directly to api.anthropic.com. Unset = direct Anthropic access
   * (current default, backwards-compatible).
   */
  readonly llmGatewayUrl?: string;
  /** Bearer token issued by the LLM gateway for this session (gw-<hex>). When
   * set, injected as ANTHROPIC_API_KEY so Claude Code/Codex authenticate via
   * the gateway. Only meaningful when llmGatewayUrl is also set. */
  readonly llmGatewayToken?: string;
  /**
   * Names of k8s Secrets to inject into the session Pod as `envFrom` entries.
   * Every key in each Secret becomes an env var in the agent container — the
   * clean way to provide service creds (S3, external APIs) without baking them
   * into the image or passing them via task args. Secrets must exist in the
   * session's namespace before the Pod is created.
   */
  readonly extraEnvFromSecrets?: readonly string[];
};

// HOME-relative conversation/log dir each CLI writes, persisted on the PVC via a
// subPath mount (mirrors session-state's PROFILE_STATE_DIRS on the agent side).
const CONVERSATION_DIRS: Readonly<Record<string, string>> = {
  claude: ".claude/projects",
  "claude-code": ".claude/projects",
  codex: ".codex/sessions",
  agy: ".gemini/antigravity-cli/conversations",
  antigravity: ".gemini/antigravity-cli/conversations",
  gemini: ".gemini/gemini-cli/conversations",
};

const PVC_VOLUME = "workspace";
const AUTH_VOLUME = "auth";
const SCRATCH_VOLUME = "scratch";
const POD_CONTAINER = "session-agent";
const AUTH_STAGING_DIR = "/run/auth-bundle";

// --- session-agent resources (anti-eviction) --------------------------------
// A session-agent with NO memory request lands in BestEffort QoS and is the
// FIRST pod the kubelet evicts under node memory pressure (this already
// OOM-evicted live sessions, exit 137 reason=Evicted). Giving it a memory
// REQUEST promotes the pod to Burstable QoS, so it is protected up to that
// request before the kubelet reclaims it. The limit caps a runaway claude/codex
// (they can spike). All four are env-overridable (read at module load, same
// `process.env.X ?? default` shape the rest of the repo uses) so node sizing can
// be tuned without a rebuild; SESSION_AGENT_CPU_LIMIT is optional (unset = no
// cpu limit, so a busy session can burst above its request). Mirrors the
// browser sidecar's inline requests/limits block.
//
// Intent (product owner): keep the RESERVATION (request) small so many sessions
// pack onto one node (no node multiplication), but the CEILING (limit) generous
// so claude/codex can use 2–6Gi without OOMKilling (exit 137 was a too-low
// limit, NOT a too-low request). Hence a LOW request + HIGH limit (decoupled).
/** Memory REQUEST — kept LOW (dense packing, ≤512Mi); just enough to leave BestEffort. */
export const SESSION_AGENT_MEM_REQUEST =
  process.env.SESSION_AGENT_MEM_REQUEST ?? "256Mi";
/** Memory LIMIT — generous ceiling so a session can burst (no OOMKill). */
export const SESSION_AGENT_MEM_LIMIT =
  process.env.SESSION_AGENT_MEM_LIMIT ?? "4Gi";
/** CPU REQUEST — small scheduling floor (compressible; not an eviction factor). */
export const SESSION_AGENT_CPU_REQUEST =
  process.env.SESSION_AGENT_CPU_REQUEST ?? "100m";
/** Optional CPU LIMIT. Unset = no cpu cap (let a busy session burst). */
export const SESSION_AGENT_CPU_LIMIT = process.env.SESSION_AGENT_CPU_LIMIT;

// ephemeral-storage (node LOCAL disk) — same low-request/high-limit shape as
// memory, but the failure it guards is DiskPressure, not OOM. A pod with NO
// ephemeral-storage REQUEST lets the scheduler overcommit the node's local
// disk (the container image is never counted in the request — only the
// writable layer + emptyDir + logs are), so the single RWX node hit
// DiskPressure=True and the kubelet cascade-EVICTED every session pod at once.
// A modest REQUEST makes the scheduler account for disk and stop packing past
// the node's allocatable ephemeral floor; the generous LIMIT caps any one
// session's writable layer/logs so a runaway is evicted ALONE instead of
// taking the node (and every neighbour) down. Env-overridable for node sizing.
/** ephemeral-storage REQUEST — modest scheduling floor (disk accounting, dense packing). */
export const SESSION_AGENT_EPHEMERAL_REQUEST =
  process.env.SESSION_AGENT_EPHEMERAL_REQUEST ?? "1Gi";
/** ephemeral-storage LIMIT — generous per-pod cap; an over-runner is evicted alone. */
export const SESSION_AGENT_EPHEMERAL_LIMIT =
  process.env.SESSION_AGENT_EPHEMERAL_LIMIT ?? "8Gi";

/** Mount path of the per-pod scratch `emptyDir` (bounded, node-local) where the
 * session's caches/tmp live ($TMPDIR/XDG_CACHE_HOME/npm/cargo/pip) — OFF the
 * shared RWX (which is reserved for /workspace + conv + worktrees). */
export const SCRATCH_MOUNT = "/scratch";
/** sizeLimit of the scratch emptyDir: exceeding it evicts ONLY this pod, never a
 * node-wide cascade. Env-overridable. */
export const SESSION_SCRATCH_SIZE_LIMIT =
  process.env.SESSION_SCRATCH_SIZE_LIMIT ?? "6Gi";

/** Default janitor image: tiny, has sh/find/stat/du/tar — everything the GC
 * script needs. Pinned (never :latest). */
export const JANITOR_IMAGE = "busybox:1.37.0";
/** Where the janitor mounts the ROOT of the shared workspaces PVC. */
export const JANITOR_WORKSPACES_MOUNT = "/workspaces";
/** On-volume trash dir: GC'd workspaces are tar'd here BEFORE rm — recoverable. */
export const JANITOR_TRASH_DIR = ".trash";

// --- Headful-browser sidecar (WP7 noVNC, opt-in) ----------------------------
/** Sidecar container name. */
export const BROWSER_SIDECAR_CONTAINER = "browser-headful";
/** Default sidecar image (Xvfb + Chromium + x11vnc + websockify + noVNC). Pinned. */
export const BROWSER_SIDECAR_IMAGE =
  "ghcr.io/rhanka/sentropic-remote-browser:v0.5.16";
/**
 * Pod-local port the sidecar's websockify/noVNC listens on. `remote forward
 * <id> 6080` exposes it to the user. Fixed (matches the bridge NOVNC_POD_PORT
 * and the entrypoint). The sidecar shares the Pod network namespace, so the
 * session-agent can probe localhost:6080 and the forward reaches it directly. */
export const BROWSER_SIDECAR_PORT = 6080;
/** Sidecar entrypoint inside the browser image (brings the X stack up). */
export const BROWSER_SIDECAR_ENTRYPOINT = "/opt/browser/start-headful.sh";

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

/**
 * The opt-in headful-browser sidecar (WP7 noVNC). Brings up Xvfb + Chromium +
 * x11vnc + websockify + noVNC inside the SAME Pod (shared network namespace, so
 * it binds BROWSER_SIDECAR_PORT that `remote forward` reaches). Heavily
 * resource-capped: a desktop Chromium is costly, and this is only ever up while
 * a user is completing a login/2FA, so a 1 CPU / 1Gi limit keeps a runaway
 * browser from starving the agent. It mounts the workspace volume so downloads/
 * uploads land where the session sees them. Default geometry/display are
 * reversible; the websockify token is injected at RUNTIME by the bridge (env
 * NOVNC_TOKEN), never baked into the spec — so no secret ever lands in the
 * Pod manifest. */
export function buildBrowserSidecarContainer(
  descriptor: SessionDescriptor,
  options: SpecBuilderOptions = DEFAULT_BUILDER_OPTIONS,
  workspaceMounts: ReadonlyArray<K8sVolumeMount> = [],
): K8sContainer {
  return {
    name: BROWSER_SIDECAR_CONTAINER,
    image: options.browserSidecarImage ?? BROWSER_SIDECAR_IMAGE,
    imagePullPolicy: options.imagePullPolicy ?? "Always",
    command: [BROWSER_SIDECAR_ENTRYPOINT],
    env: [
      { name: "NOVNC_PORT", value: String(BROWSER_SIDECAR_PORT) },
      { name: "DISPLAY", value: ":99" },
      { name: "GEOMETRY", value: "1280x800x24" },
      // Opt-in marker the entrypoint checks; the per-session noVNC token is
      // injected at runtime by the bridge (NOVNC_TOKEN), NOT here.
      { name: "SESSION_ID", value: descriptor.id },
    ],
    // Share the workspace so files downloaded in the browser are visible to the
    // agent's CLI (and vice versa). Read-write — a login may download a creds
    // file the user then moves into place.
    volumeMounts: workspaceMounts,
    resources: {
      requests: { cpu: "250m", memory: "512Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    },
  };
}

export function buildSessionPodSpec(
  descriptor: SessionDescriptor,
  options: SpecBuilderOptions = DEFAULT_BUILDER_OPTIONS,
  authPaths: ReadonlyArray<string> = [],
  workspaceSync = false,
  workspaceExport = false,
  sessionToken?: string,
  /** Opt-in: add the headful-browser sidecar (WP7 noVNC). Default false. */
  browser = false,
): K8sPodSpec {
  const names = resourceNames(descriptor);
  const limits = descriptor.resourceLimits;
  // Baseline anti-eviction floor: ALWAYS request memory (so the pod is
  // Burstable, never BestEffort) plus a cpu request, and cap memory. A
  // per-session descriptor limit, when present, OVERRIDES the matching baseline
  // (a "big-build" descriptor.resourceLimits still wins, both request+limit).
  const resourceRequests: ResourceQuantities = {
    cpu: SESSION_AGENT_CPU_REQUEST,
    memory: SESSION_AGENT_MEM_REQUEST,
    // Disk accounting floor (anti-DiskPressure cascade): see
    // SESSION_AGENT_EPHEMERAL_REQUEST. The descriptor's closed {cpu,memory}
    // limit shape carries no ephemeral field, so there is nothing to override.
    "ephemeral-storage": SESSION_AGENT_EPHEMERAL_REQUEST,
  };
  const resourceLimits: ResourceQuantities = {
    ...(SESSION_AGENT_CPU_LIMIT ? { cpu: SESSION_AGENT_CPU_LIMIT } : {}),
    memory: SESSION_AGENT_MEM_LIMIT,
    // Per-pod disk ceiling: a session over this is evicted alone, not the node.
    "ephemeral-storage": SESSION_AGENT_EPHEMERAL_LIMIT,
  };
  if (limits?.cpu) {
    Object.assign(resourceLimits, { cpu: limits.cpu });
    Object.assign(resourceRequests, { cpu: limits.cpu });
  }
  if (limits?.memory) {
    Object.assign(resourceLimits, { memory: limits.memory });
    Object.assign(resourceRequests, { memory: limits.memory });
  }
  if (options.strictLimits) {
    // Guaranteed QoS: request == limit for all resources (kubelet never
    // evicts Guaranteed pods for resource pressure from other pods).
    Object.assign(resourceRequests, resourceLimits);
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
    // Bounded node-local scratch for caches/tmp (see the redirect env). Keeps
    // hot, regenerable IO off the shared RWX; sizeLimit evicts only this pod.
    { name: SCRATCH_VOLUME, mountPath: SCRATCH_MOUNT },
  ];
  const volumes: K8sVolume[] = [
    {
      name: PVC_VOLUME,
      persistentVolumeClaim: { claimName },
    },
    {
      name: SCRATCH_VOLUME,
      emptyDir: { sizeLimit: SESSION_SCRATCH_SIZE_LIMIT },
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
      // Spread session pods evenly across nodes (soft — ScheduleAnyway) while
      // the podAffinity above still prefers the CP node. Together: prefer CP
      // node, but spread evenly when multiple nodes exist.
      topologySpreadConstraints: [
        {
          maxSkew: 1,
          topologyKey: 'kubernetes.io/hostname',
          whenUnsatisfiable: 'ScheduleAnyway',
          labelSelector: {
            matchLabels: {
              'app.kubernetes.io/name': 'sentropic-remote',
              'app.kubernetes.io/component': 'session-agent',
            },
          },
        },
      ],
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
            // Redirect heavy/temp/cache writers OFF the node's shared ephemeral
            // overlay disk onto a BOUNDED per-pod `emptyDir` (SCRATCH_MOUNT,
            // sizeLimit SESSION_SCRATCH_SIZE_LIMIT). Caches (~/.cache, ~/.npm,
            // ~/.cargo, pip, $TMPDIR) are regenerable + IO-hot, so they belong on
            // FAST node-local disk — but bounded: if a pod exceeds its emptyDir
            // sizeLimit, the kubelet evicts ONLY that pod, never a node-wide
            // DiskPressure cascade (the v0.5.12 ephemeral request/limit also caps
            // it). They must NOT go on the shared RWX (network File Storage =
            // slow + a SPOF + git/npm-lock corruption risk) — that was the
            // v0.5.14 mistake, corrected here per the codex review. The RWX
            // (descriptor.workspacePath) is reserved for /workspace + the
            // conversation dir + worktrees (persistent assets, see below).
            { name: "TMPDIR", value: `${SCRATCH_MOUNT}/tmp` },
            { name: "XDG_CACHE_HOME", value: `${SCRATCH_MOUNT}/cache` },
            { name: "npm_config_cache", value: `${SCRATCH_MOUNT}/cache/npm` },
            { name: "CARGO_HOME", value: `${SCRATCH_MOUNT}/cargo` },
            { name: "PIP_CACHE_DIR", value: `${SCRATCH_MOUNT}/cache/pip` },
            // superpowers `using-git-worktrees` does NOT honor an env var for
            // the worktree base (it picks `.worktrees/<branch>` repo-relative,
            // else a legacy global `~/.config/superpowers/worktrees/<project>`),
            // so this var is advisory: the DURABLE guarantee is the startup
            // symlink in the session-agent that points the legacy global path
            // onto the RWX. We still publish the base so any future env-aware
            // tooling lands worktrees on the RWX too.
            {
              name: "SUPERPOWERS_WORKTREE_BASE",
              value: `${descriptor.workspacePath}/.worktrees`,
            },
            // UTF-8 locale so accented output (é, è, à…) renders instead of
            // ASCII fallback ("_"). C.UTF-8 is always present in glibc (no
            // locale-gen needed).
            { name: "LANG", value: "C.UTF-8" },
            { name: "LC_ALL", value: "C.UTF-8" },
            // WP16 Slice 2: route Anthropic API calls through the pooled LLM
            // gateway. Both vars are injected together: ANTHROPIC_BASE_URL
            // points to the gateway; ANTHROPIC_API_KEY is the per-session
            // opaque bearer (gw-<hex>). If the gateway was unreachable at
            // provision time (no token), neither var is set so the pod falls
            // back to direct Anthropic access via ~/.claude credentials.
            ...(options.llmGatewayUrl && options.llmGatewayToken
              ? [
                  {
                    name: "ANTHROPIC_BASE_URL",
                    value: options.llmGatewayUrl,
                  },
                  { name: "ANTHROPIC_API_KEY", value: options.llmGatewayToken },
                ]
              : []),
            // Run interactive CLIs inside a durable tmux session in the Pod
            // (detach-safe; enables `remote attach --exec`). The agent ignores
            // this for the one-shot `shell` profile.
            { name: "SESSION_TMUX", value: "1" },
            // Escape hatch: Claude Code refuses --dangerously-skip-permissions
            // when running as root unless IS_SANDBOX=1 is set. Session-agent
            // pods run as root inside an isolated k8s sandbox — this is the
            // correct signal (not a multi-user host).
            { name: "IS_SANDBOX", value: "1" },
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
          ...(options.extraEnvFromSecrets && options.extraEnvFromSecrets.length > 0
            ? {
                envFrom: options.extraEnvFromSecrets.map((name) => ({
                  secretRef: { name },
                })),
              }
            : {}),
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
        // WP7 noVNC: opt-in headful-browser sidecar. Off unless `browser` is
        // requested — the X/Chromium stack is heavy and ~no session needs it.
        // Shares the workspace volume (the first volumeMount) so downloads are
        // visible to the agent.
        ...(browser
          ? [
              buildBrowserSidecarContainer(descriptor, options, [
                volumeMounts[0]!,
              ]),
            ]
          : []),
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
