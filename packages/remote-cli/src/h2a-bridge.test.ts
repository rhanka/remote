import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process at the module boundary so NOTHING here ever runs kubectl.
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

vi.mock("./config.js", () => ({
  getTunnel: () => ({
    namespace: "remote",
    service: "svc/remote-control-plane",
    localPort: 8080,
    remotePort: 8080,
  }),
}));

// REAL fs against a scratch dir (never the real ~/h2a-workspace).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const {
  bridgeSession,
  defaultPodInstance,
  instanceInboxDir,
  parsePodListing,
  planBridge,
} = await import("./h2a-bridge.js");

const SCRATCH = join(process.cwd(), ".test-scratch", "h2a-bridge");
const LOCAL_ROOT = join(SCRATCH, "h2a-root");

const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });

const SESSION = "abc123";
const PROFILE = "claude";
const POD_DIR = instanceInboxDir(defaultPodInstance(SESSION, PROFILE)); // claude__remote__abc123

type PodState = {
  /** "dir/file" entries of the Pod's inbox (with content for pulls). */
  files: Record<string, string>;
  /** instance ids in the Pod's registry/instances.jsonl */
  instances: string[];
  hasStore: boolean;
  /** pushes received: "dir/file" -> decoded content */
  pushed: Record<string, string>;
};

/** Dispatch kubectl exec scripts against an in-memory Pod h2a store. */
function mockPod(state: PodState): void {
  spawnSyncMock.mockImplementation(
    (_cmd: string, args: string[], spawnOpts?: { input?: string }) => {
      const sh = String(args[args.length - 1] ?? "");
      // scaffold probe
      if (sh.includes("h2a-store-created")) {
        if (state.hasStore) return ok("h2a-store-exists\n");
        state.hasStore = true;
        return ok("h2a-store-created\n");
      }
      // listing
      if (sh.includes("==INSTANCES==")) {
        return ok(
          [
            "==INSTANCES==",
            ...state.instances,
            "==FILES==",
            ...Object.keys(state.files),
            "",
          ].join("\n"),
        );
      }
      // pull: base64 < "$HOME/h2a-workspace/.h2a/inbox/<dir>/<file>"
      const pull = sh.match(
        /base64 < "\$HOME\/h2a-workspace\/\.h2a\/inbox\/([^"]+)"/,
      );
      if (pull) {
        const entry = pull[1]!;
        const content = state.files[entry];
        if (content === undefined)
          return { status: 1, stdout: "", stderr: "no such file" };
        return ok(Buffer.from(content, "utf8").toString("base64"));
      }
      // push: existence-guarded base64 -d
      if (sh.includes("base64 -d")) {
        const m = sh.match(/inbox\/([^"]+)"; f="\$d\/([^"]+)"/);
        const entry = `${m?.[1]}/${m?.[2]}`;
        if (state.files[entry] !== undefined) return ok("h2a-exists\n");
        const decoded = Buffer.from(
          String(spawnOpts?.input ?? ""),
          "base64",
        ).toString("utf8");
        state.files[entry] = decoded;
        state.pushed[entry] = decoded;
        return ok("h2a-written\n");
      }
      return ok("");
    },
  );
}

function execScripts(): string[] {
  return spawnSyncMock.mock.calls.map((c) =>
    String((c[1] as string[]).at(-1) ?? ""),
  );
}

function seedLocal(entries: Record<string, string>): void {
  for (const [entry, content] of Object.entries(entries)) {
    const path = join(LOCAL_ROOT, "inbox", entry);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
}

describe("instance naming", () => {
  it("defaultPodInstance maps the session profile to the registry tool", () => {
    expect(defaultPodInstance("s1", "claude")).toBe("claude:remote:s1");
    expect(defaultPodInstance("s1", "claude-code")).toBe("claude:remote:s1");
    expect(defaultPodInstance("s1", "codex")).toBe("codex:remote:s1");
    expect(defaultPodInstance("s1", "antigravity")).toBe("agy:remote:s1");
    expect(defaultPodInstance("s1", "gemini")).toBe("gemini:remote:s1");
    expect(defaultPodInstance("s1", "mistral")).toBe("mistral:remote:s1");
    expect(defaultPodInstance("s1")).toBe("claude:remote:s1");
  });

  it("instanceInboxDir encodes ':' as '__' (h2a on-disk convention)", () => {
    expect(instanceInboxDir("claude:track:abc")).toBe("claude__track__abc");
    expect(instanceInboxDir("mermaid-editor")).toBe("mermaid-editor");
  });
});

describe("parsePodListing", () => {
  it("splits the marker sections and ignores login-shell noise", () => {
    const out = [
      "motd noise",
      "==INSTANCES==",
      "claude:remote:abc123",
      "==FILES==",
      "claude__track__x/env__1.json",
      "",
    ].join("\n");
    expect(parsePodListing(out)).toEqual({
      instances: ["claude:remote:abc123"],
      files: ["claude__track__x/env__1.json"],
    });
  });

  it("handles an empty store (no sections content)", () => {
    expect(parsePodListing("==INSTANCES==\n==FILES==\n")).toEqual({
      instances: [],
      files: [],
    });
  });
});

describe("planBridge (pure sync semantics)", () => {
  const podDirs = new Set([POD_DIR]);

  it("pulls NEW pod-emitted envelopes, skips ones already local", () => {
    const plan = planBridge({
      podFiles: [
        "claude__track__t1/env__new.json",
        "claude__track__t1/env__old.json",
      ],
      localFiles: ["claude__track__t1/env__old.json"],
      podInstanceDirs: podDirs,
    });
    expect(plan.pull).toEqual([
      { dir: "claude__track__t1", file: "env__new.json" },
    ]);
    expect(plan.skipped).toBe(1);
    expect(plan.push).toEqual([]);
  });

  it("never pulls from the Pod's OWN inbox (inbound, not outbound)", () => {
    const plan = planBridge({
      podFiles: [`${POD_DIR}/env__inbound.json`],
      localFiles: [],
      podInstanceDirs: podDirs,
    });
    expect(plan.pull).toEqual([]);
    expect(plan.push).toEqual([]);
    expect(plan.skipped).toBe(0);
  });

  it("pushes local envelopes addressed to the Pod, skips ones the Pod has", () => {
    const plan = planBridge({
      podFiles: [`${POD_DIR}/env__seen.json`],
      localFiles: [
        `${POD_DIR}/env__seen.json`,
        `${POD_DIR}/env__hello.json`,
        "claude__elsewhere/env__other.json", // not addressed to the Pod
      ],
      podInstanceDirs: podDirs,
    });
    expect(plan.push).toEqual([{ dir: POD_DIR, file: "env__hello.json" }]);
    expect(plan.skipped).toBe(1);
    expect(plan.pull).toEqual([]);
  });

  it("has NO delete concept: a file present on one side only is copied or left, never removed", () => {
    const plan = planBridge({
      podFiles: ["a/env__only-pod.json"],
      localFiles: [`${POD_DIR}/env__only-local.json`],
      podInstanceDirs: podDirs,
    });
    // Everything in the plan is a copy; the shape itself has no removal field.
    expect(Object.keys(plan).sort()).toEqual([
      "ignored",
      "pull",
      "push",
      "skipped",
    ]);
    expect(plan.pull).toHaveLength(1);
    expect(plan.push).toHaveLength(1);
  });

  it("ignores unsafe/malformed entry names entirely", () => {
    const plan = planBridge({
      podFiles: [
        "../../etc/passwd",
        'evil"/x.json',
        "dir/$(boom).json",
        "dir/sub/nested.json",
        "dir/not-json.txt",
        "ok-dir/env__fine.json",
      ],
      localFiles: ["bad name/env__x.json"],
      podInstanceDirs: podDirs,
    });
    expect(plan.pull).toEqual([{ dir: "ok-dir", file: "env__fine.json" }]);
    expect(plan.push).toEqual([]);
    expect(plan.ignored).toBe(6);
  });
});

describe("bridgeSession (kubectl mocked, scratch local store)", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(LOCAL_ROOT, { recursive: true });
  });

  it("pulls new, pushes addressed, skips existing — and never deletes", async () => {
    const podState: PodState = {
      hasStore: true,
      instances: [`claude:remote:${SESSION}`],
      files: {
        // outbound from the Pod's agent: one new, one already local
        "codex__track__t9/env__new.json": '{"id":"env:1:new"}',
        "codex__track__t9/env__old.json": '{"id":"env:2:old"}',
        // the Pod's own inbox: must NOT be pulled back
        [`${POD_DIR}/env__seen.json`]: '{"id":"env:3:seen"}',
      },
      pushed: {},
    };
    mockPod(podState);
    seedLocal({
      "codex__track__t9/env__old.json": '{"id":"env:2:old"}',
      [`${POD_DIR}/env__hello.json`]: '{"id":"env:4:hello"}',
      [`${POD_DIR}/env__seen.json`]: '{"id":"env:3:seen"}',
    });

    const result = await bridgeSession(SESSION, {
      profile: PROFILE,
      localRoot: LOCAL_ROOT,
    });

    expect(result.pulled).toBe(1);
    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(2); // env__old (pull side) + env__seen (push side)
    expect(result.failed).toBe(0);
    expect(result.scaffolded).toBe(false);
    expect(result.podInstanceDirs).toContain(POD_DIR);

    // pulled envelope landed locally, decoded exactly once
    const pulledFile = join(
      LOCAL_ROOT,
      "inbox",
      "codex__track__t9",
      "env__new.json",
    );
    expect(readFileSync(pulledFile, "utf8")).toBe('{"id":"env:1:new"}');
    // pre-existing local file untouched
    expect(
      readFileSync(
        join(LOCAL_ROOT, "inbox", "codex__track__t9", "env__old.json"),
        "utf8",
      ),
    ).toBe('{"id":"env:2:old"}');

    // pushed envelope reached the Pod, encoded exactly ONCE on the wire
    expect(podState.pushed).toEqual({
      [`${POD_DIR}/env__hello.json`]: '{"id":"env:4:hello"}',
    });
    const pushCall = spawnSyncMock.mock.calls.find((c) =>
      String((c[1] as string[]).at(-1)).includes("base64 -d"),
    );
    const wire = String((pushCall?.[2] as { input?: string })?.input ?? "");
    expect(Buffer.from(wire, "base64").toString("utf8")).toBe(
      '{"id":"env:4:hello"}',
    );

    // NOTHING is ever deleted, on either side
    const scripts = execScripts().join("\n");
    expect(scripts).not.toMatch(/\brm\b|\bunlink\b|-delete/);
    expect(existsSync(pulledFile)).toBe(true);
    expect(podState.files["codex__track__t9/env__new.json"]).toBeDefined();
  });

  it("push respects a Pod-side file that appeared after the listing (skip, no overwrite)", async () => {
    const podState: PodState = {
      hasStore: true,
      instances: [],
      files: {},
      pushed: {},
    };
    mockPod(podState);
    seedLocal({ [`${POD_DIR}/env__race.json`]: '{"id":"env:5:race"}' });
    // simulate the race: the file lands in the Pod between listing and push
    const baseImpl = spawnSyncMock.getMockImplementation()!;
    spawnSyncMock.mockImplementation(
      (cmd: string, args: string[], o?: object) => {
        const sh = String(args[args.length - 1] ?? "");
        if (sh.includes("==INSTANCES==")) {
          const out = baseImpl(cmd, args, o) as { stdout: string };
          podState.files[`${POD_DIR}/env__race.json`] = '{"id":"pod-side"}';
          return out;
        }
        return baseImpl(cmd, args, o);
      },
    );

    const result = await bridgeSession(SESSION, {
      profile: PROFILE,
      localRoot: LOCAL_ROOT,
    });

    expect(result.pushed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(podState.files[`${POD_DIR}/env__race.json`]).toBe(
      '{"id":"pod-side"}',
    );
  });

  it("scaffolds a missing Pod store (inbox/ + README) and reports it", async () => {
    const podState: PodState = {
      hasStore: false,
      instances: [],
      files: {},
      pushed: {},
    };
    mockPod(podState);

    const result = await bridgeSession(SESSION, {
      profile: PROFILE,
      localRoot: LOCAL_ROOT,
    });

    expect(result.scaffolded).toBe(true);
    expect(result.pulled).toBe(0);
    expect(result.pushed).toBe(0);
    const scaffold = execScripts().find((s) =>
      s.includes("h2a-store-created"),
    )!;
    expect(scaffold).toContain(`mkdir -p "$root/inbox/${POD_DIR}"`);
    expect(scaffold).toContain("README.md");
    // the README documents the drop convention for binary-less Pod agents
    expect(scaffold).toContain("inbox/<instance-dir>/env__");
  });

  it("a per-file pull failure is counted and does not abort the pass", async () => {
    const podState: PodState = {
      hasStore: true,
      instances: [],
      files: {
        "peer__a/env__ok.json": '{"id":"env:6:ok"}',
        "peer__b/env__gone.json": '{"id":"env:7:gone"}',
      },
      pushed: {},
    };
    mockPod(podState);
    // make one pull blow up at transfer time (listed, but unreadable)
    podState.files["peer__b/env__gone.json"] = undefined as unknown as string;

    const stderr = { write: vi.fn((_chunk: string) => true) };
    const result = await bridgeSession(SESSION, {
      profile: PROFILE,
      localRoot: LOCAL_ROOT,
      stderr: stderr as unknown as NodeJS.WriteStream,
    });

    expect(result.failed).toBe(1);
    expect(result.pulled).toBe(1);
    expect(stderr.write).toHaveBeenCalled();
    // counters/ids only on stderr — never envelope content
    const logged = stderr.write.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).not.toContain("env:7:gone");
  });
});
