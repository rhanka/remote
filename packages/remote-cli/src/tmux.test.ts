import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process at the module boundary so NOTHING here ever talks to the
// user's real tmux server (or shells out at all).
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import {
  H2A_WINDOW_NAME,
  LOCAL_WRAPPER,
  buildCodexImagePasteBinding,
  buildSessionWindowArgs,
  buildTmuxGlobalOptions,
  fanoutLabels,
  getLocalSessionDisplayName,
  localRelaunchCommand,
  sessionAttachedCount,
  setLocalSessionDisplayName,
  startLocalSession,
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
    // the command line is passed VERBATIM as the final wrapper arg.
    expect(args[args.length - 1]).toBe(H2A_CMD);
  });

  it("exports the agent pane before eval when a wake target pane is provided", () => {
    const args = buildSessionWindowArgs(
      "remote-surch",
      H2A_WINDOW_NAME,
      "/home/u/src/surch",
      H2A_CMD,
      "%42",
    );
    expect(args[10]).toContain('export TMUX_PANE="$agent_pane"');
    expect(args[10]!.indexOf("export TMUX_PANE")).toBeLessThan(
      args[10]!.indexOf('eval "$cmd"'),
    );
    expect(args[args.length - 2]).toBe("%42");
    expect(args[args.length - 1]).toBe(H2A_CMD);
  });
});

describe("startLocalSession agent pane metadata", () => {
  it("stores the agent pane on the tmux session after creation", () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "-V") return { status: 0 };
      if (cmd === "tmux" && args[0] === "list-sessions")
        return { status: 1, stdout: "" };
      if (cmd === "tmux" && args[0] === "new-session") return { status: 0 };
      if (cmd === "tmux" && args[0] === "show-options")
        return { status: 1, stdout: "" };
      if (cmd === "tmux" && args[0] === "list-panes")
        return { status: 0, stdout: "codex\t%7\n" };
      return { status: 0, stdout: "" };
    });

    const result = startLocalSession(
      "codex",
      "codex",
      "/home/u/src/remote",
      [],
      "h2a-target",
    );

    expect(result).toEqual({ name: "remote-h2a-target", slug: "h2a-target" });
    expect(spawnSyncMock.mock.calls).toContainEqual([
      "tmux",
      ["set-option", "-t", "=remote-h2a-target", "@remote_agent_pane", "%7"],
      { stdio: "ignore" },
    ]);
    expect(spawnSyncMock.mock.calls).toContainEqual([
      "tmux",
      ["set-option", "-t", "=remote-h2a-target", "@remote_agent_host", "codex"],
      { stdio: "ignore" },
    ]);
    expect(spawnSyncMock.mock.calls).toContainEqual([
      "tmux",
      [
        "set-option",
        "-t",
        "=remote-h2a-target",
        "@remote_agent_cwd",
        "/home/u/src/remote",
      ],
      { stdio: "ignore" },
    ]);
  });
});

describe("startH2aWindow", () => {
  it("warns and returns false when the h2a binary is absent — and never touches tmux", () => {
    // `bash -lc "command -v -- h2a"` fails -> binary absent.
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    const err = fakeStderr();

    const ok = startH2aWindow(
      "remote-surch",
      "/home/u/src/surch",
      H2A_CMD,
      err,
    );

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
      if (cmd === "tmux" && args[0] === "show-options")
        return { status: 0, stdout: "%11\n" }; // stored agent pane
      return { status: 0 }; // new-window ok
    });
    const err = fakeStderr();

    const ok = startH2aWindow(
      "remote-surch",
      "/home/u/src/surch",
      H2A_CMD,
      err,
    );

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
        "%11",
      ),
    );
  });

  it('is idempotent but warns when an existing "h2a" window may have a stale wake target', () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "bash") return { status: 0 };
      if (cmd === "tmux" && args[0] === "list-windows")
        return { status: 0, stdout: "claude\nh2a\n" };
      return { status: 0 };
    });
    const err = fakeStderr();

    const ok = startH2aWindow(
      "remote-surch",
      "/home/u/src/surch",
      H2A_CMD,
      err,
    );

    expect(ok).toBe(true);
    expect(tmuxCalls("new-window")).toHaveLength(0);
    expect(err.text()).toContain("already exists");
    expect(err.text()).toContain("wake target may be stale");
  });

  it("warns (but does not throw) when tmux new-window fails", () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "bash") return { status: 0 };
      if (cmd === "tmux" && args[0] === "list-windows")
        return { status: 0, stdout: "claude\n" };
      if (cmd === "tmux" && args[0] === "show-options")
        return { status: 0, stdout: "%12\n" };
      return { status: 1 }; // new-window fails
    });
    const err = fakeStderr();

    const ok = startH2aWindow(
      "remote-surch",
      "/home/u/src/surch",
      H2A_CMD,
      err,
    );

    expect(ok).toBe(false);
    expect(err.text()).toContain("h2a window failed");
  });

  it("refuses to start --wake local-tmux when no agent pane can be resolved", () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "bash") return { status: 0 };
      if (cmd === "tmux" && args[0] === "list-windows")
        return { status: 0, stdout: "codex\n" };
      if (cmd === "tmux" && args[0] === "show-options")
        return { status: 1, stdout: "" };
      if (cmd === "tmux" && args[0] === "list-panes")
        return { status: 1, stdout: "" };
      return { status: 0 };
    });
    const err = fakeStderr();

    const ok = startH2aWindow(
      "remote-surch",
      "/home/u/src/surch",
      H2A_CMD,
      err,
    );

    expect(ok).toBe(false);
    expect(err.text()).toContain("agent pane could not be resolved");
    expect(tmuxCalls("new-window")).toHaveLength(0);
  });
});

describe("buildTmuxGlobalOptions (bug #1 — tab follows the agent's live title)", () => {
  const flat = (clip?: string) =>
    buildTmuxGlobalOptions(clip).map((c) => c.join(" "));

  it("turns set-titles ON so tmux forwards the agent's OSC title to the GNOME tab", () => {
    expect(flat()).toContain("set -g set-titles on");
  });

  it("points set-titles-string at pane_title with the window name as fallback", () => {
    const line = flat().find((l) => l.startsWith("set -g set-titles-string"));
    expect(line).toBeDefined();
    // pane_title (the agent's live title) is preferred; window_name is the fallback.
    expect(line).toContain("#{pane_title}");
    expect(line).toContain("#{window_name}");
    // precedence: pane_title BEFORE the fallback in the conditional.
    expect(line!.indexOf("#{pane_title}")).toBeLessThan(
      line!.lastIndexOf("#{window_name}"),
    );
  });

  it("allows the window name to follow the OSC title (allow-rename on) and NEVER touches automatic-rename", () => {
    const lines = flat();
    expect(lines).toContain("set -g allow-rename on");
    expect(lines.some((l) => l.includes("automatic-rename"))).toBe(false);
  });

  it("keeps the scroll/clipboard contract intact (no regression)", () => {
    const lines = flat("wl-copy");
    expect(lines).toContain("set -g mouse on");
    expect(lines).toContain("set -g set-clipboard on");
    expect(lines).toContain("set -g focus-events on");
    expect(lines).toContain("set -g copy-command wl-copy");
    expect(lines.some((l) => l.startsWith("bind -n WheelUpPane"))).toBe(true);
    expect(lines.some((l) => l.startsWith("bind -n WheelDownPane"))).toBe(true);
    expect(lines.some((l) => l.startsWith("bind -n PPage"))).toBe(true);
    expect(lines.some((l) => l.startsWith("bind -n C-v if-shell"))).toBe(true);
  });

  it("omits copy-command when no clipboard tool is detected", () => {
    expect(flat(undefined).some((l) => l.includes("copy-command"))).toBe(false);
  });
});

describe("buildCodexImagePasteBinding", () => {
  it("binds Ctrl+V to save Wayland clipboard images and paste the file path into Codex panes only", () => {
    const line = buildCodexImagePasteBinding().join(" ");
    expect(line).toContain("bind -n C-v");
    expect(line).toContain("wl-paste --list-types");
    expect(line).toContain("image/png");
    expect(line).toContain("image/jpeg");
    expect(line).toContain(".remote/images");
    expect(line).toContain("send-keys -l");
    expect(line).toContain("codex");
    expect(line).toContain("send-keys C-v");
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

describe("fanoutLabels", () => {
  it("returns just the base for count <= 1", () => {
    expect(fanoutLabels("sentropic", 1)).toEqual(["sentropic"]);
    expect(fanoutLabels("sentropic", 0)).toEqual(["sentropic"]);
  });
  it("suffixes #1…#N for a fan-out", () => {
    expect(fanoutLabels("sentropic", 3)).toEqual([
      "sentropic#1",
      "sentropic#2",
      "sentropic#3",
    ]);
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
    const r = runWrapper("remote run claude /x --name remote -r CONV", "echo", [
      "--resume",
      "CONV-abc",
    ]);
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

describe("sessionAttachedCount (the detached-only HARD guard source)", () => {
  beforeEach(() => spawnSyncMock.mockReset());

  it("returns 0 for a detached session", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "0\n" });
    expect(sessionAttachedCount("remote-a")).toBe(0);
    // It must query #{session_attached} with an EXACT (=) target.
    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[0]).toBe("tmux");
    expect(call[1]).toEqual([
      "display",
      "-p",
      "-t",
      "=remote-a",
      "#{session_attached}",
    ]);
  });

  it("returns the client count for an attached session", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "2\n" });
    expect(sessionAttachedCount("remote-a")).toBe(2);
  });

  it("returns undefined when the session/tmux is gone (conservative → treated as attached)", () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    expect(sessionAttachedCount("remote-gone")).toBeUndefined();
  });

  it("returns undefined on non-numeric output", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "??\n" });
    expect(sessionAttachedCount("remote-a")).toBeUndefined();
  });
});

describe("setLocalSessionDisplayName / getLocalSessionDisplayName (R1 — allow-rename coexistence)", () => {
  beforeEach(() => spawnSyncMock.mockReset());

  it("stores display name via set-option @display_name WITHOUT calling rename-window", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "" });

    const ok = setLocalSessionDisplayName("remote-surch", "My Project");

    expect(ok).toBe(true);
    // Must use set-option with the exact session target and @display_name key.
    expect(spawnSyncMock.mock.calls).toContainEqual([
      "tmux",
      ["set-option", "-t", "=remote-surch", "@display_name", "My Project"],
      { stdio: "ignore" },
    ]);
    // Must NEVER call rename-window (which would disable allow-rename per-window).
    const renameWindowCalls = spawnSyncMock.mock.calls.filter(
      (c) =>
        c[0] === "tmux" && Array.isArray(c[1]) && c[1][0] === "rename-window",
    );
    expect(renameWindowCalls).toHaveLength(0);
  });

  it("returns false when set-option fails (session gone)", () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    expect(setLocalSessionDisplayName("remote-gone", "name")).toBe(false);
  });

  it("reads back the stored display name via show-options -qv @display_name", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "My Project\n" });

    const v = getLocalSessionDisplayName("remote-surch");

    expect(v).toBe("My Project");
    expect(spawnSyncMock.mock.calls[0]).toEqual([
      "tmux",
      ["show-options", "-qv", "-t", "=remote-surch", "@display_name"],
      { encoding: "utf8" },
    ]);
  });

  it("returns undefined when no display name has been set (empty output)", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "\n" });
    expect(getLocalSessionDisplayName("remote-surch")).toBeUndefined();
  });

  it("returns undefined when show-options fails (session gone)", () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "" });
    expect(getLocalSessionDisplayName("remote-gone")).toBeUndefined();
  });

  it("accepts a session name that already has the = prefix (exactSessionTarget idempotent)", () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "" });
    setLocalSessionDisplayName("=remote-surch", "label");
    const call = spawnSyncMock.mock.calls[0]!;
    // exactSessionTarget must NOT double-prefix with ==
    // args: ["set-option", "-t", <target>, "@display_name", <value>]
    expect((call[1] as string[])[2]).toBe("=remote-surch");
  });
});
