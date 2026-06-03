# Design — Workspace storage & `scale`-gated provisioning (boundary contract)

Date: 2026-06-02
Status: draft (proposal artifact — to be ratified via h2a by `sentropic`/scale + `poc-k8s`, gated on `rhanka` product greenlight)
Supersedes: the per-workspace-filesystem model currently in `packages/k8s-orchestrator` (dd01b3c) + the `SESSION_WORKSPACE_SIZE=100G` global default in `deploy/scw`.
Sibling: `2026-06-02-control-plane-persistence-design.md` (durability — already shipped v0.4.2).

## Problem

Two flaws in the current workspace storage model:

1. **One File Storage filesystem per workspace.** The k8s orchestrator dynamically
   provisions a dedicated RWX PVC per workspace. With `SESSION_WORKSPACE_SIZE=100G`
   that means **100 GB billed per workspace** — absurd for ~30 agents (~€240/mo)
   and conceptually wrong: RWX exists precisely to be **shared**.
2. **remote provisions storage directly in k8s.** The control-plane's
   `K8sSessionProvisioner` imperatively creates PVCs/Pods. This requires remote to
   hold provisioning privilege across tenant namespaces — a privilege-escalation
   surface — and there is **no authority validating** that a given tenant is
   entitled to a workspace, within quota, or that capacity exists.

The right model (owner intent): **RWX = one shared volume per tenant, workspaces
are sub-directories**; and **provisioning is a *request* validated and executed by a
sentropic authority — `scale` — not done unilaterally by remote.**

## Target architecture

### Storage: one RWX volume per tenant, `subPath` per workspace

- Per **tenant** (namespace `user-<sha8>`): **one** RWX File Storage volume
  (Scaleway `filestorage.csi.scaleway.com`, ~€0.0803/GB/mo, 25 GB min).
- Each **workspace** = a `subPath` (`<workspaceId>`) on that volume.
- Each **session Pod** mounts `pvcName` at the workspace path with
  `subPath: <workspaceId>` + a consistent `fsGroup`. Multi-agent-per-workspace =
  several Pods co-mounting the same `pvcName`+`subPath` in RWX (the case RWO
  cannot serve).
- Cost: **~€8/mo per tenant** (100 GB shared across all its workspaces/agents),
  growing with real data, not session count. RWO (`scw-bssd`, ~€0.09/GB/mo, no
  25 GB floor) remains available per-workspace for single-agent workspaces that
  want it — selected by policy at `scale`, not hardcoded.

This volume is the **same bytes** sentropic can serve (web file browser, multi-user
collaboration) and remote executes terminals/agents against → one source of truth,
paid once, mutualised sentropic↔remote.

### Control: `scale` = API + validating webhook + operator (CR is source of truth)

Three layers, each doing what the others cannot:

| Layer | Role | Why irreplaceable |
|---|---|---|
| **API** (sentropic) | synchronous front door; carries **identity** (AuthN/Z); translates an authenticated request into a declarative CR; serves non-k8s clients (web UI) | k8s has no notion of a *product* user; onboarding + UX need identity + a sync return |
| **Validating webhook** | admission guard: validates *every* write to a CR (entitlement, quota, schema) → accept/reject immediately | defence in depth — even a direct `kubectl apply` is validated. This is the literal "validated by sentropic" |
| **Operator** | reconciliation loop: CR → real resources (namespace, RWX volume, `subPath`, RBAC, **pool choice + autoscale**), writes `status` | level-triggered, self-healing, idempotent; an imperative API alone drifts and loses state on cluster restart |

The **Custom Resource is the convergence point** that both the API *and* remote
write; the webhook guards both paths. That is why we need *both* an API and an
operator — front door + control loop, not redundant.

### Object model (CRDs owned by `scale`)

- **`Tenant`** (cluster- or system-namespaced): one per product user. Reconciled →
  namespace `user-<sha8>` + `ResourceQuota`/`LimitRange` + scoped RBAC (an SA/role
  remote uses) + the per-tenant RWX volume + a bearer credential. `status: Ready`
  carries the namespace + storage handle.
- **`Workspace`** (in `user-<sha8>`): one per code workspace. Reconciled → ensures
  the tenant volume exists, the `subPath` is created, `fsGroup` set. `status` →
  `{ pvcName, subPath, fsGroup, phase }`. Carries an **`environment`** block (see
  below) describing how to make the workspace feel identical to the user's local
  machine.

### Environment parity — the workspace's "feel at home" config

A migration is only fluid if the remote session is **path-identical** to the
user's local machine. A resumed conversation has absolute paths baked in (cwd,
file refs, `~`); if the Pod mounts the project at `/workspace` and uses
`HOME=/root`, every such path breaks and the CLI flails. So the workspace carries
a durable `environment` block, set once at link/migrate time and honoured by
**every** consumer (the remote CLI today, **sentropic.sent-tech.ca** tomorrow):

```jsonc
workspace.environment: {
  path: "/home/<user>/src/<proj>",  // mount the project here in any consumer (= the local path)
  home: "/home/<user>",             // HOME to reproduce
  // couche 2 (deferred): env vars, git identity, dotfiles manifest
}
```

Consumers mount the PVC at `environment.path`, set `HOME=environment.home`, and
run the CLI with `cwd = path`. The CLI's project-dir encoding then matches on both
sides (no re-encoding), `cd`/file paths resolve, and `~` points home → the resumed
conversation is byte-for-byte coherent. This is the **portable environment
contract** remote and sentropic both honour, so a workspace feels the same whether
opened from the CLI, the web IDE, or a terminal on sentropic.

Status (shipped in remote, pre-`scale`): `workspacePath` + `home` are now
first-class on the session descriptor + create request (protocol), persisted on the
local `.remote/workspace.json` marker, and the orchestrator mounts at `workspacePath`
+ sets `HOME` per session. The migrate path also stages the live conversation under
`.remote/sessions/` so `--resume` carries it. Folding `environment` into the
`Workspace` CR is the scale-side ratification item.
- **`Session`** (optional, in `user-<sha8>`): could model a session declaratively
  later; for now the control-plane keeps creating session Pods imperatively against
  the `Workspace.status` mount coordinates (so this CRD is deferred — see phasing).
- **`Session`** (optional, in `user-<sha8>`): could model a session declaratively
  later; for now the control-plane keeps creating session Pods imperatively against
  the `Workspace.status` mount coordinates (so this CRD is deferred — see phasing).

### Lifecycle flows

**New tenant** (rare, privileged, identity-bearing → through the API):
```
admin/SSO → scale API: "create tenant T"
  → API validates plan/quota, mints user-<sha8> + bearer
  → creates Tenant CR
  → webhook admits (unique name, quota)
  → operator reconciles: namespace + ResourceQuota + scoped RBAC + per-tenant RWX volume
  → status: Ready (namespace + storage handle)
remote learns T via its bearer (sub → namespace), as today
```

**New workspace** (frequent, k8s-native → remote posts the CR with a narrowed SA):
```
remote → creates Workspace CR W in ns user-<sha8>   (RBAC: create Workspace in OWN ns only)
  → webhook validates (T ready, workspace quota, uniqueness)
  → operator reconciles: ensure tenant RWX PVC + subPath=W + fsGroup
  → status: { pvcName, subPath, fsGroup, Ready }
remote reads status → mounts pvcName@subPath=W in the session Pod
  → multi-agent = N Pods mount the same pvcName+subPath in RWX ✓
```
The API exposes the same workspace op for the web UI — by writing the **same CR**.
Two writers (remote SA + API), one source of truth (the CR), one guard (the webhook).

## The seam in remote (livrable maintenant, réversible)

`K8sSessionProvisioner` is already behind an interface — that is the swap point.

- **Phase 0 (today, shipped):** `K8sSessionProvisioner` provisions imperatively in
  the SA-scoped namespace. Mono-tenant POC. `scale` does not exist. Works.
- **Phase 1:** introduce a `WorkspaceStorageResolver(tenant, workspaceId) →
  { pvcName, subPath, fsGroup }`. Default in-remote impl = per-tenant shared RWX PVC
  + `subPath` (the storage model above), owned provisionally by remote. CRDs +
  operator + webhook land on the `scale` side.
- **Phase 2:** the resolver/provisioner becomes a `ScaleProvisioner` = "create the
  `Workspace` CR, await `status`". remote's RBAC is **narrowed** to "create
  `Workspace` in own ns" — a remote compromise can no longer provision arbitrary
  namespaces; it must pass `scale`'s admission. Net security gain.

Same discipline as the `SessionStore`→DB seam: remote stays shippable alone, `scale`
plugs in behind the interface with no rework.

## The four guardrails (must be acted in ratification)

1. **Isolation:** one RWX volume **per tenant**, never one global cross-tenant
   (else a user reads another's `subPath`s). `subPath` = intra-tenant isolation only.
2. **Concurrent writes:** sentropic (web editor) + a remote agent on the same dir =
   classic NFS race. Reuse the control-plane's existing **advisory locks** as the
   coordination point.
3. **uid/fsGroup:** session Pods and sentropic file ops must share a consistent
   `fsGroup`/supplemental group, or permissions break. Pinned in the contract.
4. **Lifecycle/backup:** if `scale` owns storage, **`scale` owns backup/retention/
   snapshots** — centralised, not remote's concern.

## Ratification (h2a)

This is a **boundary contract**; it is ratified, not decreed. Counterparties (from
the live h2a registry) and their halves:

- **`sentropic` (scale half):** CRD semantics, API+webhook+operator ownership, the
  RBAC grant to remote, autoscaling+pool policy, per-tenant volume + backup ownership.
- **`poc-k8s` (substrate half):** RWX StorageClass per tenant (filestorage CSI), node
  pools (DEV1-XL/POP2), namespace/quota/RBAC primitives, real CSI capabilities,
  `fsGroup` convention.

Order (mirrors EVO-11 / DEC-059, and is **separate from the paused
`neg:remote-nhi-bridge`**):
1. This spec = the offer artifact (commits nobody).
2. h2a review request (inbox event) → `sentropic` + `poc-k8s`, each on its half.
3. **`rhanka` product greenlight** (principal), as on EVO-11.
4. Open `neg:remote-scale-storage` (bilateral/trilateral, open/offer/sign) → paired
   PRs (remote resolver/RBAC narrowing; scale CRDs/operator/webhook; poc-k8s SC/pools).

## Out of scope (deferred)
- The `Session` CRD (control-plane keeps imperative Pod creation against
  `Workspace.status` for now).
- Cross-tenant sharing of a single workspace (explicitly disallowed by guardrail 1).
- The web-UI/file-browser side on sentropic (its concern; this only fixes the seam).
