// ---------------------------------------------------------------------------
// WP6 — REMOTE fan-out planner: N concurrent remote-session Pods, each on the
// ONE shared RWX File-Storage volume with its OWN workspace subPath. PURE (no
// spawn, no cluster call): turns a (base, count, max) request into N distinct
// session descriptors. The actual createWorkspace + createRemoteSession stay
// behind the existing seam in index.ts (`startRemoteFanout`).
//
// ARCHITECTURE (do NOT regress): there is exactly ONE shared RWX PVC per user;
// every workspace lives as a `<workspaceId>/` subPath of it (see k8s spec.ts
// `sharedWorkspacePvc` + `wsSubPath`). RWX mounts RW on MANY nodes at once
// (Scaleway File Storage), so N concurrent remote Pods is fine — no per-node
// CSI attach limit (same correction as the delegate remote path, design F3).
// We therefore NEVER create one PVC per session; each fan-out member just does
// its OWN `createWorkspace` call → the server assigns it a distinct workspaceId
// → a distinct subPath on the shared volume. The planner's job is to hand each
// member a deterministic, collision-free NAME (session displayName + workspace
// displayName) derived from base + index; distinct subPaths follow for free
// from the N distinct server-assigned workspaceIds.
// ---------------------------------------------------------------------------

/**
 * Default concurrency cap for the REMOTE fan-out, mirroring the delegate path's
 * shared-RWX cap (`DEFAULT_MAX_CONCURRENT = 16`): the volume is multi-node RW so
 * N concurrent creations are safe, but we still bound the burst so a single
 * `--count` cannot blow past the cluster's per-user session budget. Reversible:
 * raise via the command's own cap if SCW quota allows.
 */
export const DEFAULT_FANOUT_MAX = 16;

/**
 * One member of a remote fan-out. PURE data:
 *  - `index`     1-based position in the fleet (1..count).
 *  - `name`      the session displayName, `<base>-NN` (zero-padded), SAFE-NAME
 *                safe (letters/digits/`_`/`-`) so it is also a valid k8s object
 *                name component and path segment.
 *  - `workspaceName` the workspace displayName passed to `createWorkspace`; the
 *                server assigns the real workspaceId (→ the subPath on the shared
 *                RWX PVC). Distinct per member so the fleet never shares a tree.
 *  - `subPath`   the INTENDED, deterministic subPath label for this member
 *                (== `name`). The server's assigned workspaceId is the EFFECTIVE
 *                subPath; this field documents the plan and proves collision-free
 *                derivation in tests. Each member gets its OWN subPath because
 *                each does its OWN createWorkspace — never a shared tree.
 */
export interface RemoteFanoutMember {
  readonly index: number;
  readonly name: string;
  readonly workspaceName: string;
  readonly subPath: string;
}

export interface PlanRemoteFanoutInput {
  /** Base label for the fleet (e.g. the cwd basename or an explicit --name). */
  readonly base: string;
  /** How many concurrent remote sessions to fan out (>= 1). */
  readonly count: number;
  /** Upper bound; rejects count>max. Defaults to DEFAULT_FANOUT_MAX. */
  readonly max?: number;
}

/** Job id / k8s name / subPath segment: keep it tame (same rule as delegate). */
const SAFE_BASE = /^[A-Za-z0-9_-]+$/;

/**
 * Zero-pad the 1-based index to a stable width so member names sort lexically
 * (`-01`..`-16`) and never collide by prefix. Width tracks the count so a fleet
 * of 9 uses `-1..-9` and a fleet of 12 uses `-01..-12`.
 */
function pad(index: number, count: number): string {
  const width = String(count).length;
  return String(index).padStart(width, "0");
}

/**
 * Plan a REMOTE fan-out: derive N distinct, collision-free session descriptors
 * from a base + index, bounded by max. PURE — no spawning, no cluster call.
 *
 * Naming scheme (reversible default, DOCUMENTED): `<base>-NN`, zero-padded to the
 * count's width. SAFE-NAME safe so each name is a valid session displayName AND a
 * valid workspace displayName AND a valid path/k8s-name segment. `count === 1`
 * yields a single member named exactly `<base>` (no suffix) — a 1:1 passthrough
 * to the existing single-session path.
 *
 * Rejects (throws) on:
 *  - non-integer / count < 1
 *  - count > max (the cap; default DEFAULT_FANOUT_MAX)
 *  - a base that is not SAFE-NAME safe (would yield an invalid subPath/k8s name)
 */
export function planRemoteFanout(
  input: PlanRemoteFanoutInput,
): RemoteFanoutMember[] {
  const { base, count } = input;
  const max = input.max ?? DEFAULT_FANOUT_MAX;
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`fan-out max must be a whole number >= 1 (got ${max})`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--count must be a whole number >= 1 (got ${count})`);
  }
  if (count > max) {
    throw new Error(
      `--count ${count} exceeds the fan-out cap of ${max} (raise the cap only if your SCW session quota allows it)`,
    );
  }
  if (!SAFE_BASE.test(base)) {
    throw new Error(
      `fan-out base "${base}" is not name-safe (allowed: letters, digits, "_", "-"); pass --name with a tame label`,
    );
  }
  // count === 1: 1:1 passthrough — the single member keeps the bare base, so the
  // existing single-session naming is byte-for-byte unchanged.
  if (count === 1) {
    return [{ index: 1, name: base, workspaceName: base, subPath: base }];
  }
  const members = Array.from({ length: count }, (_v, i) => {
    const index = i + 1;
    const name = `${base}-${pad(index, count)}`;
    return { index, name, workspaceName: name, subPath: name };
  });
  // Defensive: prove (and guarantee for callers) collision-free subPaths.
  const subPaths = new Set(members.map((m) => m.subPath));
  if (subPaths.size !== members.length) {
    throw new Error("fan-out produced colliding subPaths (internal error)");
  }
  return members;
}

/**
 * Run `task` over `items` with at most `limit` in flight, preserving input order
 * in the returned settled results. Bounded concurrency for the fan-out CREATION
 * (each task is one createWorkspace + createRemoteSession): N pods on a multi-node
 * RWX volume are safe, but we still cap the burst so we never open N sockets to
 * the control-plane at once. NOT pure (runs the tasks) but cluster-agnostic — the
 * task is injected, so it is unit-testable without a live control-plane.
 */
export async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await task(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
