'use strict';

/**
 * Tests for hooks/lib/isolation-sentinel.js's resolveSentinelRoot() — specifically
 * the #3582 self-heal call it makes before resolving a linked-worktree/ancestor
 * project root. That call is reached ONLY when '.planning' is NOT directly under
 * the cwd passed in (the early return at the top of the function fires first
 * otherwise).
 *
 * #3582 review finding 1a: every existing #3582 cold-tree fixture
 * (tests/helpers/cold-runtime-lib-fixture.cjs) puts '.planning' directly under
 * the fixture project root, so none of them ever reach this branch — deleting
 * the seam call would fail nothing in those suites. The one existing test that
 * DOES pass a cwd whose '.planning' is not directly present
 * (tests/gsd-agent-isolation-guard.test.cjs's "#3045 MINOR" linked-worktree
 * test) runs against the REAL, already-built dev tree, where
 * ensureRuntimeBuild() is a fast successful no-op — removing the seam call
 * there would not change that test's outcome either, since the next require
 * (worktree-safety.cjs) would resolve identically either way.
 *
 * This file closes that gap. Rather than a real tsc build (which would need
 * this repo's own node_modules/typescript to be reachable from a throwaway
 * fixture root, or a directory symlink into it — the latter a privileged,
 * CI-unsafe operation on Windows per tests/ensure-runtime-build.test.cjs's own
 * comment), it substitutes the THREE modules resolveSentinelRoot requires
 * (the seam itself, worktree-safety.cjs, project-root.cjs) via require.cache,
 * keyed by their real resolved absolute paths. This directly OBSERVES whether
 * the seam call ran (a spy counter), rather than inferring it from a return
 * value that a missing call could coincidentally also produce — and never
 * touches gsd-core/bin/lib on disk. Injected cache entries are restored (or
 * deleted, if absent beforehand) in `t.after()` so no other test sharing this
 * worker process ever observes the substitution.
 *
 * Mutation check performed while authoring this test (not re-run on every CI
 * pass — see the assertions' own doc comments): removing the two-line seam
 * call from resolveSentinelRoot makes `seamCalls` stay 0 and
 * `worktreeSafetyCalls` become 1 (the fake, reachable stub now answers), so
 * this test fails exactly when the fix regresses.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SENTINEL_MODULE_PATH = path.join(REPO_ROOT, 'hooks', 'lib', 'isolation-sentinel.js');
const SEAM_PATH = require.resolve(path.join(REPO_ROOT, 'gsd-core', 'bin', 'ensure-runtime-build.cjs'));
const WORKTREE_SAFETY_PATH = require.resolve(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'worktree-safety.cjs'));
const PROJECT_ROOT_PATH = require.resolve(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'project-root.cjs'));
const SENTINEL_RESOLVED = require.resolve(SENTINEL_MODULE_PATH);

/** Minimal shape Node's Module cache expects; only `.exports` is read by require(). */
function fakeModule(filename, exportsObj) {
  return { id: filename, filename, loaded: true, exports: exportsObj, children: [], paths: [] };
}

describe('hooks/lib/isolation-sentinel.js: resolveSentinelRoot self-heal reachability (#3582 review finding 1a)', () => {
  test('the seam call fires — and short-circuits the downstream requires — when .planning is not directly under cwd', (t) => {
    const savedSeam = require.cache[SEAM_PATH];
    const savedWorktreeSafety = require.cache[WORKTREE_SAFETY_PATH];
    const savedProjectRoot = require.cache[PROJECT_ROOT_PATH];
    const savedSentinel = require.cache[SENTINEL_RESOLVED];

    t.after(() => {
      const restore = (key, saved) => { if (saved) require.cache[key] = saved; else delete require.cache[key]; };
      restore(SEAM_PATH, savedSeam);
      restore(WORKTREE_SAFETY_PATH, savedWorktreeSafety);
      restore(PROJECT_ROOT_PATH, savedProjectRoot);
      restore(SENTINEL_RESOLVED, savedSentinel);
    });

    let seamCalls = 0;
    let worktreeSafetyCalls = 0;
    let projectRootCalls = 0;

    class FakeRuntimeBuildError extends Error {}
    require.cache[SEAM_PATH] = fakeModule(SEAM_PATH, {
      RuntimeBuildError: FakeRuntimeBuildError,
      ensureRuntimeBuild: () => {
        seamCalls += 1;
        throw new FakeRuntimeBuildError('fake cold-tree build failure (#3582 reachability test)');
      },
    });
    require.cache[WORKTREE_SAFETY_PATH] = fakeModule(WORKTREE_SAFETY_PATH, {
      resolvePlanningWorktreeRoot: () => {
        worktreeSafetyCalls += 1;
        return { root: 'SHOULD-NOT-BE-REACHED' };
      },
    });
    require.cache[PROJECT_ROOT_PATH] = fakeModule(PROJECT_ROOT_PATH, {
      findProjectRoot: () => {
        projectRootCalls += 1;
        return 'SHOULD-NOT-BE-REACHED';
      },
    });
    // Fresh require of isolation-sentinel.js itself — not strictly required
    // (its own three requires live inside the function body and are
    // re-evaluated on every call regardless of module-cache state), but keeps
    // this test independent of whatever load order other files in the same
    // worker already forced.
    delete require.cache[SENTINEL_RESOLVED];
    const { resolveSentinelRoot } = require(SENTINEL_MODULE_PATH);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-iso-sentinel-reach-'));
    t.after(() => cleanup(cwd));
    assert.equal(
      fs.existsSync(path.join(cwd, '.planning')),
      false,
      'precondition: no .planning directly under cwd, so the early return must NOT fire',
    );

    const result = resolveSentinelRoot(cwd);

    assert.equal(seamCalls, 1, 'ensureRuntimeBuild() must be called exactly once when .planning is not directly under cwd');
    assert.equal(worktreeSafetyCalls, 0, 'a thrown RuntimeBuildError must short-circuit before resolvePlanningWorktreeRoot is ever reached');
    assert.equal(projectRootCalls, 0, 'a thrown RuntimeBuildError must short-circuit before findProjectRoot is ever reached');
    assert.equal(result, cwd, 'resolveSentinelRoot degrades to the raw cwd on a build failure, same as any other resolution failure');
  });

  test('#4885: a staged lib without resolvePlanningWorktreeRoot falls back to resolveWorktreeRoot, not to raw cwd', (t) => {
    const savedSeam = require.cache[SEAM_PATH];
    const savedWorktreeSafety = require.cache[WORKTREE_SAFETY_PATH];
    const savedProjectRoot = require.cache[PROJECT_ROOT_PATH];
    const savedSentinel = require.cache[SENTINEL_RESOLVED];

    t.after(() => {
      const restore = (key, saved) => { if (saved) require.cache[key] = saved; else delete require.cache[key]; };
      restore(SEAM_PATH, savedSeam);
      restore(WORKTREE_SAFETY_PATH, savedWorktreeSafety);
      restore(PROJECT_ROOT_PATH, savedProjectRoot);
      restore(SENTINEL_RESOLVED, savedSentinel);
    });

    // A hooks/ tree newer than its staged gsd-core/bin/lib: the older
    // worktree-safety.cjs exports only the pre-#4885 resolver.
    require.cache[SEAM_PATH] = fakeModule(SEAM_PATH, { RuntimeBuildError: Error, ensureRuntimeBuild: () => {} });
    require.cache[WORKTREE_SAFETY_PATH] = fakeModule(WORKTREE_SAFETY_PATH, {
      resolveWorktreeRoot: () => ({ root: 'MAIN-WORKTREE-ROOT' }),
    });
    require.cache[PROJECT_ROOT_PATH] = fakeModule(PROJECT_ROOT_PATH, { findProjectRoot: (dir) => `${dir}/PROJECT` });
    delete require.cache[SENTINEL_RESOLVED];
    const { resolveSentinelRoot } = require(SENTINEL_MODULE_PATH);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-iso-sentinel-oldlib-'));
    t.after(() => cleanup(cwd));

    assert.equal(resolveSentinelRoot(cwd), 'MAIN-WORKTREE-ROOT/PROJECT');
  });
});

// ─── #4885 review (trek-e 2026-10-10): the guard's project verdict ───────────
// `resolveSentinelRoot` degrades any failure to the raw cwd — safe for reading
// a sentinel, unsafe as the guards' "is this a GSD project" answer (Major 1).
// `resolveGuardProject` reports the failure instead, and only builds or runs
// git when a project exists above the cwd at all (Major 2). The seam, the lib
// and project-root are substituted through require.cache as above, so each
// row OBSERVES which steps ran.
describe('hooks/lib/isolation-sentinel.js: resolveGuardProject (#4885 review)', () => {
  function withFakes(t, { ensureRuntimeBuild, resolvePlanningWorktreeRoot, findProjectRoot, maxDepth = 10 }) {
    const saved = [SEAM_PATH, WORKTREE_SAFETY_PATH, PROJECT_ROOT_PATH, SENTINEL_RESOLVED].map((k) => [k, require.cache[k]]);
    t.after(() => {
      for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; }
    });
    const calls = { build: 0, worktree: 0, projectRoot: 0 };
    class FakeRuntimeBuildError extends Error {}
    require.cache[SEAM_PATH] = fakeModule(SEAM_PATH, {
      RuntimeBuildError: FakeRuntimeBuildError,
      ensureRuntimeBuild: () => { calls.build += 1; if (ensureRuntimeBuild) ensureRuntimeBuild(FakeRuntimeBuildError); },
    });
    require.cache[WORKTREE_SAFETY_PATH] = fakeModule(WORKTREE_SAFETY_PATH, {
      resolvePlanningWorktreeRoot: (cwd) => { calls.worktree += 1; return resolvePlanningWorktreeRoot(cwd); },
    });
    require.cache[PROJECT_ROOT_PATH] = fakeModule(PROJECT_ROOT_PATH, {
      findProjectRoot: (dir) => { calls.projectRoot += 1; return findProjectRoot(dir); },
      FIND_PROJECT_ROOT_MAX_DEPTH: maxDepth,
    });
    delete require.cache[SENTINEL_RESOLVED];
    const lib = require(SENTINEL_MODULE_PATH);
    return { calls, FakeRuntimeBuildError, resolveGuardProject: lib.resolveGuardProject, resolveSentinelRoot: lib.resolveSentinelRoot };
  }

  function projectTree(t, depth) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-guard-project-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}');
    const sub = path.join(root, ...'abcdefghijklmnop'.slice(0, depth).split(''));
    fs.mkdirSync(sub, { recursive: true });
    return { root, sub };
  }

  const identity = (cwd) => ({ root: cwd, reason: 'not_git_repo' });

  test('Major 2: no .planning/config.json at or above cwd -> not a project, and nothing is built or run', (t) => {
    const { calls, resolveGuardProject } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: (d) => d });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-guard-nogsd-'));
    t.after(() => cleanup(cwd));
    assert.deepEqual(resolveGuardProject(cwd), { project: false });
    assert.deepEqual(calls, { build: 0, worktree: 0, projectRoot: 0 });
  });

  test('cwd holding .planning/config.json is its own root, with nothing built or run', (t) => {
    const { calls, resolveGuardProject } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: (d) => d });
    const { root } = projectTree(t, 0);
    assert.deepEqual(resolveGuardProject(root), { project: true, root, sentinelRoot: root });
    assert.deepEqual(calls, { build: 0, worktree: 0, projectRoot: 0 });
  });

  test('Major 1: a project subdirectory whose runtime build fails -> unresolved (the error), never "not a project"', (t) => {
    const { calls, FakeRuntimeBuildError, resolveGuardProject } = withFakes(t, {
      ensureRuntimeBuild: (E) => { throw new E('fake cold tree'); },
      resolvePlanningWorktreeRoot: identity,
      findProjectRoot: (d) => d,
    });
    const { sub } = projectTree(t, 2);
    const verdict = resolveGuardProject(sub);
    assert.equal(verdict.project, true);
    assert.equal(verdict.root, null);
    assert.ok(verdict.error instanceof FakeRuntimeBuildError, String(verdict.error));
    assert.equal(calls.worktree, 0, 'nothing past the failed build runs');
  });

  test('Major 1: a failed require or a throwing resolver is unresolved too', (t) => {
    const { resolveGuardProject } = withFakes(t, {
      resolvePlanningWorktreeRoot: () => { throw new Error('git unavailable'); },
      findProjectRoot: (d) => d,
    });
    const { sub } = projectTree(t, 1);
    const verdict = resolveGuardProject(sub);
    assert.deepEqual([verdict.project, verdict.root, verdict.error && verdict.error.message], [true, null, 'git unavailable']);
  });

  test('Minor 1: a git timeout resolving the checkout is unresolved, not a silent read of main', (t) => {
    const { resolveGuardProject } = withFakes(t, {
      resolvePlanningWorktreeRoot: () => ({ root: '/some/main', reason: 'git_timed_out' }),
      findProjectRoot: (d) => d,
    });
    const { sub } = projectTree(t, 1);
    const verdict = resolveGuardProject(sub);
    assert.equal(verdict.root, null);
    assert.match(verdict.error.message, /git timed out/);
  });

  test('a resolved root holding the config is the project root', (t) => {
    const { root, sub } = projectTree(t, 3);
    const { resolveGuardProject } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: () => root });
    assert.deepEqual(resolveGuardProject(sub), { project: true, root, sentinelRoot: root });
  });

  // When the writer's root holds no config, no other root's configuration is
  // substituted (Codex review). Past findProjectRoot's ancestor bound, or at a
  // `.planning/` with no config, `cwd` is inside a project whose governing
  // configuration cannot be read: unresolved (the guard denies, Majors 3/4).
  // Within the bound and with no `.planning`, the resolver's own "not a
  // project" stands. 10 / 11 straddle the bound.
  for (const [depth, unresolved] of [[10, false], [11, true]]) {
    test(`resolver finds nothing ${depth} levels below the project -> ${unresolved ? 'unresolved' : 'not a project (its own answer)'}`, (t) => {
      const { sub } = projectTree(t, depth);
      const { resolveGuardProject } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: (d) => d });
      const verdict = resolveGuardProject(sub);
      if (unresolved) {
        assert.deepEqual([verdict.project, verdict.root], [true, null]);
        assert.match(verdict.error.message, /directories below the GSD project/);
      } else {
        assert.deepEqual(verdict, { project: false });
      }
    });
  }

  // The bound is project-root's own constant, not a copy of its value.
  for (const [depth, unresolved] of [[3, false], [4, true]]) {
    test(`the ancestor bound is the one project-root exports: ${depth} levels with a bound of 3 -> ${unresolved ? 'unresolved' : 'not a project'}`, (t) => {
      const { sub } = projectTree(t, depth);
      const { resolveGuardProject } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: (d) => d, maxDepth: 3 });
      const verdict = resolveGuardProject(sub);
      if (unresolved) assert.match(verdict.error.message, /4 directories below the GSD project at .*, past the 3 that/);
      else assert.deepEqual(verdict, { project: false });
    });
  }

  test('resolveSentinelRoot answers a cwd holding .planning/ itself, with nothing built or run', (t) => {
    const { calls, resolveSentinelRoot } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: () => '/elsewhere' });
    const { root } = projectTree(t, 0);
    assert.equal(resolveSentinelRoot(root), root);
    assert.deepEqual(calls, { build: 0, worktree: 0, projectRoot: 0 });
  });

  test('Major 4: a writer root that is a .planning/ with no config is unresolved, never another root\'s config', (t) => {
    const { root, sub } = projectTree(t, 3);
    const shadow = path.join(root, 'a');
    fs.mkdirSync(path.join(shadow, '.planning'));
    const { resolveGuardProject } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: () => shadow });
    const verdict = resolveGuardProject(sub);
    assert.deepEqual([verdict.project, verdict.root], [true, null]);
    assert.match(verdict.error.message, /no config\.json/);
  });

  // #2843: an independent repository nested in a project is not that project's
  // — at any depth, and even with a config-less `.planning/` of its own.
  for (const [label, depth, shadowed] of [['shallow', 3, false], ['past the bound', 12, false], ['with a config-less .planning/', 3, true]]) {
    test(`an independent nested repository (${label}) is not the parent project's`, (t) => {
      const { root } = projectTree(t, 0);
      const child = path.join(root, 'vendor', 'child');
      fs.mkdirSync(child, { recursive: true });
      require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: child, timeout: require('./helpers/timeouts.cjs').GIT_FIXTURE_TIMEOUT_MS });
      if (shadowed) fs.mkdirSync(path.join(child, '.planning'));
      const sub = path.join(child, ...'abcdefghijkl'.slice(0, Math.max(0, depth - 2)).split(''));
      fs.mkdirSync(sub, { recursive: true });
      const { resolveGuardProject } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: () => (shadowed ? child : sub) });
      assert.deepEqual(resolveGuardProject(sub), { project: false });
    });
  }

  // Codex review: a nested repository can be the workspace's only when a
  // config at or above it declares nested repositories (`sub_repos`,
  // `planning.sub_repos`, `multiRepo: true`). Without one, the #2843 answer
  // needs no build; with one, the resolver decides (here: independent).
  function nestedRepo(t, rawConfig) {
    const { root } = projectTree(t, 0);
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), rawConfig);
    const child = path.join(root, 'vendor', 'child');
    fs.mkdirSync(child, { recursive: true });
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: child, timeout: require('./helpers/timeouts.cjs').GIT_FIXTURE_TIMEOUT_MS });
    return { root, child };
  }
  for (const raw of ['{}', 'null', '{"sub_repos":[]}', '{"sub_repos":"vendor"}', '{"planning":{"sub_repos":[]}}', '{"planning":"vendor"}', '{"multiRepo":"true"}']) {
    test(`no nested repositories declared (${raw}) -> an independent nested repository, nothing built`, (t) => {
      const { child } = nestedRepo(t, raw);
      const { calls, resolveGuardProject } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: (d) => d });
      assert.deepEqual(resolveGuardProject(child), { project: false });
      assert.equal(calls.build, 0);
    });
  }
  for (const raw of ['{"sub_repos":["other"]}', '{"planning":{"sub_repos":["other"]}}', '{"multiRepo":true}']) {
    test(`nested repositories declared (${raw}) -> the resolver decides; kept independent, not a project`, (t) => {
      const { child } = nestedRepo(t, raw);
      const { calls, resolveGuardProject } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: (d) => d });
      assert.deepEqual(resolveGuardProject(child), { project: false });
      assert.equal(calls.build, 1);
    });
  }
  test('a declaration ABOVE the nearest configured project also hands the decision to the resolver', (t) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-guard-outer-'));
    t.after(() => cleanup(ws));
    fs.mkdirSync(path.join(ws, '.planning'));
    fs.writeFileSync(path.join(ws, '.planning', 'config.json'), '{"sub_repos":["inner"]}');
    const inner = path.join(ws, 'inner');
    fs.mkdirSync(path.join(inner, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(inner, '.planning', 'config.json'), '{}');
    const child = path.join(inner, 'vendor', 'child');
    fs.mkdirSync(child, { recursive: true });
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: child, timeout: require('./helpers/timeouts.cjs').GIT_FIXTURE_TIMEOUT_MS });
    const { calls, resolveGuardProject } = withFakes(t, { resolvePlanningWorktreeRoot: identity, findProjectRoot: (d) => d });
    assert.deepEqual(resolveGuardProject(child), { project: false });
    assert.equal(calls.build, 1);
  });
});

// #4885 review (M4): the hook decides "which project, if any" BEFORE any build,
// with its own pure-fs walk (nearestProjectConfigDir) and a git repo-boundary
// check (gitCommonDirOf), beside src/project-root.cts's findProjectRoot. The
// rows above run with both collaborators faked, so nothing ties the two
// notions together. This table runs the REAL hook and the REAL findProjectRoot
// over the same directories: when the hook names a project, it is the root
// findProjectRoot resolves; when the hook says "not a project", findProjectRoot
// does not land on a configured project either.
describe('#4885 parity: resolveGuardProject agrees with findProjectRoot (review M4)', () => {
  const { execFileSync } = require('node:child_process');
  const { GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
  const gitInit = (dir) => execFileSync('git', ['init', '-q'], { cwd: dir, timeout: GIT_FIXTURE_TIMEOUT_MS });
  const real = (p) => fs.realpathSync.native(p);
  const deep = (base, n) => path.join(base, ...'abcdefghij'.slice(0, n).split(''));

  function world(t) {
    const top = real(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-guard-parity-')));
    t.after(() => cleanup(top));
    const project = path.join(top, 'project');
    fs.mkdirSync(path.join(project, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), '{}');
    gitInit(project);
    const nested = path.join(project, 'vendor', 'child');
    fs.mkdirSync(path.join(nested, 'src'), { recursive: true });
    gitInit(nested);
    const plain = path.join(top, 'plain');
    fs.mkdirSync(plain);
    gitInit(plain);
    for (const n of [3, 10]) fs.mkdirSync(deep(project, n), { recursive: true });
    return { project, nested, plain };
  }

  function assertAgree(cwd) {
    const { resolveGuardProject } = require(SENTINEL_MODULE_PATH);
    const { findProjectRoot } = require(PROJECT_ROOT_PATH);
    const verdict = resolveGuardProject(cwd);
    const found = findProjectRoot(cwd);
    const configured = fs.existsSync(path.join(found, '.planning', 'config.json'));
    if (verdict.project && verdict.root) {
      assert.equal(real(verdict.root), real(found), `${cwd}: the hook's root is the one findProjectRoot resolves`);
    } else {
      assert.deepEqual(verdict, { project: false }, `${cwd}: ${JSON.stringify(verdict)}`);
      assert.ok(!configured, `${cwd}: the hook says "not a project" but findProjectRoot resolved the configured project ${found}`);
    }
    return verdict;
  }

  test('project root, 3 and 10 levels below it: the same root', (t) => {
    const { project } = world(t);
    for (const cwd of [project, deep(project, 3), deep(project, 10)]) {
      assert.equal(assertAgree(cwd).project, true, cwd);
    }
  });

  test('an independent nested repository inside the project, and a repository with no GSD project: neither is the project', (t) => {
    const { nested, plain } = world(t);
    for (const cwd of [nested, path.join(nested, 'src'), plain]) {
      assert.equal(assertAgree(cwd).project, false, cwd);
    }
  });

  test('a nested repository with a config-less .planning/ of its own is still not the project', (t) => {
    // The one shape where only the hook's pre-build boundary decides: past it,
    // findProjectRoot stops at the child's own .planning/ and the hook would
    // call the dispatch unresolved instead of "not this project".
    const { nested } = world(t);
    fs.mkdirSync(path.join(nested, '.planning'));
    assert.equal(assertAgree(path.join(nested, 'src')).project, false);
  });

  // Codex review: findProjectRoot honors an explicit claim on a nested
  // repository before its #2843 boundary, so the hook must too — and a claim
  // naming another directory leaves the boundary standing.
  for (const [label, claim, claimed] of [
    ['sub_repos', { sub_repos: ['vendor'] }, true],
    ['planning.sub_repos', { planning: { sub_repos: ['vendor'] } }, true],
    ['multiRepo: true', { multiRepo: true }, true],
    ['sub_repos naming another directory', { sub_repos: ['other'] }, false],
  ]) {
    test(`a nested repository with the project's config claiming it by ${label}: ${claimed ? 'the project' : 'not the project'}`, (t) => {
      const { project, nested } = world(t);
      fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify(claim));
      for (const cwd of [nested, path.join(nested, 'src')]) {
        const verdict = assertAgree(cwd);
        assert.equal(verdict.project, claimed, cwd);
        if (claimed) assert.equal(real(verdict.sentinelRoot), real(project), `${cwd}: the sentinel is read at the workspace gsd-tools writes it to`);
      }
    });
  }

  // Codex review, round 2: the claim is the resolver's to decide, wherever it
  // is declared and however the cwd is spelled.
  test('a claim declared above a configured project still makes its nested repository the workspace\'s', (t) => {
    const { project, nested } = world(t);
    // vendor/ is a configured project of its own; the claim on vendor/ is project's.
    fs.mkdirSync(path.join(project, 'vendor', '.planning'));
    fs.writeFileSync(path.join(project, 'vendor', '.planning', 'config.json'), '{}');
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ sub_repos: ['vendor'] }));
    const verdict = assertAgree(path.join(nested, 'src'));
    assert.equal(real(verdict.root), real(project));
  });

  test('a claimed nested repository reached through a symlinked alias is still the workspace\'s', (t) => {
    const { project, nested } = world(t);
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ sub_repos: ['vendor'] }));
    const alias = path.join(project, 'link');
    fs.symlinkSync(path.join(nested, 'src'), alias, 'junction');
    const verdict = assertAgree(alias);
    assert.equal(real(verdict.root), real(project));
    assert.equal(real(verdict.sentinelRoot), real(project));
  });

  test('a claimed nested repository reached through an alias from OUTSIDE the workspace is governed by the workspace\'s config', (t) => {
    const { project, nested } = world(t);
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ sub_repos: ['vendor'] }));
    const outside = real(fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-guard-parity-out-')));
    t.after(() => cleanup(outside));
    const alias = path.join(outside, 'alias');
    fs.symlinkSync(path.join(nested, 'src'), alias, 'junction');
    // Only the canonical path leads to the workspace, so (as for any alias)
    // the configuration is the canonical workspace's and the sentinel is read
    // where gsd-tools, given this same cwd, writes it.
    const { resolveGuardProject, resolveSentinelRoot } = require(SENTINEL_MODULE_PATH);
    const verdict = resolveGuardProject(alias);
    assert.equal(verdict.project, true, JSON.stringify(verdict));
    assert.equal(real(verdict.root), real(project));
    assert.equal(verdict.sentinelRoot, resolveSentinelRoot(alias));
  });

  test('a sub_repos entry that is a symlink to a repository elsewhere is the workspace\'s, as findProjectRoot\'s lexical walk says', (t) => {
    const { project, plain } = world(t);
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ sub_repos: ['linked'] }));
    const linked = path.join(project, 'linked');
    fs.symlinkSync(plain, linked, 'junction');
    assert.equal(real(assertAgree(linked).root), real(project));
  });

  test('a nested repository the resolver keeps as its own (config-less .planning/) under multiRepo is not the workspace\'s', (t) => {
    const { project, nested } = world(t);
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ multiRepo: true }));
    fs.mkdirSync(path.join(nested, '.planning'));
    assert.deepEqual(assertAgree(path.join(nested, 'src')), { project: false });
  });
});
