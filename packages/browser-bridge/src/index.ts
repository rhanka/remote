/**
 * @sentropic/remote-browser-bridge — headful browser-in-pod (noVNC) for 2FA.
 *
 * WP7: a headful Chromium runs INSIDE the session Pod (Xvfb + Chromium + x11vnc
 * + websockify + noVNC), viewable/controllable by the user through noVNC in
 * their own browser, reached over the existing `remote forward` transport, so
 * they can complete a 2FA/login challenge on an authenticated site.
 *
 * This package is the pure-ish lifecycle/contract layer; the actual X/Chromium
 * processes sit behind the injectable BrowserSpawner seam.
 */

export const packageName = "@sentropic/remote-browser-bridge";

export {
  HeadfulBrowserBridge,
  type BridgeDeps,
  type BrowserHandle,
  type BrowserSpawnConfig,
  type BrowserSpawner,
  type BrowserStatus,
  type StartBrowserRequest,
  type StartBrowserResult,
} from "./bridge.js";

export {
  canTransition,
  isLive,
  isTerminal,
  nextBrowserState,
  type BrowserSessionEvent,
  type BrowserSessionState,
} from "./lifecycle.js";

export {
  evaluateExposure,
  type ExposureDecision,
  type ExposureRequest,
  type ExposureRequester,
} from "./policy.js";

export {
  buildForwardCommand,
  buildNoVncUrl,
  DEFAULT_DISPLAY,
  DEFAULT_GEOMETRY,
  NOVNC_POD_PORT,
  type NoVncUrlOptions,
} from "./forward-url.js";

export {
  defaultRandomBytes,
  mintNoVncToken,
  toHex,
  type RandomBytes,
} from "./token.js";

export {
  buildBrowserStarted,
  buildTwoFactorRequest,
  buildUatRouteCreated,
  buildUatRouteExpired,
  buildUserTakeoverChanged,
  coerceTwoFactorMethod,
  parseUserTakeoverRequest,
} from "./protocol.js";

export {
  ChildProcessBrowserSpawner,
  DEFAULT_ENTRYPOINT,
  type ChildProcessSpawnerOptions,
} from "./spawner.js";
