#!/usr/bin/env node
/**
 * check-ui-vocabulary.mjs — fail the build on any class core does not serve.
 *
 *     node scripts/check-ui-vocabulary.mjs            # checks ../plugin/ui + src
 *     node scripts/check-ui-vocabulary.mjs --bundle X --source Y
 *
 * ## The failure this prevents
 *
 * A plugin ships no stylesheet. It links the one core generates from a
 * finite, pre-declared vocabulary, because Tailwind emits only classes it saw
 * at build time and a plugin installed at runtime from another repository is
 * never seen. A class outside that vocabulary therefore does not error
 * anywhere — it renders **unstyled**, on the operator's screen, and nowhere
 * else. Silent and remote is the worst pair of properties a defect can have,
 * so this runs at build time in the repo that produced the class.
 *
 * ## Three checks, and why it is three rather than one
 *
 * **1. No stylesheet in the output.** `.css` is absent from the plugin-ZIP
 * extension allowlist AND from the static router's Content-Type table. A
 * bundle that emitted one would be rejected at ingest, or — if it slipped
 * past — would ship with a `<link>` that 404s. Cheapest possible check,
 * catches an accidental `import './x.css'` the moment it lands.
 *
 * **2. Arbitrary values, scanned in the built JS.** This runs the SAME two
 * regexes core runs at package ingest
 * (`middleware/src/plugins/tailwindArbitraryValueScan.ts`), over the same
 * file scope (`ui/**\/*.js`, `*.mjs`). It is deliberately a copy rather than
 * an import: this repo does not depend on core's middleware, and a check that
 * is only *approximately* the ingest check would let a package build green
 * here and be rejected there — which is a worse experience than failing here.
 * Parity is asserted by `test/vocabulary.test.ts` against the documented
 * patterns.
 *
 * **3. Whitelist diff.** Ingest does NOT catch `bg-blue-500`. It is not an
 * arbitrary value, it is an ordinary-looking class that simply does not exist
 * in the served sheet, and only a whitelist can see that. So this is the
 * check that has no counterpart in core, and it is the one that actually
 * protects the rendered page.
 *
 * ## Where the whitelist diff looks, and why in two places
 *
 * The bundle scan (2) is exact. The whitelist diff (3) is not, and cannot be:
 * a minified bundle is a soup of strings and only some of them are class
 * lists. Prose, i18n keys and CSS-in-JS all look similar enough that a naive
 * token diff would drown in false positives.
 *
 * So the diff runs twice, and the two passes have opposite error profiles:
 *
 * | Pass | Precision | What it misses |
 * |---|---|---|
 * | `src/**` — every `className` attribute and `cx(...)` argument, parsed from the real source | exact — an attribute is unambiguously a class list | classes assembled at runtime |
 * | `ui/**\/*.js` — literals that look like class lists | heuristic (see `looksLikeClassList`) | a literal whose tokens are ALL unknown |
 *
 * The source pass catches the standalone `"bg-blue-500"` the bundle
 * heuristic skips; the bundle pass catches a class that reached the output
 * from a dependency the source pass never reads. Neither alone is enough.
 * Both are cheap.
 *
 * ## The limit, stated rather than papered over
 *
 * A class assembled at runtime (`` `bg-${tone}` ``) defeats every static
 * check here, exactly as it defeats core's. Nothing claims otherwise. The
 * vocabulary is the contract; this is its cheap enforcement, and code that
 * routes around it merely ends up unstyled. The codebase's answer is to write
 * the branches out in full (`tone === 'danger' ? 'bg-danger' : 'bg-success'`)
 * so both literals are visible to this scanner — see `src/lib/cx.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── the two ingest patterns, copied verbatim from core ──────────────────────
// Any edit here must be mirrored in `tailwindArbitraryValueScan.ts` and vice
// versa; `test/vocabulary.test.ts` pins the behaviour of both.

/** `w-[137px]`, `md:hover:bg-[#abc]`, `data-[state=open]:!w-[137px]`. */
const ARBITRARY_VALUE =
  /(?<![\w$])((?:(?:[a-z0-9][a-z0-9-]*(?:-\[[^\]\s"'`]+\])?):)*!?-?[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\[[^\]\s"'`]+\])/g;

/** `[&>tr]:border`, `[&_p]:mt-2` — arbitrary variants. */
const ARBITRARY_VARIANT = /(\[&[^\]\s"'`]*\](?::[a-z0-9[\]&_>-]+)?)/g;

/** Core caps its ingest scan at 200 files / 8 MB. Mirrored so a bundle that
 *  would be too large to scan there does not build green here. */
const MAX_FILES = 200;
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Non-Tailwind classes this SPA is allowed to use. Each is either a hook the
 * bundle's own code targets or a class the served sheet defines outside the
 * utility vocabulary. Anything added here is a class that will NOT be styled
 * by core, so it must be styled by nothing at all — a pure behaviour hook.
 */
const NON_TAILWIND_ALLOWED = new Set([
  // Targeted by `useStickToBottom`'s scroll math, never styled.
  'js-log-viewport',
]);

function readVocabulary() {
  const raw = readFileSync(join(pkgRoot, 'vocabulary', 'classes.txt'), 'utf8');
  const set = new Set(
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#')),
  );
  if (set.size < 100) {
    throw new Error(
      `vocabulary/classes.txt holds only ${set.size} entries — regenerate it with scripts/extract-vocabulary.mjs`,
    );
  }
  return set;
}

function walk(dir, exts, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, out);
    else if (exts.has(extname(e.name))) out.push(full);
  }
  return out;
}

/** 1-based line number of `index` within `content`. */
function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

// ── check 1: no stylesheet ─────────────────────────────────────────────────

function checkNoCss(bundleDir) {
  const css = walk(bundleDir, new Set(['.css', '.scss', '.sass', '.less']));
  return css.map((f) => ({
    file: relative(pkgRoot, f),
    line: 1,
    token: extname(f),
    kind: 'stylesheet-emitted',
  }));
}

// ── check 2: arbitrary values, core's patterns ─────────────────────────────

function scanArbitrary(files) {
  const offenders = [];
  let budget = MAX_BYTES;
  for (const file of files.slice(0, MAX_FILES)) {
    const size = statSync(file).size;
    if (size > budget) break;
    budget -= size;
    const content = readFileSync(file, 'utf8');
    for (const [re, kind] of [
      [ARBITRARY_VALUE, 'arbitrary-value'],
      [ARBITRARY_VARIANT, 'arbitrary-variant'],
    ]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content)) !== null) {
        offenders.push({
          file: relative(pkgRoot, file),
          line: lineOf(content, m.index),
          token: m[1].slice(0, 120),
          kind,
        });
      }
    }
  }
  return offenders;
}

// ── check 3: whitelist diff ────────────────────────────────────────────────

/** A single token that could plausibly be a Tailwind utility. */
const CLASS_TOKEN = /^-?[a-z0-9][a-z0-9:./_-]*$/;

/**
 * Is this string literal a class list rather than prose, a key or a path?
 *
 * The test is "every token is class-shaped AND at least one token is a class
 * we know". The second half is what keeps the false-positive rate usable: an
 * i18n key like `jobs.table.empty` is class-shaped but contains no known
 * class, so it drops out. The cost is a false negative on a literal whose
 * tokens are ALL unknown — which the `src/**` pass covers.
 */
function looksLikeClassList(value, vocabulary) {
  if (value.length === 0 || value.length > 500) return false;
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (!tokens.every((t) => CLASS_TOKEN.test(t))) return false;
  return tokens.some((t) => vocabulary.has(t));
}

const STRING_LITERAL = /"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|`([^`\\$]*)`/g;

function diffBundle(files, vocabulary) {
  const offenders = [];
  for (const file of files.slice(0, MAX_FILES)) {
    const content = readFileSync(file, 'utf8');
    STRING_LITERAL.lastIndex = 0;
    let m;
    while ((m = STRING_LITERAL.exec(content)) !== null) {
      const value = m[1] ?? m[2] ?? m[3];
      if (value === undefined) continue;
      if (!looksLikeClassList(value, vocabulary)) continue;
      for (const token of value.split(/\s+/).filter(Boolean)) {
        if (vocabulary.has(token) || NON_TAILWIND_ALLOWED.has(token)) continue;
        offenders.push({
          file: relative(pkgRoot, file),
          line: lineOf(content, m.index),
          token,
          kind: 'unknown-class',
        });
      }
    }
  }
  return offenders;
}

/**
 * `className="..."`, `className={'...'}` and every string argument to `cx(`.
 * Parsed from source, where an attribute is unambiguously a class list, so
 * this pass needs no "at least one known token" escape hatch.
 */
const SOURCE_CLASS_SITES = [
  /className\s*=\s*"([^"]*)"/g,
  /className\s*=\s*\{?\s*'([^']*)'/g,
  /\bcx\(([^)]*)\)/g,
];

function diffSource(files, vocabulary) {
  const offenders = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const re of SOURCE_CLASS_SITES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content)) !== null) {
        // For `cx(...)` only the string literals inside are class lists; the
        // conditionals between them are code.
        const literals =
          re === SOURCE_CLASS_SITES[2]
            ? [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2] ?? '')
            : [m[1] ?? ''];
        for (const literal of literals) {
          for (const token of literal.split(/\s+/).filter(Boolean)) {
            if (token.includes('${')) continue; // runtime-assembled; see header
            if (vocabulary.has(token) || NON_TAILWIND_ALLOWED.has(token)) continue;
            offenders.push({
              file: relative(pkgRoot, file),
              line: lineOf(content, m.index),
              token,
              kind: 'unknown-class',
            });
          }
        }
      }
    }
  }
  return offenders;
}

// ── entry point ────────────────────────────────────────────────────────────

export function check({ bundleDir, sourceDir }) {
  const vocabulary = readVocabulary();
  const bundleFiles = walk(bundleDir, new Set(['.js', '.mjs'])).sort();
  const sourceFiles = sourceDir
    ? walk(sourceDir, new Set(['.ts', '.tsx'])).sort()
    : [];

  return [
    ...checkNoCss(bundleDir),
    ...scanArbitrary(bundleFiles),
    ...diffBundle(bundleFiles, vocabulary),
    ...diffSource(sourceFiles, vocabulary),
  ];
}

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundleDir = resolve(pkgRoot, argValue('--bundle', '../plugin/ui'));
  const sourceArg = argValue('--source', 'src');
  const sourceDir = sourceArg === 'none' ? undefined : resolve(pkgRoot, sourceArg);

  const bundleFileCount = walk(bundleDir, new Set(['.js', '.mjs'])).length;
  if (bundleFileCount === 0) {
    // A vocabulary check that found no bundle to check is not a pass. This is
    // the shape of green that hides a build that never ran.
    console.error(
      `✗ no .js found under ${bundleDir} — run \`vite build\` before the vocabulary check`,
    );
    process.exit(1);
  }

  const offenders = check({ bundleDir, sourceDir });
  if (offenders.length === 0) {
    console.log(
      `✓ UI vocabulary clean — ${bundleFileCount} bundle file(s), no stylesheet, no arbitrary values, no unknown classes`,
    );
    process.exit(0);
  }

  // Deduplicate: the same class in the same file on the same line, found by
  // two passes, is one problem.
  const seen = new Set();
  const unique = offenders.filter((o) => {
    const key = `${o.file}:${o.line}:${o.token}:${o.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.error(`✗ ${unique.length} UI vocabulary violation(s):\n`);
  for (const o of unique.slice(0, 100)) {
    console.error(`  ${o.file}:${o.line}  ${o.kind}  ${o.token}`);
  }
  if (unique.length > 100) console.error(`  … and ${unique.length - 100} more`);
  console.error(
    '\nThe served sheet contains only the classes in vocabulary/classes.txt.\n' +
      'A class outside it renders UNSTYLED at runtime, silently. Either use a\n' +
      'class from the vocabulary, or widen the vocabulary in core first — see\n' +
      'vocabulary/README.md.',
  );
  process.exit(1);
}
