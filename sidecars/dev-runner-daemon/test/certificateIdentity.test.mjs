/**
 * Epic #470 P4 / decision D5 — the cosign certificate-identity TRANSITION.
 *
 * Keyless cosign binds a signature's certificate identity to repo + workflow +
 * ref. The dev-platform runner image used to be signed by
 * `byte5ai/omadia/.github/workflows/publish-images.yml`; from this repo it is
 * signed by `byte5ai/omadia-dev-platform/.github/workflows/release-runner-image.yml`.
 * `verifyRunnerImage` did an EXACT `--certificate-identity` match, so the first
 * image published from the new repo would have been refused by every deployed
 * daemon that had pinned the old one — and a daemon that refuses its runner
 * image refuses every job.
 *
 * This suite pins the fix and, just as importantly, its BOUNDS. A transition
 * regexp that accepts both signers is only safe while it accepts *nothing else*:
 * the whole value of a pinned identity is that a signature from some other repo
 * is not a signature at all. So the cases below are as much about what must
 * still be rejected as about what must now pass.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  CORE_SIGNER_IDENTITY,
  DEFAULT_TRANSITION_IDENTITY_REGEXP,
  PLUGIN_SIGNER_IDENTITY,
  resolveCertificateIdentity,
  verifyRunnerImage,
} from '../src/imageVerify.mjs';

const IMAGE = 'ghcr.io/byte5ai/omadia-dev-runner@sha256:' + '1'.repeat(64);
const ISSUER = 'https://token.actions.githubusercontent.com';

/** A cosign exec fake: records argv, returns `code`. */
function fakeExec(code = 0) {
  const calls = [];
  return {
    calls,
    exec: async (args) => {
      calls.push([...args]);
      return { code, stdout: '', stderr: '' };
    },
  };
}

function fakeLogger() {
  const warns = [];
  const infos = [];
  return { warns, infos, warn: (m) => warns.push(m), info: (m) => infos.push(m) };
}

// ---------------------------------------------------------------------------
// The regexp itself.
// ---------------------------------------------------------------------------

describe('DEFAULT_TRANSITION_IDENTITY_REGEXP — what it accepts', () => {
  const re = new RegExp(DEFAULT_TRANSITION_IDENTITY_REGEXP);

  it('is anchored at both ends', () => {
    // cosign compiles this with Go's RE2 and matches it UNANCHORED. Without the
    // anchors, `https://evil.example/?x=<the whole valid identity>#` matches,
    // and the pin is decoration.
    assert.ok(DEFAULT_TRANSITION_IDENTITY_REGEXP.startsWith('^'));
    assert.ok(DEFAULT_TRANSITION_IDENTITY_REGEXP.endsWith('$'));
  });

  it('accepts the OLD core signer at a release tag', () => {
    assert.match(`${CORE_SIGNER_IDENTITY}@refs/tags/v1.2.3`, re);
  });

  it('accepts the NEW dev-platform signer at a release tag', () => {
    assert.match(`${PLUGIN_SIGNER_IDENTITY}@refs/tags/v0.3.0`, re);
  });

  it('accepts both signers on a branch ref too', () => {
    // `release-runner-image.yml` also runs on workflow_dispatch from a branch,
    // which mints `@refs/heads/<branch>`. Refusing that would make every
    // manually-published image unverifiable.
    assert.match(`${CORE_SIGNER_IDENTITY}@refs/heads/main`, re);
    assert.match(`${PLUGIN_SIGNER_IDENTITY}@refs/heads/main`, re);
  });

  for (const foreign of [
    // A different org entirely.
    'https://github.com/evil/omadia/.github/workflows/publish-images.yml@refs/tags/v1.0.0',
    // Same org, a repo nobody granted signing rights to. This is the one that
    // matters: anyone in the org can add a workflow to a NEW repo.
    'https://github.com/byte5ai/omadia-homepage/.github/workflows/release-runner-image.yml@refs/tags/v1.0.0',
    // Right repo, WRONG workflow — a workflow a PR could add.
    'https://github.com/byte5ai/omadia-dev-platform/.github/workflows/evil.yml@refs/tags/v1.0.0',
    // Prefix smuggling against an unanchored matcher. (There is no meaningful
    // SUFFIX case: everything after `@refs/tags/` is a git ref inside the
    // correct repo, and only someone who can already push a tag there can
    // influence it. `.` stays in the ref charset because `v1.2.3` needs it.)
    `https://evil.example/${CORE_SIGNER_IDENTITY}@refs/tags/v1.0.0`,
    `${PLUGIN_SIGNER_IDENTITY}@refs/tags/v1.0.0#@evil.example`,
    // A repo whose NAME merely starts with the granted one.
    'https://github.com/byte5ai/omadia-dev-platform-evil/.github/workflows/release-runner-image.yml@refs/tags/v1.0.0',
    // No ref at all.
    PLUGIN_SIGNER_IDENTITY,
    // An email-shaped identity (the other thing Fulcio puts in a SAN).
    'attacker@example.com',
  ]) {
    it(`rejects a foreign identity: ${foreign.slice(0, 72)}`, () => {
      assert.doesNotMatch(foreign, re);
    });
  }
});

// ---------------------------------------------------------------------------
// Resolution: which cosign flag, with which value.
// ---------------------------------------------------------------------------

describe('resolveCertificateIdentity — flag selection', () => {
  it('with NOTHING configured, resolves to nothing — the skip is preserved', () => {
    // DELIBERATE. It is tempting to make the transition regexp the default and
    // have a bare daemon verify out of the box. That would turn a documented
    // SKIP into a hard boot REFUSAL for everyone running a locally-built runner
    // image, which is a blast radius P4 was not asked to take and which arrives
    // as "the daemon stopped starting" with no config change to point at.
    //
    // The default lives in `docker-compose.dev-platform.yaml` instead, where
    // the rest of this deployment's infrastructure config already lives and
    // where an operator can see it. See docs/SUPPLY_CHAIN.md.
    assert.equal(resolveCertificateIdentity({}), null);
  });

  it('an explicit regexp wins over everything', () => {
    const out = resolveCertificateIdentity({ identityRegexp: '^https://example\\.test/x$' });
    assert.equal(out.flag, '--certificate-identity-regexp');
    assert.equal(out.value, '^https://example\\.test/x$');
    assert.equal(out.source, 'operator-regexp');
  });

  it('an explicit regexp wins even when an exact identity is also set', () => {
    const out = resolveCertificateIdentity({
      identity: `${CORE_SIGNER_IDENTITY}@refs/tags/v1.2.3`,
      identityRegexp: '^https://example\\.test/x$',
    });
    assert.equal(out.value, '^https://example\\.test/x$');
    assert.equal(out.source, 'operator-regexp');
  });

  it('WIDENS a pinned identity that is one of the two transition signers', () => {
    // THE FIX. A daemon deployed before this release has core's identity pinned
    // in its config; the next image it is asked to run is signed by this repo.
    // Widening to the transition regexp is what keeps that daemon running jobs.
    const out = resolveCertificateIdentity({ identity: `${CORE_SIGNER_IDENTITY}@refs/tags/v1.2.3` });
    assert.equal(out.flag, '--certificate-identity-regexp');
    assert.equal(out.value, DEFAULT_TRANSITION_IDENTITY_REGEXP);
    assert.equal(out.source, 'widened');
  });

  it('widens the NEW signer as well, so the window is symmetric', () => {
    // An operator who already pinned the new identity must still accept an
    // older, core-signed image they have not upgraded past.
    const out = resolveCertificateIdentity({ identity: `${PLUGIN_SIGNER_IDENTITY}@refs/heads/main` });
    assert.equal(out.value, DEFAULT_TRANSITION_IDENTITY_REGEXP);
    assert.equal(out.source, 'widened');
  });

  it('NEVER widens an identity outside the transition set', () => {
    // An operator who signs their own fork gets exactly what they asked for.
    // Widening it would silently hand byte5ai's signers authority over a
    // deployment that deliberately did not grant it.
    const own = 'https://github.com/acme/omadia-fork/.github/workflows/sign.yml@refs/tags/v9';
    const out = resolveCertificateIdentity({ identity: own });
    assert.equal(out.flag, '--certificate-identity');
    assert.equal(out.value, own);
    assert.equal(out.source, 'operator-exact');
  });

  it('refuses a regexp that does not compile rather than passing it to cosign', () => {
    // cosign would reject it too — with a message about Go regexp syntax, at the
    // moment of the first verify, which is boot. Failing here names the env var.
    assert.throws(
      () => resolveCertificateIdentity({ identityRegexp: '^(unclosed' }),
      /DEV_IMAGE_COSIGN_IDENTITY_REGEXP/,
    );
  });

  it('refuses an unanchored operator regexp', () => {
    // The single most likely way to write a regexp that looks right and pins
    // nothing. Refuse it at boot with the reason, not at 3am with a bad image.
    assert.throws(
      () => resolveCertificateIdentity({ identityRegexp: 'byte5ai/omadia' }),
      /anchored/i,
    );
  });

  it('treats blank strings as unset', () => {
    assert.equal(resolveCertificateIdentity({ identity: '   ', identityRegexp: '' }), null);
  });
});

// ---------------------------------------------------------------------------
// End to end through verifyRunnerImage: the argv cosign actually receives.
// ---------------------------------------------------------------------------

describe('verifyRunnerImage — regexp argv', () => {
  it('passes --certificate-identity-regexp when a regexp is configured', async () => {
    const { exec, calls } = fakeExec(0);
    const out = await verifyRunnerImage({
      image: IMAGE,
      identityRegexp: DEFAULT_TRANSITION_IDENTITY_REGEXP,
      issuer: ISSUER,
      mode: 'on',
      exec,
    });
    assert.deepEqual(out, { verified: true, skipped: false });
    assert.deepEqual(calls[0], [
      'verify',
      '--certificate-identity-regexp',
      DEFAULT_TRANSITION_IDENTITY_REGEXP,
      '--certificate-oidc-issuer',
      ISSUER,
      IMAGE,
    ]);
  });

  it('a widened pin and an explicit regexp produce the SAME argv', async () => {
    // The widening is not a different verification mode — it is the same cosign
    // invocation an operator would write by hand. Anything else would mean the
    // transition window behaves unlike its own documented end state.
    const a = fakeExec(0);
    await verifyRunnerImage({
      image: IMAGE,
      identity: `${CORE_SIGNER_IDENTITY}@refs/tags/v1.2.3`,
      issuer: ISSUER,
      mode: 'on',
      exec: a.exec,
      logger: fakeLogger(),
    });
    const b = fakeExec(0);
    await verifyRunnerImage({
      image: IMAGE,
      identityRegexp: DEFAULT_TRANSITION_IDENTITY_REGEXP,
      issuer: ISSUER,
      mode: 'on',
      exec: b.exec,
    });
    assert.deepEqual(a.calls[0], b.calls[0]);
  });

  it('still passes exact --certificate-identity for an out-of-set pin', async () => {
    // The pre-existing argv shape is unchanged for anyone not in the transition.
    const own = 'https://github.com/acme/omadia-fork/.github/workflows/sign.yml@refs/tags/v9';
    const { exec, calls } = fakeExec(0);
    await verifyRunnerImage({ image: IMAGE, identity: own, issuer: ISSUER, mode: 'on', exec });
    assert.deepEqual(calls[0], [
      'verify',
      '--certificate-identity',
      own,
      '--certificate-oidc-issuer',
      ISSUER,
      IMAGE,
    ]);
  });

  it('tells the operator, once, that its pin was widened', async () => {
    const { exec } = fakeExec(0);
    const logger = fakeLogger();
    await verifyRunnerImage({
      image: IMAGE,
      identity: `${CORE_SIGNER_IDENTITY}@refs/tags/v1.2.3`,
      issuer: ISSUER,
      mode: 'on',
      exec,
      logger,
    });
    // Silent widening is the failure mode this whole file exists to avoid
    // becoming permanent: the narrowing step needs someone to know it is due.
    assert.equal(logger.warns.length, 1);
    assert.match(logger.warns[0], /widen/i);
    assert.match(logger.warns[0], /DEV_IMAGE_COSIGN_IDENTITY_REGEXP/);
  });

  it('a cosign failure under the regexp still REFUSES the image', async () => {
    // Widening changes which signers are acceptable. It must not change what
    // happens when none of them signed the thing.
    const { exec } = fakeExec(1);
    await assert.rejects(
      verifyRunnerImage({
        image: IMAGE,
        identityRegexp: DEFAULT_TRANSITION_IDENTITY_REGEXP,
        issuer: ISSUER,
        mode: 'on',
        exec,
      }),
      /refusing to run an unverified runner image/,
    );
  });

  it('mode=off still short-circuits before any identity resolution', async () => {
    const { exec, calls } = fakeExec(0);
    const out = await verifyRunnerImage({
      image: IMAGE,
      identityRegexp: DEFAULT_TRANSITION_IDENTITY_REGEXP,
      issuer: ISSUER,
      mode: 'off',
      exec,
    });
    assert.deepEqual(out, { verified: false, skipped: true, reason: 'disabled' });
    assert.equal(calls.length, 0);
  });

  it('a regexp without an ISSUER is still a skip', async () => {
    // The issuer is the other half of a keyless pin. Accepting a regexp alone
    // would mean taking a Fulcio cert from any OIDC provider willing to mint
    // that subject, which is not a pin at all.
    const { exec, calls } = fakeExec(0);
    const logger = fakeLogger();
    const out = await verifyRunnerImage({
      image: IMAGE,
      identityRegexp: DEFAULT_TRANSITION_IDENTITY_REGEXP,
      issuer: undefined,
      mode: 'on',
      exec,
      logger,
    });
    assert.deepEqual(out, { verified: false, skipped: true, reason: 'no-identity' });
    assert.equal(calls.length, 0);
    assert.equal(logger.warns.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Publisher ↔ consumer. The two ends of one contract, in two repositories'
// worth of file formats, with nothing but agreement holding them together.
// ---------------------------------------------------------------------------

describe('the release workflow and the daemon agree', () => {
  const workflowPath = resolve(process.cwd(), '..', '..', '.github', 'workflows', 'release-runner-image.yml');
  const workflow = readFileSync(workflowPath, 'utf8');

  it('the workflow verifies with the EXACT regexp the daemon enforces', () => {
    // The workflow re-verifies its own freshly-signed image before it finishes.
    // That check is only worth something if it uses the pattern the daemon will
    // use — a signature the consumer would reject is not a signature, and CI is
    // the only place that can be discovered before an operator's daemon refuses
    // to boot on it. The regexp cannot be imported into YAML, so it is pinned.
    assert.ok(
      workflow.includes(DEFAULT_TRANSITION_IDENTITY_REGEXP),
      'release-runner-image.yml does not contain DEFAULT_TRANSITION_IDENTITY_REGEXP verbatim — ' +
        'the publisher and the consumer have drifted',
    );
  });

  it('the identity the workflow will actually be signed with matches', () => {
    // `PLUGIN_SIGNER_IDENTITY` is a hand-written URL that has to equal
    // `https://github.com/<owner>/<repo>/.github/workflows/<file>`. Rename the
    // workflow file and every future image becomes unverifiable, with nothing
    // in the build to say so — the failure would first appear as a daemon
    // refusing to start, days later, on someone else's deployment.
    const expected =
      'https://github.com/byte5ai/omadia-dev-platform/.github/workflows/release-runner-image.yml';
    assert.equal(PLUGIN_SIGNER_IDENTITY, expected);
    assert.ok(existsSync(workflowPath), `${expected} names a workflow file that does not exist`);
    assert.match(workflow, /^name:\s*release-runner-image\s*$/m);
  });

  it('the workflow grants the two permissions keyless signing needs', () => {
    // `id-token: write` mints the Fulcio certificate; `packages: write` pushes.
    // Losing either turns the publish into a late, confusing failure.
    assert.match(workflow, /^\s{2}packages:\s*write\s*$/m);
    assert.match(workflow, /^\s{2}id-token:\s*write\s*$/m);
  });

  it('signs a DIGEST, never a floating tag', () => {
    // A signature over `:latest` says nothing about what `:latest` points at
    // tomorrow, and the daemon pins by digest precisely so it does not have to
    // trust one.
    assert.match(workflow, /cosign sign --yes "\$IMAGE_DIGEST"/);
    assert.match(workflow, /IMAGE_DIGEST:\s*\$\{\{\s*env\.IMAGE\s*\}\}@\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}/);
  });
});
