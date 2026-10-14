'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cleanup, createTempDir } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// #5327: capability-lock probed THIS process's start-time at module load. Every
// config read loads the module (config-loader → loadRegistry → capability-consent
// → capability-lock), so every gsd-tools invocation paid one probe — a PowerShell
// launch on Windows (~200 ms), a `ps` on macOS — even when it never took a lock.
//
// The start-time is only ever read by lockFileBody, so the contract pinned here:
//   - loading the module, and a whole config-reading CLI call, probe ZERO times;
//   - the first lock write probes ONCE, before the exclusive create, and later
//     writes reuse that value;
//   - the lock body still carries this process's start-time (the pid-reuse
//     discriminator the steal path compares against is unchanged).
//
// Each case runs in a fresh subprocess, because module-load behavior can only be
// observed on a cold require. The preload counts only probes naming the child's
// own pid, on whichever platform seam applies (/proc read, `ps`, PowerShell).
// ─────────────────────────────────────────────────────────────────────────────

const PRELOAD = path.join(__dirname, 'helpers', 'count-self-start-time-probes-preload.cjs');
const LOCK_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'capability-lock.cjs');
const GSD_TOOLS = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const PROBE_LINE = /^GSD_SELF_START_TIME_PROBES=(\d+)$/m;
const LOADED_LINE = /^GSD_CAPABILITY_LOCK_LOADED=(true|false)$/m;

function sandbox(t) {
  const dir = createTempDir('gsd-caplock-self-probe-');
  t.after(() => cleanup(dir));
  return dir;
}

function sandboxEnv(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, GSD_HOME: path.join(home, '.gsd') };
}

describe('#5327 regression: capability-lock probes its own start-time lazily', () => {
  // The issue's literal repro (runtime-identity) plus a direct config read.
  for (const argv of [['runtime-identity', '--raw'], ['query', 'config-get', 'model_profile']]) {
    test(`gsd-tools ${argv.join(' ')} loads capability-lock but never probes its own start-time`, (t) => {
      const home = sandbox(t);
      fs.mkdirSync(path.join(home, '.planning'));
      fs.writeFileSync(path.join(home, '.planning', 'config.json'), JSON.stringify({ model_profile: 'quality' }));
      const res = runNode(['--require', PRELOAD, GSD_TOOLS, ...argv], { cwd: home, env: sandboxEnv(home) });
      assert.equal(res.outcome, OUTCOME.EXITED, res.stderr);
      assert.equal(res.exitCode, 0, res.stderr);

      // Without this, a future startup change that stops loading the module would pass vacuously.
      assert.match(res.stderr, LOADED_LINE);
      assert.equal(LOADED_LINE.exec(res.stderr)[1], 'true', 'the command must load capability-lock for the zero count to mean anything');

      const m = PROBE_LINE.exec(res.stderr);
      assert.ok(m, `preload did not report a probe count:\n${res.stderr}`);
      assert.equal(Number(m[1]), 0, 'loading capability-lock through a config read must not probe this process\'s start-time');
    });
  }

  test('module load probes zero times; the first lock write probes once and later writes reuse it', (t) => {
    const dir = sandbox(t);
    const script = `
      const probes = globalThis.__gsdSelfStartTimeProbes;
      const lock = require(${JSON.stringify(LOCK_LIB)});
      const lockPath = require('path').join(${JSON.stringify(dir)}, '.lock');
      const afterLoad = probes();

      const first = lock.acquireLock(lockPath);
      if (!first) throw new Error('first acquireLock returned null');
      const body = JSON.parse(require('fs').readFileSync(lockPath, 'utf8'));
      const afterFirstWrite = probes();
      lock.releaseLock(first);

      const second = lock.acquireLock(lockPath);
      if (!second) throw new Error('second acquireLock returned null');
      const afterSecondWrite = probes();
      lock.releaseLock(second);

      const events = globalThis.__gsdSelfStartTimeEvents();
      const direct = lock.getProcessStartTime(process.pid);
      process.stdout.write(JSON.stringify({ afterLoad, afterFirstWrite, afterSecondWrite, events, body, direct }));
    `;
    const res = runNode(['--require', PRELOAD, '-e', script], { cwd: dir, env: sandboxEnv(dir) });
    assert.equal(res.outcome, OUTCOME.EXITED, res.stderr);
    assert.equal(res.exitCode, 0, res.stderr);
    const r = JSON.parse(res.stdout);

    assert.equal(r.afterLoad, 0, 'requiring capability-lock must not probe this process\'s start-time');
    assert.equal(r.afterFirstWrite, 1, 'the first lock write probes this process\'s start-time exactly once');
    assert.equal(r.afterSecondWrite, 1, 'a later lock write reuses the cached start-time instead of re-probing');

    // Between the O_EXCL create and the body write a racing acquirer sees an empty lockfile, so the
    // (possibly slow) first probe must run before the create, not inside that window.
    assert.deepEqual(r.events, ['probe', 'open-wx', 'open-wx'], 'the self probe runs before the first exclusive lockfile create');

    // The steal path compares a holder's recorded startTime against a fresh probe of
    // that pid, so the body must still carry the value a direct probe returns.
    assert.equal(r.body.pid, Number(r.body.token.split('-')[0]));
    assert.equal(r.body.startTime, r.direct, 'the lock body records this process\'s own start-time');
  });
});
