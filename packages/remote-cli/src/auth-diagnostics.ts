import type { CliProfile } from "@sentropic/remote-protocol";

import {
  assertRequiredAuthBundle,
  collectProfileAuth,
  type AuthBundle,
  type CollectAuthOptions,
} from "./auth-bundle.js";
import {
  ensureProfileAuthFresh,
  type AuthRefreshResult,
  type RunCommand,
} from "./auth-refresh.js";

export type AuthDiagnosticsStatus =
  | AuthRefreshResult
  | { readonly checked: false; readonly reason: "skipped" };

export type AuthDiagnosticsResult = {
  readonly profile: CliProfile;
  readonly authStatus: AuthDiagnosticsStatus;
  readonly bundledFiles: ReadonlyArray<string>;
};

export type InspectProfileAuthOptions = CollectAuthOptions & {
  readonly authRefresh?: boolean;
  readonly runCommand?: RunCommand;
};

export async function inspectProfileAuth(
  profile: CliProfile,
  options: InspectProfileAuthOptions = {},
): Promise<AuthDiagnosticsResult> {
  const authStatus =
    options.authRefresh === false
      ? ({ checked: false, reason: "skipped" } as const)
      : await ensureProfileAuthFresh(profile, {
          ...(options.runCommand ? { runCommand: options.runCommand } : {}),
        });

  const collectOptions: CollectAuthOptions = {
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.readFileImpl !== undefined
      ? { readFileImpl: options.readFileImpl }
      : {}),
  };
  const bundle: AuthBundle = await collectProfileAuth(profile, collectOptions);
  assertRequiredAuthBundle(profile, bundle);

  return {
    profile,
    authStatus,
    bundledFiles: Object.keys(bundle),
  };
}
