/**
 * Types for `check-ui-vocabulary.mjs`.
 *
 * The checker is plain `.mjs` because it must run as a build step with no
 * compile in front of it — a gate that needs the build to work before it can
 * run is a gate that cannot guard the build. This declaration is what lets
 * `test/vocabulary.test.ts` consume it under `strict`, so the offender shape is
 * a checked contract in the tests rather than `any`.
 *
 * `kind` mirrors the union core's ingest scanner reports, plus the two this
 * repo adds: `unknown-class` (a well-formed class the served sheet does not
 * define — the shape ingest cannot see) and `stylesheet-emitted`.
 */
export interface VocabularyOffender {
  /** Package-relative path. */
  readonly file: string;
  /** 1-based line number inside that file. */
  readonly line: number;
  /** The matched token, truncated. */
  readonly token: string;
  readonly kind:
    | 'arbitrary-value'
    | 'arbitrary-variant'
    | 'unknown-class'
    | 'stylesheet-emitted';
}

export interface CheckOptions {
  /** Directory holding the built bundle (`../plugin/ui`). */
  bundleDir: string;
  /** Source tree for the exact-precision second pass. Omit to skip it. */
  sourceDir?: string | undefined;
}

/** Returns every violation found. An empty array is the only clean result. */
export function check(options: CheckOptions): VocabularyOffender[];
