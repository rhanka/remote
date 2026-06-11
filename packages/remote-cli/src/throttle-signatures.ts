/**
 * Rate-limit ("throttled") DETECTION for HEADLESS LOCAL delegated jobs
 * (reliability slice 1).
 *
 * When a delegated agent CLI hits a TRANSIENT provider rate-limit it exits ≠0
 * and (without this) is marked `failed` — indistinguishable from a real bug, no
 * retry. This module turns the tail of a finished headless job's `output.log`
 * into a throttle verdict so the conductor can auto-resume with backoff instead
 * of giving up.
 *
 * PURE + conservative by design:
 *  - We scan only the LAST ~60 lines (the caller passes the already-extracted
 *    tail — `tailLines` here only re-bounds it defensively).
 *  - We require the PROVIDER-ERROR SHAPE, not a bare keyword: the model itself
 *    may print "rate limit" mid-sentence while explaining something, and that
 *    must NOT be read as a throttle. Each tool's table lists regexes anchored to
 *    the way THAT provider's CLI emits the error (an `API Error:` / `Error:`
 *    prefix, a leading bullet, a line that IS the error rather than prose).
 *
 * SCOPE: headless LOCAL only. The remote/kubectl path and interactive tmux panes
 * are phase 2 (see TODOs in index.ts); the signatures here are reused verbatim
 * when those land — only the tail SOURCE changes (kubectl logs / capture-pane).
 */

import type { DelegateType } from "./delegate.js";

export type ThrottleVerdict = {
  throttled: boolean;
  /** A short, human-readable tag for the matched signature (for `throttle.lastSignature`). */
  signature?: string;
};

/** Default tail window (lines) — providers print the rate-limit line near the end. */
export const THROTTLE_TAIL_LINES = 60;

type Signature = {
  /** Stable tag recorded on the job (e.g. "claude:rate-limited"). */
  tag: string;
  /**
   * Matches a SINGLE log line (case-insensitive). Anchored to the provider's
   * error shape, NOT a bare keyword, so the model quoting "rate limit" mid-prose
   * does not trip it. Tested line-by-line against the tail.
   */
  re: RegExp;
};

/**
 * Per-tool signature tables. Each regex targets ONE line of the CLI's stderr as
 * the provider's transport layer prints it. Conservatism guard: every pattern
 * requires either an error prefix (`API Error:`, `Error:`, a leading `·`/bullet),
 * an HTTP status token (`429`), or the provider's exact transient-error phrasing
 * — never a lone word that could appear in normal model output.
 */
const SIGNATURES: Readonly<Record<DelegateType, ReadonlyArray<Signature>>> = {
  claude: [
    // `API Error: Server is temporarily limiting requests (not your usage
    // limit) · Rate limited` — the canonical transient claude throttle.
    {
      tag: "claude:temporarily-limiting",
      re: /\btemporarily limiting requests\b/i,
    },
    // An `API Error:` / `Error:` line carrying a rate-limit / overloaded / 429
    // — the error PREFIX is what keeps prose ("the rate limit is 5/min") out.
    {
      tag: "claude:rate-limited",
      re: /(?:api )?error.*\b(?:rate[\s-]?limit(?:ed|ing)?|overloaded|429)\b/i,
    },
    // The provider's bulleted transient marker: `· Rate limited` / `· 429`.
    {
      tag: "claude:bullet-rate-limited",
      re: /(?:·|•|·)\s*(?:rate[\s-]?limited|429|overloaded)\b/i,
    },
    // A line that IS just the HTTP status the gateway returns on overload.
    {
      tag: "claude:http-429",
      re: /\b(?:http\s*)?(?:status\s*)?429\b.*\b(?:too many requests|rate)/i,
    },
  ],
  codex: [
    // codex prints `Rate limit reached` / `Rate limit reached for …`.
    {
      tag: "codex:rate-limit-reached",
      re: /\brate limit reached\b/i,
    },
    // codex transport error carrying a 429 / rate-limit.
    {
      tag: "codex:rate-limited",
      re: /error.*\b(?:rate[\s-]?limit(?:ed)?|429)\b/i,
    },
    {
      tag: "codex:stream-429",
      re: /\bstream error\b.*\b429\b/i,
    },
  ],
  agy: [
    // agy (antigravity) equivalent — quota/rate-limit on a `RESOURCE_EXHAUSTED`
    // / `429` transport error (the Gemini-family transient shape).
    {
      tag: "agy:resource-exhausted",
      re: /\bresource[\s_-]?exhausted\b/i,
    },
    {
      tag: "agy:rate-limited",
      re: /error.*\b(?:rate[\s-]?limit(?:ed)?|quota exceeded|429)\b/i,
    },
    {
      tag: "agy:rate-limit-reached",
      re: /\brate limit\b.*\b(?:reached|exceeded)\b/i,
    },
  ],
};

/**
 * Decide whether the tail of a finished headless job's output indicates a
 * transient PROVIDER rate-limit (throttle), vs a real failure. Case-insensitive,
 * line-anchored, conservative (provider-error shape required). Scans only the
 * last `tailLines` lines. Pure, exported for tests.
 *
 * @param tailText the captured tail of `output.log` (caller passes ~last 60
 *   lines; we re-bound defensively so an over-long buffer can't widen the scan).
 * @param type the delegate tool (claude | codex | agy) — selects the table.
 */
export function detectThrottle(
  tailText: string,
  type: DelegateType,
  tailLines: number = THROTTLE_TAIL_LINES,
): ThrottleVerdict {
  if (!tailText) return { throttled: false };
  const lines = tailText.split(/\r?\n/);
  const scan = lines.slice(Math.max(0, lines.length - tailLines));
  const table = SIGNATURES[type];
  for (const line of scan) {
    for (const sig of table) {
      if (sig.re.test(line)) {
        return { throttled: true, signature: sig.tag };
      }
    }
  }
  return { throttled: false };
}
