import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process at the module boundary so NOTHING here ever talks to the
// user's real tmux server (or shells out at all).
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import {
  H2A_WINDOW_NAME,
  LOCAL_WRAPPER,
  buildSessionWindowArgs,
  localRelaunchCommand,
  startH2aWindow,
} from "./tmux.js";

// child_process is mocked module-wide (above); the wrapper regression test needs
// the REAL spawnSync to actually run bash.
const { spawnSync: realSpawnSync } =
  await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );

const H2A_CMD = "h2a mcp-serve --auto-open --auto-upgrade --wake local-tmux";

beforeEach(() => {
  spawnSyncMock.mockReset();
});

/** Calls to `tmux <subcommand> …` recorded by the mock. */
function tmuxCalls(subcommand: string): unknown[][] {
  return spawnSyncMock.mock.calls.filter(
    (c) => c[0] === "tmux" && Array.isArray(c[1]) && c[1][0] === subcommand,
  );
}

function fakeStderr(): { write: (s: string) => boolean; text: () => string } {
  let buf = "";
  return {
    write: (s: string) => {
      buf += s;
      return true;
    },
    text: () => buf,
  };
}

describe("buildSessionWindowArgs (pure)", () => {
  it("builds a detached NAMED window running the command line under the drop-to-shell wrapper", () => {
    const args = buildSessionWindowArgs(
      "remote-surch",
      H2A_WINDOW_NAME,
      "/home/u/src/surch",
      H2A_CMD,
    );
    expect(args.slice(0, 8)).toEqual([
      "new-window",
      "-d",
      "-t",
      "remote-surch",
      "-n",
      "h2a",
      "-c",
      "/home/u/src/surch",
    ]);
    expect(args[8]).toBe("/bin/bash");
    expect(args[9]).toBe("-lc");
    // wrapper: runs the command line, then drops to a shell instead of dying
    expect(args[10]).toContain('eval "$cmd"');
    expect(args[10]).toContain("exec /bin/bash -l");
    // the command line is passed VERBATIM as $1 (quoting preserved by eval)
    expect(args[args.length - 1]).toBe(H2A_CMD);
  });
});

describe("startH2aWindow", () => {
  it("warns and returns false when the h2a binary is absent — and never touches tmux", () => {
    // `bash -lc "command -v -- h2a"` fails -> binary absent.
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    const err = fakeStderr();

    const ok = startH2aWindow("remote-surch", "/home/u/src/surch", H2A_CMD, err);

    expect(ok).toBe(false);
    expect(err.text()).toContain("[remote]");
    expect(err.text()).toContain("h2a");
    expect(err.text()).toContain("not found");
    // only the command -v probe ran; no tmux call at all
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("bash");
    expect(tmuxCalls("new-window")).toHaveLength(0);
  });

  it("adds the named window when the binary exists and it is not there yet", () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "bash") return { status: 0 }; // command -v ok
      if (cmd === "tmux" && args[0] === "list-windows")
        return { status: 0, stdout: "claude\n" }; // no h2a window yet
      return { status: 0 }; // new-window ok
    });
    const err = fakeStderr();

    const ok = startH2aWindow("remote-surch", "/home/u/src/surch", H2A_CMD, err);

    expect(ok).toBe(true);
    expect(err.text()).toBe("");
    const calls = tmuxCalls("new-window");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual(
      buildSessionWindowArgs(
        "remote-surch",
        H2A_WINDOW_NAME,
        "/home/u/src/surch",
        H2A_CMD,
      ),
    );
  });

  it("is idempotent: an existing \"h2a\" window is reused, no new-window", () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "bash") return { status: 0 };
      if (cmd === "tmux" && args[0] === "list-windows")
        return { status: 0, stdout: "claude\nh2a\n" };
      return { status: 0 };
    });

    const ok = startH2aWindow(
      "remote-surch",
      "/home/u/src/surch",
      H2A_CMD,
      fakeStderr(),
    );

    expect(ok).toBe(true);
    expect(tmuxCalls("new-window")).toHaveLength(0);
  });

  it("warns (but does not throw) when tmux new-window fails", () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "bash") return { status: 0 };
      if (cmd === "tmux" && args[0] === "list-windows")
        return { status: 0, stdout: "claude\n" };
      return { status: 1 }; // new-window fails
    });
    const err = fakeStderr();

    const ok = startH2aWindow("remote-surch", "/home/u/src/surch", H2A_CMD, err);

    expect(ok).toBe(false);
    expect(err.text()).toContain("h2a window failed");
  });
});

describe("localRelaunchCommand", () => {
  it("includes profile, cwd and --name", () => {
    expect(localRelaunchCommand("claude", "/home/u/src/surch", "surch")).toBe(
      "remote run claude /home/u/src/surch --name surch",
    );
  });

  it("surfaces the conversation id as -r (claude resume argv)", () => {
    expect(
      localRelaunchCommand("claude", "/home/u/src/surch", "surch", [
        "--resume",
        "conv-123",
      ]),
    ).toBe("remote run claude /home/u/src/surch --name surch -r conv-123");
  });

  it("surfaces the conversation id as -r (codex resume subcommand argv)", () => {
    expect(
      localRelaunchCommand("codex", "/home/u/src/x", "x", ["resume", "abc"]),
    ).toBe("remote run codex /home/u/src/x --name x -r abc");
  });

  it("omits -r when there is no resume arg, and --name when unlabelled", () => {
    expect(localRelaunchCommand("codex", "/home/u/src/x", undefined)).toBe(
      "remote run codex /home/u/src/x",
    );
  });
});

describe("LOCAL_WRAPPER (real bash) — regression: cli runs with its args", () => {
  // Invoked as `bash -lc WRAPPER <relaunch> <cli> <args…>`: bash puts the FIRST
  // positional in $0, so the wrapper must read relaunch=$0, cli=$1, shift once.
  // Reading $1/$2 (the original bug) ran the FIRST CLI ARG as a command —
  // `--resume: command not found (127)` — dropping every relaunched session to
  // a shell. stdin is closed so the trailing `exec bash -l` exits at once.
  function runWrapper(relaunch: string, cli: string, args: string[]) {
    return realSpawnSync(
      "bash",
      ["-lc", LOCAL_WRAPPER, relaunch, cli, ...args],
      { encoding: "utf8", input: "" },
    );
  }

  it("runs `echo --resume CONV` (the resume shape that broke) with both args", () => {
    const r = runWrapper(
      "remote run claude /x --name remote -r CONV",
      "echo",
      ["--resume", "CONV-abc"],
    );
    expect(r.stdout).toContain("--resume CONV-abc"); // echo got BOTH args
    expect(r.stdout).toContain("echo exited (code 0)");
    expect(r.stdout).toContain(
      "relaunch: remote run claude /x --name remote -r CONV",
    );
    expect(r.stdout).not.toContain("command not found");
  });

  it("runs a no-arg CLI cleanly", () => {
    const r = runWrapper("remote run codex /x", "true", []);
    expect(r.stdout).toContain("true exited (code 0)");
    expect(r.stdout).not.toContain("command not found");
  });
});
