import type { CliProfile } from "@sentropic/remote-protocol";

export const MENU_PROFILES: ReadonlyArray<CliProfile> = [
  "claude",
  "codex",
  "agy",
  "gemini",
  "mistral",
  "opencode",
  "shell",
];

const MENU_ALIASES: Readonly<Record<string, CliProfile>> = {
  "claude-code": "claude",
  antigravity: "agy",
  "gemini-cli": "gemini",
  mistralcli: "mistral",
};

export function shouldShowProfileMenu(
  args: ReadonlyArray<string>,
  tty: boolean,
): boolean {
  return tty && args.length <= 2;
}

export function renderProfileMenu(cwd: string): string {
  const lines = [
    `[remote] ${cwd}`,
    "[remote] choose a CLI profile:",
    ...MENU_PROFILES.map((profile, i) => `  ${i + 1}. ${profile}`),
    "[remote] profile number/name: ",
  ];
  return lines.join("\n");
}

export function profileFromMenuInput(input: string): CliProfile | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= MENU_PROFILES.length) {
    return MENU_PROFILES[n - 1];
  }
  const profile = MENU_PROFILES.find((p) => p === value);
  if (profile) return profile;
  return MENU_ALIASES[value];
}

export function promptProfileMenu(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  cwd: string,
): Promise<CliProfile | undefined> {
  output.write(renderProfileMenu(cwd));
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      input.off("data", onData);
      resolve(profileFromMenuInput(String(chunk)));
    };
    input.on("data", onData);
    input.resume();
  });
}
