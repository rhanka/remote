/**
 * Forwardable-URL construction for the noVNC endpoint.
 *
 * The browser sidecar serves noVNC + websockify on a fixed Pod-local port
 * (NOVNC_POD_PORT). The user reaches it with:
 *
 *   remote forward <sessionId> 6080 [localPort]
 *
 * which port-forwards the Pod port to http://localhost:<localPort>. The bridge
 * returns the EXACT URL the user opens, including the per-session token as a
 * query param and noVNC's own UI params (autoconnect, interactive vs view-only).
 * Pure string building so it is unit-tested without a cluster.
 */

/**
 * Pod-local port the browser sidecar listens on (websockify serving noVNC).
 * 6080 is the de-facto noVNC/websockify default. Fixed (not random) so the
 * `remote forward <id> 6080` command is memorable and matches the sidecar.
 */
export const NOVNC_POD_PORT = 6080;

/** Default X display geometry inside the Pod (Xvfb). 24-bit colour. */
export const DEFAULT_DISPLAY = ":99";
export const DEFAULT_GEOMETRY = "1280x800x24";

export type NoVncUrlOptions = {
  /** Local port the forward landed on (defaults to NOVNC_POD_PORT). */
  readonly localPort?: number;
  /** Per-session access token (required by policy for non-operator routes). */
  readonly token: string;
  /**
   * Interactive (the user can click/type — REQUIRED for completing 2FA) vs
   * view-only (read-only mirror). Defaults to interactive: WP7 is explicitly
   * about a human DRIVING the browser through a login/2FA challenge.
   */
  readonly interactive?: boolean;
  /** Auto-connect on load so the user lands straight on the desktop. */
  readonly autoconnect?: boolean;
  /** Host (defaults to localhost — port-forward binds 127.0.0.1). */
  readonly host?: string;
};

/**
 * Build the localhost noVNC URL the user opens after `remote forward`.
 *
 * noVNC's vnc.html honours query params: `path` (the websockify path, which we
 * carry the token on), `autoconnect`, `view_only`. The token is on the path so
 * websockify can authorize the upgrade before any VNC bytes flow.
 */
export function buildNoVncUrl(opts: NoVncUrlOptions): string {
  const host = opts.host ?? "localhost";
  const port = opts.localPort ?? NOVNC_POD_PORT;
  const interactive = opts.interactive ?? true;
  const autoconnect = opts.autoconnect ?? true;
  const params = new URLSearchParams();
  // websockify path carries the token; the server rejects a mismatch/absence.
  params.set("path", `websockify?token=${opts.token}`);
  if (autoconnect) params.set("autoconnect", "true");
  // noVNC reads view_only=true as a read-only mirror; for 2FA we must NOT set it.
  if (!interactive) params.set("view_only", "true");
  return `http://${host}:${port}/vnc.html?${params.toString()}`;
}

/**
 * The `remote forward` command the user runs to open the forward. Returned to
 * the user verbatim so they can copy-paste it. localPort omitted lets kubectl
 * pick (it defaults to the pod port when free).
 */
export function buildForwardCommand(
  sessionId: string,
  localPort?: number,
): string {
  const tail = localPort === undefined ? "" : ` ${localPort}`;
  return `remote forward ${sessionId} ${NOVNC_POD_PORT}${tail}`;
}
