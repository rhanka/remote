/**
 * Per-session one-time token for the noVNC endpoint.
 *
 * The noVNC port is exposed to the user through `remote forward`
 * (kubectl port-forward) at http://localhost:<port>. port-forward binds to
 * 127.0.0.1 by default, but the forwarded URL is otherwise unauthenticated:
 * anything that can reach that local port could drive the headful browser
 * (which may be mid-2FA on an authenticated site). We therefore mint a
 * per-session random token and require it as a `?token=` query param on the
 * noVNC URL; websockify is configured to reject connections without it
 * (see the browser sidecar entrypoint). The token is NEVER logged — only its
 * presence/absence is ever surfaced.
 *
 * Pure + injectable: the randomness source is a parameter so tests are
 * deterministic and never touch the platform RNG.
 */

/** Source of cryptographically-strong random bytes (Node's webcrypto by default). */
export type RandomBytes = (length: number) => Uint8Array;

/** Default RNG: WebCrypto getRandomValues (available on Node 18+ globalThis). */
export const defaultRandomBytes: RandomBytes = (length) => {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
};

const HEX = "0123456789abcdef";

/** Lower-case hex string of `bytes` (2 hex chars/byte). */
export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    s += HEX[(b >> 4) & 0xf];
    s += HEX[b & 0xf];
  }
  return s;
}

/**
 * Mint a noVNC access token. 16 bytes = 128 bits of entropy, ample for a
 * short-lived, locally-forwarded endpoint. Returns lower-case hex.
 */
export function mintNoVncToken(rng: RandomBytes = defaultRandomBytes): string {
  return toHex(rng(16));
}
