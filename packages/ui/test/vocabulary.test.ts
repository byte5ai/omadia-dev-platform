/**
 * The vocabulary gate — the check that keeps this bundle renderable.
 *
 * A class outside the served sheet does not error. It renders unstyled, on the
 * operator's screen, and nowhere else. These tests are what make the gate
 * trustworthy enough to be the only thing standing between that and a release.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { check } from '../scripts/check-ui-vocabulary.mjs';
import { extractClasses } from '../scripts/extract-vocabulary.mjs';

/**
 * `import.meta.url` is not a `file:` URL under the jsdom environment, so
 * `fileURLToPath` throws — a trap worth naming, because the same line works
 * fine in the node environment and fails only here. Vitest sets the cwd to the
 * config root, which is this package.
 */
const pkgRoot = resolve(process.cwd());
const bundleDir = join(pkgRoot, '..', 'plugin', 'ui');
const fixtures = join(pkgRoot, 'test', 'fixtures');

function walk(dir: string, exts: Set<string>, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, out);
    else if (exts.has(extname(e.name))) out.push(full);
  }
  return out;
}

describe('the built bundle', () => {
  it('exists — a vocabulary check with nothing to check is not a pass', () => {
    expect(existsSync(join(bundleDir, 'index.html'))).toBe(true);
    expect(walk(bundleDir, new Set(['.js'])).length).toBeGreaterThan(0);
  });

  // The whole reason `.css` is absent from the plugin-ZIP allowlist: that
  // absence is what forces every plugin onto the single sheet core generates
  // from its own tokens. A bundle that emitted one would be rejected at ingest
  // with `zip.forbidden_extension`, after upload, by someone else.
  it('emits NO stylesheet, at any depth', () => {
    const css = walk(bundleDir, new Set(['.css', '.scss', '.sass', '.less']));
    expect(css).toEqual([]);
  });

  it('links the sheet core serves, and does not inline a bootstrap script', () => {
    const html = readFileSync(join(bundleDir, 'index.html'), 'utf8');
    expect(html).toContain('/bot-api/_harness/plugin-ui.css');

    // `pluginUiStatic.ts` serves this document under `script-src 'self'` with
    // no `'unsafe-inline'` and no hash. An inline <script> is therefore dead
    // code that logs a CSP violation — which is how core's own proof fixture
    // sets the theme, and why this bundle does it from the entry module.
    // Comments are stripped first: this file EXPLAINS the CSP rule in prose,
    // and the word '<script' inside that explanation is not a script tag.
    const markup = html.replace(/<!--[\s\S]*?-->/g, '');
    const inline = [...markup.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1]?.trim() ?? '')
      .filter((body) => body.length > 0);
    expect(inline).toEqual([]);
  });

  it('references its assets relatively, so any plugin id can serve it', () => {
    const html = readFileSync(join(bundleDir, 'index.html'), 'utf8');
    // An absolute `/assets/...` would bake this build's mount path into the
    // artifact; the id comes from the INSTALL, not from the build.
    expect(html).toMatch(/src="\.\/assets\//);
    expect(html).not.toMatch(/src="\/assets\//);
  });

  it('passes the full gate', () => {
    const offenders = check({ bundleDir, sourceDir: join(pkgRoot, 'src') });
    expect(offenders).toEqual([]);
  });
});

describe('the gate itself', () => {
  it('rejects an arbitrary value — w-[137px]', () => {
    const offenders = check({ bundleDir: fixtures, sourceDir: undefined });
    const tokens = offenders.map((o) => o.token);
    expect(tokens).toContain('w-[137px]');
    expect(offenders.some((o) => o.kind === 'arbitrary-value')).toBe(true);
  });

  it('rejects an arbitrary variant — [&>tr]:…', () => {
    const offenders = check({ bundleDir: fixtures, sourceDir: undefined });
    expect(offenders.some((o) => o.kind === 'arbitrary-variant')).toBe(true);
  });

  // This is the shape core's ingest scan CANNOT see. `bg-blue-500` is not an
  // arbitrary value; it is a perfectly ordinary class that does not exist in
  // the served sheet. If the whitelist diff ever stops catching it, nothing
  // else will.
  it('rejects a well-formed class that core does not serve — bg-blue-500', () => {
    const offenders = check({ bundleDir: fixtures, sourceDir: undefined });
    const unknown = offenders.filter((o) => o.kind === 'unknown-class').map((o) => o.token);
    expect(unknown).toContain('bg-blue-500');
  });

  it('reports file and 1-based line for every offender', () => {
    const offenders = check({ bundleDir: fixtures, sourceDir: undefined });
    expect(offenders.length).toBeGreaterThan(0);
    for (const o of offenders) {
      expect(o.file).toBeTruthy();
      expect(o.line).toBeGreaterThanOrEqual(1);
      expect(o.token).toBeTruthy();
    }
  });

  // A gate that fires on everything gets switched off. The clean fixture uses
  // only vocabulary classes and must produce nothing.
  it('does not fire on a clean class list', () => {
    const offenders = check({ bundleDir: fixtures, sourceDir: undefined }).filter((o) =>
      o.file.endsWith('clean.js'),
    );
    expect(offenders).toEqual([]);
  });

  it('exits non-zero from the CLI when the bundle is dirty', () => {
    const run = (): string =>
      execFileSync(
        process.execPath,
        [join(pkgRoot, 'scripts', 'check-ui-vocabulary.mjs'), '--bundle', fixtures, '--source', 'none'],
        { cwd: pkgRoot, encoding: 'utf8', stdio: 'pipe' },
      );
    expect(run).toThrow();
  });
});

describe('the vocabulary itself', () => {
  const vocabulary = new Set(
    readFileSync(join(pkgRoot, 'vocabulary', 'classes.txt'), 'utf8').split('\n').filter(Boolean),
  );

  it('holds the classes the served sheet actually defines', () => {
    expect(vocabulary.size).toBeGreaterThan(600);
    for (const c of ['bg-accent', 'text-fg-muted', 'border-border', 'p-6', 'sm:flex', 'grid-cols-3']) {
      expect(vocabulary.has(c)).toBe(true);
    }
  });

  it('has NO Tailwind colour palette — colours are semantic roles only', () => {
    for (const c of [...vocabulary]) {
      expect(c).not.toMatch(/-(?:blue|red|green|slate|zinc|gray|indigo)-\d{2,3}$/);
    }
  });

  /**
   * Regression pin for a REAL defect in core's vocabulary generation.
   *
   * `plugin-ui.source.css` declares `@source inline("border,border-{0,2,4}")`,
   * `@source inline("divide-y,divide-x")` and
   * `@source inline("transition,transition-{...}")`. Tailwind's `@source
   * inline()` expands BRACES, not top-level commas — so all three emit
   * nothing, while the neighbouring `rounded{,-none,...}` and `shadow{,-none,...}`
   * declarations, which use the empty-alternative brace form, work fine.
   *
   * The consequence is silent: Tailwind's base reset is `border: 0 solid`, so
   * `class="border border-border"` sets a colour on a zero-width border and
   * renders INVISIBLE. `plugin-ui-vocabulary.md` lists all three groups as
   * available, so the doc and the artifact disagree.
   *
   * This test asserts the CURRENT, broken reality, so that regenerating the
   * vocabulary after core fixes those three lines fails here and prompts
   * `BORDER` in `src/lib/cx.ts` to collapse back to `'border'`.
   */
  it('pins the three broken comma-form declarations in core (see lib/cx.ts)', () => {
    expect(vocabulary.has('border')).toBe(false);
    expect(vocabulary.has('divide-y')).toBe(false);
    expect(vocabulary.has('transition')).toBe(false);
    // …while the brace-form neighbours prove the generator itself works.
    expect(vocabulary.has('rounded')).toBe(true);
    expect(vocabulary.has('shadow')).toBe(true);
    // The directional utilities the workaround relies on ARE emitted.
    for (const c of ['border-t', 'border-r', 'border-b', 'border-l']) {
      expect(vocabulary.has(c)).toBe(true);
    }
  });

  it('extracts class selectors without swallowing decimal values', () => {
    const classes = extractClasses('.p-4{padding:0.25rem}.text-fg{color:var(--fg)}');
    expect(classes).toEqual(['p-4', 'text-fg']);
  });

  it('unescapes variant separators the way a class attribute spells them', () => {
    expect(extractClasses('.hover\\:bg-accent:hover{color:red}')).toContain('hover:bg-accent');
  });
});

describe('the shipped ZIP payload', () => {
  it('keeps the bundle small enough to be worth serving', () => {
    const js = walk(bundleDir, new Set(['.js']));
    const bytes = js.reduce((n, f) => n + statSync(f).size, 0);
    // Not a performance budget — a tripwire. A jump past this means a
    // dependency arrived that a plugin bundle should not be carrying.
    expect(bytes).toBeLessThan(600 * 1024);
  });
});
