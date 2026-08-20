/**
 * SEAM — was `middleware/src/conductor/runExecutor.ts` → `parseIsoDurationMs`.
 *
 * `pipeline/gateStore.ts` reached into the Conductor's run executor for exactly
 * one pure function: parsing the ISO-8601 duration an operator writes into
 * `dev_repos.gate_deadline_iso`. Nothing else in that 900-line module was ever
 * wanted, and the Conductor is not a capability a plugin can ask for.
 *
 * Reimplemented here, byte-identical in behaviour to the core original — the
 * regex, the clamp, and the `null`-for-non-positive rule are all preserved, and
 * `test/isoDuration.test.ts` pins them. See SEAMS.md → S4.
 */

/**
 * Parse a restricted ISO-8601 duration (`P[nD][T[nH][nM][nS]]`) into
 * milliseconds. Returns `null` for empty input, an unparseable string, or a
 * non-positive total — a deadline of zero is not a deadline.
 */
export function parseIsoDurationMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso.trim());
  if (!m) return null;
  const [, d, h, min, s] = m;
  const ms =
    (Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return ms > 0 ? ms : null;
}
