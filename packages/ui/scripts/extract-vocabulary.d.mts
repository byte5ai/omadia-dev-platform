/** Types for `extract-vocabulary.mjs` — see `vocabulary/README.md`. */

/**
 * Pull every class selector out of a stylesheet, unescaped into the spelling a
 * `class` attribute uses (`hover:bg-accent`, not `hover\:bg-accent`).
 */
export function extractClasses(css: string): string[];
