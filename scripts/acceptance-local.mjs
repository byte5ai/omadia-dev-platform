#!/usr/bin/env node
/**
 * acceptance-local.mjs — drive `specs/470-dev-platform-plugin/acceptance.md`
 * §2 and §3 against a RUNNING omadia core, and print a PASS/FAIL/BLOCKED table.
 *
 * Epic byte5ai/omadia#470 P5. This is the "smoke suite in the plugin repo that
 * walks §2.1–§2.4 against a running stack" that acceptance.md §4.1 names as the
 * strongest cheap improvement over a hand-worked checklist.
 *
 *     node scripts/acceptance-local.mjs
 *
 * Env (all optional except where noted):
 *   BASE_URL      default http://127.0.0.1:4100
 *   ADMIN_EMAIL   default admin@byte5.de
 *   ADMIN_PASSWORD default omadia-local-dev-1
 *   PLUGIN_ZIP    default packages/plugin/out/<name>-<version>.zip
 *   DATABASE_URL  optional; enables the DB-backed rows (ledger, table counts,
 *                 and the pre-C16 SQL grant INSERT). Without it those rows
 *                 report BLOCKED rather than silently passing. Not needed for
 *                 the grants themselves on a core with the C16 route.
 *   PHASE         `install` (default: full install→probe→uninstall→reinstall)
 *                 or `probe` (assume already installed; probe only)
 *
 * IDEMPOTENT. It uninstalls a previous install before installing, and tolerates
 * a missing one. Re-running it is the normal case, not a special case.
 *
 * THE TWO GRANTS follow whichever surface the core under test ships. With core
 * C16 (byte5ai/omadia#824) that is the unified
 * `PUT …/installed/:id/grants` — the route the install wizard's Permissions
 * step and the plugin page's Grants panel both call — driven AFTER install, in
 * the operator's real order. Without it the run falls back to the pre-#824
 * pair: a hand INSERT into `plugin_sql_grants` before activation, plus the
 * `…/public-paths` route after. The report names which one ran, because
 * "granted" over two different mechanisms is two different claims.
 *
 * EXIT CODE is the number of FAILed rows, capped at 250. BLOCKED does not fail
 * the run — a blocked row is a row this harness could not reach a verdict on,
 * and reporting it as a pass would be the failure mode the whole document
 * exists to prevent.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env['BASE_URL'] ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const EMAIL = process.env['ADMIN_EMAIL'] ?? 'admin@byte5.de';
const PASSWORD = process.env['ADMIN_PASSWORD'] ?? 'omadia-local-dev-1';
const PHASE = process.env['PHASE'] ?? 'install';

const PLUGIN_ID = '@omadia/dev-platform';
const PID = encodeURIComponent(PLUGIN_ID); // %40omadia%2Fdev-platform
const LEDGER = 'plg_omadia_dev_platform_migrations';
const ADMIN = '/api/v1/admin/dev-platform';
const RUNNER = '/api/v1/dev-runner';

// --- results ---------------------------------------------------------------

const rows = [];
const record = (section, name, verdict, evidence) =>
  rows.push({ section, name, verdict, evidence: String(evidence) });
const pass = (s, n, e) => record(s, n, 'PASS', e);
const fail = (s, n, e) => record(s, n, 'FAIL', e);
const blocked = (s, n, e) => record(s, n, 'BLOCKED', e);

/** Assert a probe's status is one the acceptance doc allows.
 *  A 404-from-core or a 500 is ALWAYS a failure: the first means the route is
 *  not mounted, the second means it is mounted and broken. Everything else in
 *  `ok` is a documented, authenticated refusal — which is a working endpoint. */
function expectStatus(section, name, got, ok) {
  if (ok.includes(got)) pass(section, name, `HTTP ${got}`);
  else if (got === 404) fail(section, name, `HTTP 404 — route not mounted (expected ${ok.join('/')})`);
  else if (got >= 500) fail(section, name, `HTTP ${got} — server error (expected ${ok.join('/')})`);
  else fail(section, name, `HTTP ${got} (expected ${ok.join('/')})`);
}

// --- cookie-jar fetch ------------------------------------------------------

let cookie = '';
async function http(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const pair = c.split(';')[0];
    if (pair) cookie = cookie ? `${cookie}; ${pair}` : pair;
  }
  return res;
}
const status = async (path, init) => (await http(path, init)).status;
async function json(path, init) {
  const res = await http(path, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text.slice(0, 200) };
  }
}
const postJson = (path, body) =>
  json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// --- optional DB -----------------------------------------------------------

let pool;
async function db(sql, params = []) {
  if (!process.env['DATABASE_URL']) return undefined;
  if (!pool) {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  }
  return (await pool.query(sql, params)).rows;
}

// --- the endpoint inventory ------------------------------------------------
//
// 38 concrete handlers. acceptance.md §2 says "35 HTTP endpoints (36 concrete
// handlers)"; the count below is what `src/plugin.ts` actually mounts and the
// discrepancy is reported as its own row rather than quietly reconciled.
//
// `ok` lists every status the acceptance doc treats as a WORKING endpoint.
// Auth refusals belong there: `POST /gates/:id/resolve` answering 403 to a
// non-holder is the documented behaviour, not a failure. What must never
// appear is 404 (unmounted) or 5xx (mounted, broken).

const NIL = '00000000-0000-0000-0000-000000000000';

const ENDPOINTS = [
  // 2.1 operator REST — jobs
  ['2.1', 'GET  /jobs', 'GET', `${ADMIN}/jobs`, [200]],
  ['2.1', 'GET  /jobs?status=queued', 'GET', `${ADMIN}/jobs?status=queued`, [200]],
  ['2.1', 'POST /jobs (invalid body → validation, not 500)', 'POST', `${ADMIN}/jobs`, [400, 422], {}],
  ['2.1', 'GET  /jobs/:id (unknown → 404-from-plugin)', 'GET', `${ADMIN}/jobs/${NIL}`, [404, 400]],
  ['2.1', 'POST /jobs/:id/cancel', 'POST', `${ADMIN}/jobs/${NIL}/cancel`, [404, 400, 409], {}],
  ['2.1', 'DELETE /jobs/:id', 'DELETE', `${ADMIN}/jobs/${NIL}`, [404, 400, 204]],
  ['2.1', 'POST /jobs/:id/apply', 'POST', `${ADMIN}/jobs/${NIL}/apply`, [404, 400, 409], {}],
  ['2.1', 'POST /jobs/:id/retry', 'POST', `${ADMIN}/jobs/${NIL}/retry`, [404, 400, 409], {}],
  ['2.1', 'GET  /jobs/:id/artifacts', 'GET', `${ADMIN}/jobs/${NIL}/artifacts`, [200, 404, 400]],
  ['2.1', 'GET  /artifacts/:id', 'GET', `${ADMIN}/artifacts/${NIL}`, [404, 400]],
  ['2.1', 'GET  /jobs/:id/events (SSE)', 'GET', `${ADMIN}/jobs/${NIL}/events`, [200, 404, 400]],
  ['2.1', 'POST /admin/purge (no confirm → refuse)', 'POST', `${ADMIN}/admin/purge`, [400, 409, 422], {}],

  // 2.2 repos & credentials
  ['2.2', 'GET  /repos', 'GET', `${ADMIN}/repos`, [200]],
  ['2.2', 'POST /repos (invalid body)', 'POST', `${ADMIN}/repos`, [400, 422], {}],
  ['2.2', 'GET  /repos/:id', 'GET', `${ADMIN}/repos/${NIL}`, [404, 400]],
  ['2.2', 'PATCH /repos/:id', 'PATCH', `${ADMIN}/repos/${NIL}`, [404, 400, 422], {}],
  ['2.2', 'DELETE /repos/:id', 'DELETE', `${ADMIN}/repos/${NIL}`, [404, 400, 204]],
  ['2.2', 'POST /repos/:id/check', 'POST', `${ADMIN}/repos/${NIL}/check`, [404, 400], {}],
  ['2.2', 'GET  /repos/:id/issues', 'GET', `${ADMIN}/repos/${NIL}/issues`, [404, 400]],
  ['2.2', 'POST /github/connect/start', 'POST', `${ADMIN}/github/connect/start`, [200, 400, 424, 502, 503], {}],
  ['2.2', 'POST /github/connect/poll', 'POST', `${ADMIN}/github/connect/poll`, [200, 400, 404, 424, 502, 503], {}],
  ['2.2', 'POST /github-app/manifest/start', 'POST', `${ADMIN}/github-app/manifest/start`, [200, 400, 422], {}],
  ['2.2', 'GET  /github-apps', 'GET', `${ADMIN}/github-apps`, [200]],
  ['2.2', 'POST /repos/:repoId/credential', 'POST', `${ADMIN}/repos/${NIL}/credential`, [400, 404, 422], {}],

  // 2.3 human gates
  ['2.3', 'GET  /gates?status=waiting', 'GET', `${ADMIN}/gates?status=waiting`, [200]],
  ['2.3', 'POST /gates/:gateId/resolve', 'POST', `${ADMIN}/gates/${NIL}/resolve`, [400, 403, 404, 422], {}],

  // 2.4 runner phone-home — no session; a job bearer token is the real gate,
  // so 401 is the CORRECT answer here and 404 would mean the public-path grant
  // never took effect.
  ['2.4', 'GET  /jobs/:id/spec (no token → 401)', 'GET', `${RUNNER}/jobs/${NIL}/spec`, [401]],
  ['2.4', 'GET  /jobs/:id/scm-token (no token → 401)', 'GET', `${RUNNER}/jobs/${NIL}/scm-token`, [401]],
  ['2.4', 'POST /jobs/:id/events (no token → 401)', 'POST', `${RUNNER}/jobs/${NIL}/events`, [401], {}],
  ['2.4', 'POST /jobs/:id/heartbeat (no token → 401)', 'POST', `${RUNNER}/jobs/${NIL}/heartbeat`, [401], {}],
  ['2.4', 'POST /jobs/:id/diff (no token → 401)', 'POST', `${RUNNER}/jobs/${NIL}/diff`, [401], 'diff-text'],
  ['2.4', 'POST /jobs/:id/result (no token → 401)', 'POST', `${RUNNER}/jobs/${NIL}/result`, [401], {}],
  ['2.4', 'POST /jobs/:id/phase-result (no token → 401)', 'POST', `${RUNNER}/jobs/${NIL}/phase-result`, [401], {}],
  ['2.4', 'GET  /internal/job-policy/:jobId (daemon only)', 'GET', `${RUNNER}/internal/job-policy/${NIL}`, [401, 503]],
  ['2.4', 'GET  /llm/ (unauthenticated liveness)', 'GET', `${RUNNER}/llm/`, [200]],
  ['2.4', 'POST /llm/v1/messages (no token → 401)', 'POST', `${RUNNER}/llm/v1/messages`, [401], {}],

  // 2.5 triggers + GitHub App public half
  ['2.5', 'POST /api/webhooks/github (bad HMAC → 401)', 'POST', '/api/webhooks/github', [400, 401], {}],
  ['GHA', 'GET  /api/v1/dev-platform/github-app/callback', 'GET', '/api/v1/dev-platform/github-app/callback', [400, 401, 403]],
  ['GHA', 'GET  /api/v1/dev-platform/github-app/setup', 'GET', '/api/v1/dev-platform/github-app/setup', [400, 401, 403]],
];

// --- phases ----------------------------------------------------------------

async function login() {
  const { status: s } = await postJson('/api/v1/auth/login/local', { email: EMAIL, password: PASSWORD });
  if (s !== 200) throw new Error(`admin login failed: HTTP ${s} (set ADMIN_EMAIL / ADMIN_PASSWORD)`);
}

function resolveZip() {
  if (process.env['PLUGIN_ZIP']) return process.env['PLUGIN_ZIP'];
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/plugin/package.json'), 'utf8'));
  const safe = pkg.name.replace(/^@/, '').replace(/\//g, '-');
  return join(REPO_ROOT, 'packages/plugin/out', `${safe}-${pkg.version}.zip`);
}

/** Uninstall + drop the uploaded package. Tolerates "not installed". */
async function cleanSlate() {
  await http(`/api/v1/install/installed/${PID}`, { method: 'DELETE' });
  await http(`/api/v1/install/packages/${PID}`, { method: 'DELETE' });
}

async function upload(zipPath) {
  if (!existsSync(zipPath)) throw new Error(`plugin ZIP not found: ${zipPath} — run \`npm run package -w packages/plugin\``);
  const form = new FormData();
  form.append('file', new Blob([readFileSync(zipPath)]), basename(zipPath));
  const res = await http('/api/v1/install/packages/upload', { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// --- the two operator grants -----------------------------------------------
//
// Core C16 (byte5ai/omadia#824) gave both permissions ONE route and a UI that
// calls it. That route is what a real operator's clicks reach, so it is what
// this harness drives — the point of an acceptance run is to walk the path the
// operator walks, not a private shortcut only the harness knows.
//
// It cannot simply assume the route though. This plugin outlives the core
// release it was written against, and the pre-C16 procedure (a hand INSERT plus
// the `/public-paths` route) is still the only one an older core offers. So:
// probe once, prefer the unified route, fall back otherwise — and SAY which one
// ran, because "granted" over two different mechanisms is two different claims
// about the system under test.

const GRANTS = `/api/v1/admin/runtime/installed/${PID}/grants`;
const DECLARED_PUBLIC_PATHS = ['/api/v1/dev-runner', '/api/webhooks/github', '/api/v1/dev-platform'];

/** `true` / `false` once probed, `undefined` while still unknown. */
let hasUnifiedGrants;

/**
 * Does this core ship the C16 route? Answered ONLY in the affirmative here.
 *
 * A missing route and a not-installed plugin both answer 404, and core's 404
 * body is not stable enough to tell them apart. This probe runs before the
 * clean slate, when the previous run's install may or may not still be there,
 * so a 404 proves nothing and is deliberately not recorded as a `false`. What
 * a 200 carrying a `declared` block does prove is that the route exists — and
 * that is the only thing worth changing the run's ordering over.
 *
 * Left `undefined`, the run keeps the pre-C16 ordering, which is correct on
 * every core; `grantUnified()` then settles the question after install, where
 * a 404 IS conclusive.
 */
async function probeUnifiedGrants() {
  const { status: s, body } = await json(GRANTS);
  if (s === 200 && body && typeof body === 'object' && body.declared) hasUnifiedGrants = true;
  return hasUnifiedGrants;
}

/** Both grants over the C16 route, exactly as the wizard's "Grant & activate"
 *  and the plugin page's Grants panel do. Returns false when the route is not
 *  there, so the caller can fall back. */
async function grantUnified() {
  const { status: s, body } = await json(GRANTS, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: true, public_paths: DECLARED_PUBLIC_PATHS }),
  });
  if (s === 404) {
    hasUnifiedGrants = false;
    return false;
  }
  hasUnifiedGrants = true;
  if (s !== 200) {
    fail('§3.8', 'both grants (C16 unified PUT)', `HTTP ${s} ${JSON.stringify(body).slice(0, 200)}`);
    return true;
  }

  // The route answers with the state it read back AFTER re-activating. Trust
  // that, not the 200: a 200 proves the write landed, not that the plugin came
  // back up, and the whole reason C16 re-activates in-process is so the answer
  // to "did the grant take?" is available now rather than after a restart.
  const g = body.granted ?? {};
  const paths = g.public_paths ?? [];
  const missing = DECLARED_PUBLIC_PATHS.filter((p) => !paths.includes(p));
  if (g.sql === true && missing.length === 0) {
    pass('§3.8', 'both grants (C16 unified PUT)', `sql=true, ${paths.length} public paths, state=${body.state}`);
  } else {
    fail('§3.8', 'both grants (C16 unified PUT)', `sql=${g.sql} missing=${JSON.stringify(missing)} state=${body.state}`);
  }

  if (body.state === 'active') {
    pass('§3.8', 'grant takes effect in-process (no restart)', 'state=active straight out of the PUT');
  } else {
    fail('§3.8', 'grant takes effect in-process (no restart)',
      `state=${body.state} error=${JSON.stringify(body.last_activation_error).slice(0, 200)}`);
  }
  return true;
}

/** Pre-C16 SQL grant: no HTTP endpoint exists, so it goes in over SQL and says
 *  so when it cannot. Must run BEFORE activation — `ctx.services.get` is
 *  synchronous, so the grant is read once while the plugin's context is built
 *  and a row written afterwards reaches a context that has already decided. */
async function grantSqlLegacy() {
  if (!process.env['DATABASE_URL']) {
    blocked('§3.8', 'SQL grant (permissions.sql)', 'no DATABASE_URL — the pre-C16 grant path is a direct INSERT and needs one');
    return;
  }
  await db(
    `INSERT INTO plugin_sql_grants (plugin_id, ledger, granted_by) VALUES ($1,$2,$3)
     ON CONFLICT (plugin_id) DO UPDATE SET ledger=EXCLUDED.ledger, granted_at=now()`,
    [PLUGIN_ID, LEDGER, EMAIL],
  );
  pass('§3.8', 'SQL grant (permissions.sql)', 'inserted into plugin_sql_grants (pre-C16 core: no HTTP endpoint)');
}

/** The C4 route. Kept as a thin alias by C16, so this exercises the promise
 *  that pre-#824 automation still works — on both cores. */
async function grantPublicPathsLegacy() {
  const { status: s, body } = await json(`/api/v1/admin/runtime/installed/${PID}/public-paths`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paths: DECLARED_PUBLIC_PATHS }),
  });
  if (s === 200) pass('§3.8', 'public-path consent (C4 PUT)', `granted ${DECLARED_PUBLIC_PATHS.length}: ${JSON.stringify(body.paths ?? body)}`);
  else fail('§3.8', 'public-path consent (C4 PUT)', `HTTP ${s} ${JSON.stringify(body).slice(0, 160)}`);
}

/** Everything a plugin needs granted, over whichever surface this core has.
 *  Called AFTER install, which is the operator's real order on a C16 core. */
async function grantAll() {
  if (hasUnifiedGrants !== false && (await grantUnified())) return;
  await grantPublicPathsLegacy();
}

/**
 * @param {{ sqlGrantedBeforeActivation?: boolean }} opts
 *   Whether the SQL grant is already on record when `activate()` runs. On a
 *   pre-C16 core it always is — the harness inserts the row first, because
 *   nothing can re-activate the plugin afterwards. On a C16 core it deliberately
 *   is NOT: the operator answers the wizard's Permissions step after configure,
 *   and this run walks the same order.
 */
async function install({ sqlGrantedBeforeActivation = true } = {}) {
  const create = await postJson(`/api/v1/install/plugins/${PID}`, {});
  if (create.status !== 201) {
    fail('§3.6', 'install job created', `HTTP ${create.status} ${JSON.stringify(create.body).slice(0, 240)}`);
    return null;
  }
  const job = create.body.job;
  const fields = job?.setup_schema?.fields ?? [];
  pass('§3.6', 'setup fields render from manifest', `${fields.length} fields, state=${job.state}`);

  const conf = await postJson(`/api/v1/install/jobs/${job.id}/configure`, {
    values: { llm_allowed_models: ['claude-sonnet-4-5-20250929'], runner_base_url: BASE },
  });
  const st = conf.body?.job?.state;
  const err = JSON.stringify(conf.body?.job?.error).slice(0, 300);
  if (st === 'active') {
    pass('§3.9', 'activation', 'state=active, no error');
  } else if (!sqlGrantedBeforeActivation && st === 'errored') {
    // Not a failure — the documented consequence of installing before granting.
    // This plugin reaches for the database in `activate()`, so with the C16
    // wizard the honest state between "configured" and "granted" is `errored`,
    // and the grant PUT that follows is what has to bring it back up. Calling
    // this a FAIL would make the harness red on the exact flow it is meant to
    // prove works.
    pass('§3.9', 'activation', `state=errored before the grant, as documented — ${err.slice(0, 140)}`);
  } else {
    fail('§3.9', 'activation', `state=${st} error=${err}`);
  }
  return job.id;
}

async function verifyInstalled() {
  // migrations ledger
  const led = await db(`SELECT count(*)::int AS n FROM ${LEDGER}`).catch(() => undefined);
  if (led) {
    if (led[0].n === 9) pass('§3.7', 'migration ledger has 9 filenames', `${LEDGER} = 9 rows`);
    else fail('§3.7', 'migration ledger has 9 filenames', `${LEDGER} = ${led[0].n} rows`);
  } else blocked('§3.7', 'migration ledger has 9 filenames', 'no DATABASE_URL');

  const tabs = await db(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'dev\\_%'`,
  ).catch(() => undefined);
  if (tabs) {
    if (tabs[0].n === 9) pass('§3.7', 'the 9 dev_* tables exist', '9 tables');
    else fail('§3.7', 'the 9 dev_* tables exist', `${tabs[0].n} tables`);
  } else blocked('§3.7', 'the 9 dev_* tables exist', 'no DATABASE_URL');

  // nav
  const nav = await json('/api/v1/ui/navigation?locale=en');
  const navText = JSON.stringify(nav.body);
  if (navText.includes('devPlatform')) pass('§3.9', 'nav entry present', 'navId devPlatform in /api/v1/ui/navigation');
  else fail('§3.9', 'nav entry present', 'no devPlatform entry — registerNav rejected or activation rolled back');

  // SPA — the ENCODED id is the only form that works
  const spa = await status(`/p/${PID}/ui/`);
  expectStatus('§2.7', `SPA served at /p/${PID}/ui/`, spa, [200]);
  const raw = await status('/p/@omadia/dev-platform/ui/');
  if (raw === 404) pass('§2.7', 'unencoded id does NOT serve (encoded is canonical)', 'HTTP 404 as expected');
  else fail('§2.7', 'unencoded id does NOT serve (encoded is canonical)', `HTTP ${raw}`);

  const html = await (await http(`/p/${PID}/ui/`)).text();
  const asset = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0];
  if (asset) {
    const a = await status(`/p/${PID}/ui/${asset}`);
    expectStatus('§2.7', 'hashed UI asset served', a, [200]);
  } else fail('§2.7', 'hashed UI asset served', 'no hashed asset referenced by index.html');

  expectStatus('§2.7', 'plugin-ui.css served by core', await status('/api/_harness/plugin-ui.css'), [200]);

  // no stylesheet inside the bundle — the enforcement C8 relies on
  if (!/\.css(["')]|$)/m.test(html.replace(/plugin-ui\.css/g, ''))) {
    pass('§2.7', 'bundle links no stylesheet of its own', 'no non-core .css reference in index.html');
  } else blocked('§2.7', 'bundle links no stylesheet of its own', 'a .css reference is present — inspect manually');
}

async function probeEndpoints() {
  for (const [section, name, method, path, ok, body] of ENDPOINTS) {
    const init = { method };
    if (body !== undefined) {
      if (typeof body === 'string') {
        init.headers = { 'content-type': 'text/plain' };
        init.body = body;
      } else {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
    }
    let got;
    try {
      got = await status(path, init);
    } catch (err) {
      fail(section, name, `request threw: ${err.message}`);
      continue;
    }
    expectStatus(section, name, got, ok);
  }
  record('§2', 'endpoint count', 'PASS', `${ENDPOINTS.length} probes over 38 concrete handlers (acceptance.md §2 claims 35 endpoints / 36 handlers — see report)`);
}

/**
 * Is this path served BY THE PLUGIN, as opposed to falling through to core's
 * 404 handler?
 *
 * Status alone cannot answer it. `GET /jobs/<unknown-uuid>` legitimately
 * answers 404, and so does an unmounted route — the same number for opposite
 * meanings, which is exactly the confusion acceptance.md §2 warns about when
 * it demands a probe rather than a source reference. The bodies differ though:
 * Express's default 404 is an HTML page ("Cannot GET /..."), while every
 * plugin router answers JSON with a `code`. So a 404 carrying JSON proves the
 * route is mounted and reached its handler.
 */
async function isMounted(path, init = {}) {
  const res = await http(path, init);
  if (res.status < 400) return { mounted: true, why: String(res.status) };

  const text = await res.text();
  const coded = /^\s*[{[]/.test(text) ? (() => { try { return JSON.parse(text).code; } catch { return undefined; } })() : undefined;

  if (res.status === 404) {
    return coded !== undefined
      ? { mounted: true, why: `404 from the plugin (${coded})` }
      : { mounted: false, why: '404 from core (HTML) — route not mounted' };
  }
  // A 503 carrying the plugin's own error code is a DELIBERATE unavailability
  // ("device-flow onboarding is not configured"), i.e. a mounted route
  // answering honestly about an unconfigured integration. A bare 500/502/504
  // is not — that is a mounted route that broke.
  if (res.status === 503 && coded) return { mounted: true, why: `503 ${coded} (unconfigured, not broken)` };
  if (res.status >= 500) return { mounted: false, why: `${res.status} server error` };
  return { mounted: true, why: String(res.status) };
}

async function probeUiScreens() {
  // The 4 screens are hash routes over ONE bundle, so "reachable" is proved by
  // the APIs each screen fetches on mount, not by a per-screen URL.
  const screens = {
    'HubScreen (repos/jobs/apps/gates tabs)': [`${ADMIN}/repos`, `${ADMIN}/jobs`, `${ADMIN}/github-apps`, `${ADMIN}/gates?status=waiting`],
    'JobDetailScreen': [`${ADMIN}/jobs/${NIL}`, `${ADMIN}/gates?status=waiting`],
    'RepoDetailScreen': [`${ADMIN}/repos/${NIL}`, `${ADMIN}/github-apps`],
    'RepoNewScreen (device flow on mount)': [`${ADMIN}/github/connect/start`],
  };
  for (const [screen, paths] of Object.entries(screens)) {
    const bad = [];
    for (const p of paths) {
      const r = await isMounted(p, p.endsWith('/start') ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : {});
      if (!r.mounted) bad.push(`${p}→${r.why}`);
    }
    if (bad.length === 0) pass('§2.7', `UI screen reachable: ${screen}`, `${paths.length} mount-time API(s) answered from the plugin`);
    else fail('§2.7', `UI screen reachable: ${screen}`, bad.join(', '));
  }
}

async function probeChatTools() {
  // No core endpoint lists registered native tools, so the registry cannot be
  // read over HTTP. Reported BLOCKED rather than inferred from a log line.
  blocked('§2.6', '3 chat tools registered (dev_job_start/status/list)', 'core exposes no tool-registry endpoint — verify in activation logs');
}

async function probeUninstallCycle() {
  const before = await db(`SELECT count(*)::int AS n FROM dev_repos`).catch(() => undefined);

  await http(`/api/v1/install/installed/${PID}`, { method: 'DELETE' });
  expectStatus('§3.11', 'routers stop answering after uninstall', await status(`${ADMIN}/jobs`), [404]);

  const navAfter = JSON.stringify((await json('/api/v1/ui/navigation?locale=en')).body);
  if (!navAfter.includes('devPlatform')) pass('§3.12', 'nav entry disappears', 'no devPlatform entry');
  else fail('§3.12', 'nav entry disappears', 'entry still present');

  const runnerAfter = await status(`${RUNNER}/llm/`);
  if (runnerAfter !== 200) pass('§3.14', 'public path no longer exempt', `HTTP ${runnerAfter} (was 200 while installed)`);
  else fail('§3.14', 'public path no longer exempt', 'still 200 — grant not revoked at runtime');

  // D3 — the data lifecycle decision: tables and rows REMAIN.
  const after = await db(
    `SELECT (SELECT count(*) FROM information_schema.tables
              WHERE table_schema='public' AND table_name LIKE 'dev\\_%')::int AS tables,
            (SELECT count(*) FROM dev_repos)::int AS repos,
            (SELECT count(*) FROM ${LEDGER})::int AS ledger`,
  ).catch(() => undefined);
  if (after) {
    const a = after[0];
    if (a.tables === 9 && a.ledger === 9) pass('D3', 'uninstall KEEPS the 9 tables + ledger', `tables=${a.tables} ledger=${a.ledger} dev_repos=${a.repos}`);
    else fail('D3', 'uninstall KEEPS the 9 tables + ledger', `tables=${a.tables} ledger=${a.ledger}`);
    if (before && a.repos === before[0].n) pass('D3', 'row data survives uninstall', `dev_repos ${before[0].n} → ${a.repos}`);
  } else blocked('D3', 'uninstall KEEPS the 9 tables + ledger', 'no DATABASE_URL');

  // C16 B6 settled the lifecycle acceptance.md §3.15 left open: uninstall
  // purges BOTH grant tables, so a reinstall under the same id starts
  // un-granted instead of inheriting the previous package's database access and
  // unauthenticated surface. On a pre-C16 core the rows stay — orphaned rather
  // than live, since the runtime stops honouring them — so the verdict is a
  // BLOCKED there and a real FAIL on a core that promised to clear them.
  const orphanSql = await db(`SELECT count(*)::int AS n FROM plugin_sql_grants WHERE plugin_id=$1`, [PLUGIN_ID]).catch(() => undefined);
  const orphanPub = await db(`SELECT count(*)::int AS n FROM plugin_public_path_grants WHERE plugin_id=$1`, [PLUGIN_ID]).catch(() => undefined);
  if (orphanSql && orphanPub) {
    const cleared = orphanSql[0].n === 0 && orphanPub[0].n === 0;
    const counts = `plugin_sql_grants=${orphanSql[0].n} plugin_public_path_grants=${orphanPub[0].n}`;
    if (cleared) {
      pass('§3.15', 'uninstall purges the grant rows (C16 B6)', `${counts} — a reinstall asks again`);
    } else if (hasUnifiedGrants) {
      fail('§3.15', 'uninstall purges the grant rows (C16 B6)', `${counts} — this core ships C16 and should have cleared both`);
    } else {
      blocked('§3.15', 'uninstall purges the grant rows (C16 B6)', `${counts} — pre-C16 core keeps them; orphaned, not honoured`);
    }
  }

  // reinstall, lossless — and, on a C16 core, un-granted, so the grants have to
  // be given again exactly as they were the first time.
  if (hasUnifiedGrants !== true) await grantSqlLegacy();
  const jobId = await install({ sqlGrantedBeforeActivation: hasUnifiedGrants !== true });
  if (jobId) {
    await grantAll();
    const led = await db(`SELECT count(*)::int AS n FROM ${LEDGER}`).catch(() => undefined);
    const repos = await db(`SELECT count(*)::int AS n FROM dev_repos`).catch(() => undefined);
    if (led && repos) {
      if (led[0].n === 9 && (!before || repos[0].n === before[0].n)) {
        pass('§3.16', 'reinstall is lossless', `ledger=9 (0 re-applied), dev_repos=${repos[0].n}`);
      } else fail('§3.16', 'reinstall is lossless', `ledger=${led[0].n} dev_repos=${repos[0].n}`);
    } else blocked('§3.16', 'reinstall is lossless', 'no DATABASE_URL');
    expectStatus('§3.16', 'routes answer again after reinstall', await status(`${ADMIN}/jobs`), [200]);
  }
}

async function probePurge() {
  // The plugin's own purge route, with the type-to-confirm guard.
  const noConfirm = await postJson(`${ADMIN}/admin/purge`, {});
  if ([400, 409, 422].includes(noConfirm.status)) pass('§3.15', 'purge REFUSES without type-to-confirm', `HTTP ${noConfirm.status}`);
  else fail('§3.15', 'purge REFUSES without type-to-confirm', `HTTP ${noConfirm.status} — an unguarded destructive route`);

  const wrong = await postJson(`${ADMIN}/admin/purge`, { confirm: 'yes' });
  if ([400, 409, 422].includes(wrong.status)) pass('§3.15', 'purge REFUSES a wrong confirmation', `HTTP ${wrong.status}`);
  else fail('§3.15', 'purge REFUSES a wrong confirmation', `HTTP ${wrong.status}`);
}

// --- main ------------------------------------------------------------------

async function main() {
  console.log(`# acceptance-local — ${PLUGIN_ID} against ${BASE}\n`);
  await login();
  pass('setup', 'admin session', `logged in as ${EMAIL}`);

  if (PHASE === 'install') {
    // Probe BEFORE the clean slate, while a previous run's install is still
    // there to probe against. The answer decides ORDERING: on a pre-C16 core
    // the SQL grant must exist before activation, because there is no route to
    // re-activate the plugin afterwards.
    await probeUnifiedGrants();
    if (hasUnifiedGrants) record('setup', 'grant surface', 'PASS', 'core ships the C16 unified route — granting the way the wizard does, after install');

    await cleanSlate();
    const zip = resolveZip();
    const up = await upload(zip);
    if (up.status === 201) pass('§3.6', 'ZIP uploaded', `${basename(zip)} ${up.body?.package?.zip_bytes} bytes sha=${String(up.body?.package?.sha256).slice(0, 12)}`);
    else fail('§3.6', 'ZIP uploaded', `HTTP ${up.status} ${JSON.stringify(up.body).slice(0, 200)}`);
    if (hasUnifiedGrants !== true) await grantSqlLegacy();
    await install({ sqlGrantedBeforeActivation: hasUnifiedGrants !== true });
    await grantAll();
  }

  await verifyInstalled();
  await probeEndpoints();
  await probeUiScreens();
  await probeChatTools();
  await probePurge();
  if (PHASE === 'install') await probeUninstallCycle();

  // --- report ---
  const width = Math.max(...rows.map((r) => r.name.length), 20);
  let cur = '';
  console.log('');
  for (const r of rows) {
    if (r.section !== cur) {
      cur = r.section;
      console.log(`\n## ${cur}`);
    }
    const mark = r.verdict === 'PASS' ? 'PASS   ' : r.verdict === 'FAIL' ? 'FAIL   ' : 'BLOCKED';
    console.log(`  ${mark} ${r.name.padEnd(width)}  ${r.evidence}`);
  }
  const n = (v) => rows.filter((r) => r.verdict === v).length;
  console.log(`\n=== ${n('PASS')} PASS / ${n('FAIL')} FAIL / ${n('BLOCKED')} BLOCKED (${rows.length} rows) ===`);
  await pool?.end();
  process.exit(Math.min(n('FAIL'), 250));
}

main().catch(async (err) => {
  console.error(`\nacceptance-local aborted: ${err.message}`);
  await pool?.end();
  process.exit(255);
});
