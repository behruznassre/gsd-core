'use strict';

/**
 * Preload fixture for #5327 — count how many times THIS process probes its own
 * start-time through capability-lock's `getProcessStartTime(process.pid)`.
 *
 * The probe has one shape per platform (src/capability-lock.cts):
 *   - linux:  fs.readFileSync(`/proc/<pid>/stat`)
 *   - win32:  spawnSync('powershell', [..., `(Get-Process -Id <pid>).StartTime.Ticks`])
 *   - other:  spawnSync('ps', ['-p', '<pid>', '-o', 'lstart='])
 * Both seams are wrapped here, and only a probe naming OUR OWN pid counts, so a
 * steal-path probe of another holder's pid is never mistaken for the self probe.
 *
 * The running count is exposed as `globalThis.__gsdSelfStartTimeProbes()`, and the
 * ordered probe / exclusive-open events as `globalThis.__gsdSelfStartTimeEvents()`, for
 * `node -e` scripts, and printed on exit as a `GSD_SELF_START_TIME_PROBES=<n>`
 * stderr line for whole-CLI runs, next to `GSD_CAPABILITY_LOCK_LOADED=<bool>`.
 *
 * Loaded via `node --require <this file> ...`. One-shot subprocess: no restore.
 */

const fs = require('node:fs');
const childProcess = require('node:child_process');

const selfPid = String(process.pid);
let count = 0;
// Ordered record of self probes and exclusive ('wx') opens, so a test can assert the probe
// runs BEFORE the lockfile is created rather than inside the held window.
const events = [];

const realReadFileSync = fs.readFileSync;
fs.readFileSync = function countingReadFileSync(file, ...rest) {
  if (file === `/proc/${selfPid}/stat`) { count++; events.push('probe'); }
  return realReadFileSync.call(this, file, ...rest);
};

const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function countingSpawnSync(cmd, args, ...rest) {
  const argv = Array.isArray(args) ? args : [];
  const isPsSelf = argv.includes('lstart=') && argv.includes(selfPid);
  // includes(), not ===: a powershell .cmd/.bat shim is mediated through cmd.exe, which folds the
  // expression into one `/c` command string.
  const isPowershellSelf = argv.some((a) => typeof a === 'string' && a.includes(`(Get-Process -Id ${selfPid}).StartTime.Ticks`));
  if (isPsSelf || isPowershellSelf) { count++; events.push('probe'); }
  return realSpawnSync.call(this, cmd, args, ...rest);
};

const realOpenSync = fs.openSync;
fs.openSync = function recordingOpenSync(file, flags, ...rest) {
  if (flags === 'wx') events.push('open-wx');
  return realOpenSync.call(this, file, flags, ...rest);
};

globalThis.__gsdSelfStartTimeProbes = () => count;
globalThis.__gsdSelfStartTimeEvents = () => events.slice();

process.on('exit', () => {
  // Whether capability-lock was loaded at all, so a zero count can never pass vacuously.
  const lockLoaded = Object.keys(require.cache).some((k) => /[\\/]capability-lock\.cjs$/.test(k));
  process.stderr.write(`GSD_SELF_START_TIME_PROBES=${count}\nGSD_CAPABILITY_LOCK_LOADED=${lockLoaded}\n`);
});
