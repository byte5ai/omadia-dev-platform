/**
 * Epic #470 P4 / decision D5 — the cosign certificate identity, NARROWED (0.3.4).
 *
 * Keyless cosign binds a signature's certificate identity to repo + workflow +
 * ref. The dev-platform runner image used to be signed by
 * `byte5ai/omadia/.github/workflows/publish-images.yml`; from this repo it is
 * signed by `byte5ai/omadia-dev-platform/.github/workflows/release-runner-image.yml`.
 * 0.3.2 shipped a TRANSITION pattern accepting both, so that the first image
 * published here would not be refused by every daemon pinned to the old signer.
 *
 * 0.3.2 was that first publish. Per the schedule in docs/SUPPLY_CHAIN.md — narrow
 * one release after — the core alternative and the automatic widening of a core
 * pin are gone. This suite is now the COUNTER-PROOF: the cases that used to
 * assert the old signer is accepted assert that it is rejected, and the widening
 * cases assert that nothing is widened.
 *
 * The bounds matter as much as the acceptance. A pinned identity is only worth
 * something while a signature from anywhere else is not a signature at all — and
 * "anywhere else" now includes the publisher this project used a release ago.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_IDENTITY_REGEXP,
  PLUGIN_SIGNER_IDENTITY,
  resolveCertificateIdentity,
  verifyRunnerImage,
} from '../src/imageVerify.mjs';

const IMAGE = 'ghcr.io/byte5ai/omadia-dev-platform-runner@sha256:' + '1'.repeat(64);
const ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * The signer this project used until 0.3.2, kept as a LOCAL literal.
 *
 * It is deliberately not imported: `CORE_SIGNER_IDENTITY` no longer exists in
 * `imageVerify.mjs`, and re-exporting it just to test against it would leave the
 * old identity present in shipped code — one edit away from being wired back
 * into the pattern. Here it is test data, which is what it is now.
 */
const RETIRED_CORE_SIGNER =
  'https://github.com/byte5ai/omadia/.github/workflows/publish-images.yml';

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

describe('DEFAULT_IDENTITY_REGEXP — what it accepts', () => {
  const re = new RegExp(DEFAULT_IDENTITY_REGEXP);

  it('is anchored at both ends', () => {
    // cosign compiles this with Go's RE2 and matches it UNANCHORED. Without the
    // anchors, `https://evil.example/?x=<the whole valid identity>#` matches,
    // and the pin is decoration.
    assert.ok(DEFAULT_IDENTITY_REGEXP.startsWith('^'));
    assert.ok(DEFAULT_IDENTITY_REGEXP.endsWith('$'));
  });

  it('accepts the dev-platform signer at a release tag', () => {
    assert.match(`${PLUGIN_SIGNER_IDENTITY}@refs/tags/v0.3.4`, re);
    assert.match(`${PLUGIN_SIGNER_IDENTITY}@refs/tags/v1.10.0`, re);
  });

  it('accepts the dev-platform signer on refs/heads/main', () => {
    // The workflow publishes on every runner-relevant push to main, and those
    // images are what an operator running `:main` actually pulls. Refusing this
    // ref would make the automatic build unverifiable — the exact failure the
    // workflow's own `verify` job exists to catch before a daemon does.
    assert.match(`${PLUGIN_SIGNER_IDENTITY}@refs/heads/main`, re);
  });

  it('REJECTS the retired core signer — the counter-proof for the narrowing', () => {
    // This is the assertion that changed direction in 0.3.4. Until this release
    // both of these matched. An image still signed only by core is now refused,
    // which is the whole point of narrowing: the transition window is a window,
    // not a permanent second door.
    assert.doesNotMatch(`${RETIRED_CORE_SIGNER}@refs/tags/v1.2.3`, re);
    assert.doesNotMatch(`${RETIRED_CORE_SIGNER}@refs/heads/main`, re);
  });

  for (const foreign of [
    // The retired publisher, spelled every way it ever appeared.
    `${RETIRED_CORE_SIGNER}@refs/tags/v0.3.1`,
    `${RETIRED_CORE_SIGNER}@refs/heads/main`,
    // A different org entirely.
    'https://github.com/evil/omadia/.github/workflows/publish-images.yml@refs/tags/v1.0.0',
    // Same org, a repo nobody granted signing rights to. This is the one that
    // matters: anyone in the org can add a workflow to a NEW repo.
    'https://github.com/byte5ai/omadia-homepage/.github/workflows/release-runner-image.yml@refs/tags/v1.0.0',
    // Right repo, WRONG workflow — a workflow a PR could add.
    'https://github.com/byte5ai/omadia-dev-platform/.github/workflows/evil.yml@refs/tags/v1.0.0',
    // Right repo, right workflow, WRONG BRANCH. New in 0.3.4: the ref arm used
    // to be `heads/<anything>`, which meant a `workflow_dispatch` from any
    // branch — including one any contributor can push — minted an identity the
    // daemon accepted. Publishing now happens from `main` or a version tag.
    `${PLUGIN_SIGNER_IDENTITY}@refs/heads/feature/evil`,
    `${PLUGIN_SIGNER_IDENTITY}@refs/heads/mainly`,
    // Right repo, right workflow, a tag outside the version shape.
    `${PLUGIN_SIGNER_IDENTITY}@refs/tags/latest`,
    `${PLUGIN_SIGNER_IDENTITY}@refs/tags/v1.2`,
    `${PLUGIN_SIGNER_IDENTITY}@refs/tags/edge`,
    // Prefix smuggling against an unanchored matcher.
    `https://evil.example/${PLUGIN_SIGNER_IDENTITY}@refs/tags/v1.0.0`,
    `${PLUGIN_SIGNER_IDENTITY}@refs/tags/v1.0.0#@evil.example`,
    // A repo whose NAME merely starts with the granted one.
    'https://github.com/byte5ai/omadia-dev-platform-evil/.github/workflows/release-runner-image.yml@refs/tags/v1.0.0',
    // No ref at all.
    PLUGIN_SIGNER_IDENTITY,
    // An email-shaped identity (the other thing Fulcio puts in a SAN).
    'attacker@example.com',
  ]) {
    it(`rejects: ${foreign.slice(0, 78)}`, () => {
      assert.doesNotMatch(foreign, re);
    });
  }

  it('names exactly one repo+workflow — no alternation left to hide in', () => {
    // Mutation guard on the narrowing itself. A future edit that re-adds an
    // alternative signer (or reaches for "anything under byte5ai") would keep
    // every acceptance case above green.
    assert.equal(DEFAULT_IDENTITY_REGEXP.includes('byte5ai/omadia/'), false);
    assert.equal(DEFAULT_IDENTITY_REGEXP.includes('publish-images'), false);
    const signerOccurrences = DEFAULT_IDENTITY_REGEXP.split('github\\.com').length - 1;
    assert.equal(signerOccurrences, 1, 'the pattern names more than one host+repo');
  });
});

// ---------------------------------------------------------------------------
// Resolution: which cosign flag, with which value.
// ---------------------------------------------------------------------------

describe('resolveCertificateIdentity — flag selection', () => {
  it('with NOTHING configured, resolves to nothing — the skip is preserved', () => {
    // DELIBERATE. It is tempting to make DEFAULT_IDENTITY_REGEXP the default and
    // have a bare daemon verify out of the box. That would turn a documented
    // SKIP into a hard boot REFUSAL for everyone running a locally-built runner
    // image, and it arrives as "the daemon stopped starting" with no config
    // change to point at.
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
      identity: `${PLUGIN_SIGNER_IDENTITY}@refs/tags/v1.2.3`,
      identityRegexp: '^https://example\\.test/x$',
    });
    assert.equal(out.value, '^https://example\\.test/x$');
    assert.equal(out.source, 'operator-regexp');
  });

  it('does NOT widen a stale core pin any more — it is passed through exactly', () => {
    // The narrowing, at the resolution layer. Until 0.3.4 this returned the
    // transition regexp with `source: 'widened'`. An operator who never updated
    // their config now gets exactly what they configured: a pin on a publisher
    // that no longer signs anything, which fails against a newly published image
    // with a message naming the image. That is the intended end state — a silent
    // grant of authority nobody re-confirmed would be worse.
    const pin = `${RETIRED_CORE_SIGNER}@refs/tags/v1.2.3`;
    const out = resolveCertificateIdentity({ identity: pin });
    assert.equal(out.flag, '--certificate-identity');
    assert.equal(out.value, pin);
    assert.equal(out.source, 'operator-exact');
  });

  it('does not widen the NEW signer either — no pin is rewritten', () => {
    // Symmetry check. `widened` is gone as a concept, not merely as a branch for
    // one of the two signers.
    const pin = `${PLUGIN_SIGNER_IDENTITY}@refs/heads/main`;
    const out = resolveCertificateIdentity({ identity: pin });
    assert.equal(out.flag, '--certificate-identity');
    assert.equal(out.value, pin);
    assert.equal(out.source, 'operator-exact');
  });

  it('passes an out-of-set pin through unchanged, as it always did', () => {
    // An operator who signs their own fork gets exactly what they asked for.
    const own = 'https://github.com/acme/omadia-fork/.github/workflows/sign.yml@refs/tags/v9';
    const out = resolveCertificateIdentity({ identity: own });
    assert.equal(out.flag, '--certificate-identity');
    assert.equal(out.value, own);
    assert.equal(out.source, 'operator-exact');
  });

  it('never reports a `widened` source for any input', () => {
    // The mutation guard for the removal. Reinstating the branch would make the
    // three cases above fail individually; this one states the invariant.
    for (const identity of [
      `${RETIRED_CORE_SIGNER}@refs/tags/v1.2.3`,
      `${PLUGIN_SIGNER_IDENTITY}@refs/heads/main`,
      'https://github.com/acme/f/.github/workflows/s.yml@refs/tags/v1',
    ]) {
      assert.notEqual(resolveCertificateIdentity({ identity }).source, 'widened');
    }
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

  it('accepts DEFAULT_IDENTITY_REGEXP as an operator regexp', () => {
    // The shipped default has to survive the validation the daemon applies to
    // operator input — it is the value `docker-compose.dev-platform.yaml` sets.
    const out = resolveCertificateIdentity({ identityRegexp: DEFAULT_IDENTITY_REGEXP });
    assert.equal(out.value, DEFAULT_IDENTITY_REGEXP);
    assert.equal(out.source, 'operator-regexp');
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
      identityRegexp: DEFAULT_IDENTITY_REGEXP,
      issuer: ISSUER,
      mode: 'on',
      exec,
    });
    assert.deepEqual(out, { verified: true, skipped: false });
    assert.deepEqual(calls[0], [
      'verify',
      '--certificate-identity-regexp',
      DEFAULT_IDENTITY_REGEXP,
      '--certificate-oidc-issuer',
      ISSUER,
      IMAGE,
    ]);
  });

  it('a stale core pin reaches cosign as an EXACT identity, unrewritten', async () => {
    // What the removed widening used to do was rewrite this argv. It does not
    // any more, and the difference is visible where it matters: in the arguments
    // cosign receives.
    const pin = `${RETIRED_CORE_SIGNER}@refs/tags/v1.2.3`;
    const { exec, calls } = fakeExec(0);
    await verifyRunnerImage({ image: IMAGE, identity: pin, issuer: ISSUER, mode: 'on', exec });
    assert.deepEqual(calls[0], [
      'verify',
      '--certificate-identity',
      pin,
      '--certificate-oidc-issuer',
      ISSUER,
      IMAGE,
    ]);
  });

  it('says nothing about widening, for any pin', async () => {
    // The warning was the transition's own alarm clock. With the transition over
    // it must be gone, not merely unreachable — a warning about a behaviour that
    // no longer happens teaches an operator the wrong model of their daemon.
    for (const identity of [
      `${RETIRED_CORE_SIGNER}@refs/tags/v1.2.3`,
      `${PLUGIN_SIGNER_IDENTITY}@refs/heads/main`,
    ]) {
      const { exec } = fakeExec(0);
      const logger = fakeLogger();
      await verifyRunnerImage({ image: IMAGE, identity, issuer: ISSUER, mode: 'on', exec, logger });
      assert.deepEqual(logger.warns, [], `a pin on ${identity} still warned`);
    }
  });

  it('still passes exact --certificate-identity for an out-of-set pin', async () => {
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

  it('a cosign failure under the regexp still REFUSES the image', async () => {
    // Narrowing changes which signers are acceptable. It must not change what
    // happens when none of them signed the thing.
    const { exec } = fakeExec(1);
    await assert.rejects(
      verifyRunnerImage({
        image: IMAGE,
        identityRegexp: DEFAULT_IDENTITY_REGEXP,
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
      identityRegexp: DEFAULT_IDENTITY_REGEXP,
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
      identityRegexp: DEFAULT_IDENTITY_REGEXP,
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
      workflow.includes(DEFAULT_IDENTITY_REGEXP),
      'release-runner-image.yml does not contain DEFAULT_IDENTITY_REGEXP verbatim — ' +
        'the publisher and the consumer have drifted',
    );
  });

  it('the workflow no longer accepts the retired signer as an IDENTITY', () => {
    // Narrowing one end and not the other produces a `verify` job that passes on
    // an image the daemon would refuse — CI green, deployment dead.
    //
    // Scoped to the identity URL, not to the substring `publish-images`: the
    // workflow legitimately mentions core's publish workflow elsewhere, as the
    // precedent for its DOCKER TAG shapes. That is a naming convention, not a
    // trust decision, and a test that conflated the two would be reworded away
    // the first time it fired for the wrong reason.
    assert.equal(
      workflow.includes(RETIRED_CORE_SIGNER),
      false,
      'the workflow still names core’s signer identity',
    );
    assert.equal(
      workflow.includes(RETIRED_CORE_SIGNER.replace(/\./g, '\\.')),
      false,
      'the workflow still carries core’s signer identity in escaped (regexp) form',
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

  it('publishes a package THIS repository owns by construction', () => {
    // The predecessor name, `ghcr.io/byte5ai/omadia-dev-runner`, was a package
    // created by — and therefore owned by — `byte5ai/omadia`. GitHub scopes a
    // container package to its creating repository, so `packages: write` here
    // was necessary and not sufficient: the push also needed a grant on that
    // package that nobody ever made, and the image was never built once.
    //
    // A package named after THIS repository is created by this repository's
    // first push, with write access already held. That is what makes the build
    // automatic. Reverting the name would not fail loudly — it would 403 at the
    // push step, on a workflow nobody watches, forever.
    const image = /^\s*IMAGE:\s*(\S+)\s*$/m.exec(workflow)?.[1];
    assert.ok(image, 'the workflow declares no IMAGE');
    assert.equal(image, 'ghcr.io/byte5ai/omadia-dev-platform-runner');
  });

  it('signs only from refs the default regexp accepts', () => {
    // The workflow publishes automatically on a `v*` tag and on every
    // runner-relevant push to `main`. Each produces a DIFFERENT certificate
    // identity, and every one has to satisfy the pattern the daemon enforces —
    // otherwise the publish succeeds, CI goes green, and the first daemon to
    // pull the image refuses to boot.
    //
    // `refs/heads/main` is exactly why the ref alternation keeps a `heads` arm
    // at all after the narrowing. Delete it and this test says so.
    const re = new RegExp(DEFAULT_IDENTITY_REGEXP);
    for (const ref of ['refs/heads/main', 'refs/tags/v0.3.4', 'refs/tags/v1.10.0']) {
      assert.ok(
        re.test(`${PLUGIN_SIGNER_IDENTITY}@${ref}`),
        `${ref} is a ref this workflow signs from, and the daemon would reject it`,
      );
    }

    // …and the triggers really are the ones just asserted about.
    assert.match(workflow, /^\s*branches:\s*$\n\s*-\s*main\s*$/m);
    assert.match(workflow, /^\s*tags:\s*$\n\s*-\s*'v\*'\s*$/m);
  });

  it('documents that a dispatch from a non-main branch is now unverifiable', () => {
    // The one real cost of the ref narrowing, and the reason it is written into
    // the workflow rather than only into docs: `workflow_dispatch` still exists
    // and still builds, but an image it signs off a feature branch carries
    // `@refs/heads/<branch>`, which the daemon refuses. Someone reaching for the
    // escape hatch at 2am reads the workflow, not SUPPLY_CHAIN.md.
    assert.ok(
      /refs\/heads\/main|non-main|from `main`/.test(workflow),
      'release-runner-image.yml does not warn that a non-main dispatch signs an identity the daemon rejects',
    );
    assert.doesNotMatch(`${PLUGIN_SIGNER_IDENTITY}@refs/heads/release-candidate`, new RegExp(DEFAULT_IDENTITY_REGEXP));
  });
});
