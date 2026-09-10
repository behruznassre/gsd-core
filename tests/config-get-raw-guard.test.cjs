'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3763 — every `config-get` command substitution in shipped content passes
// `--raw` (or is an exempt JSON consumer).
//
// `query config-get <key>` without `--raw` prints `JSON.stringify(value)`, so
// a STRING-typed value reaches a bash variable with embedded literal quotes
// (`RUNTIME='"claude"'`) and every downstream `[ "$X" = "y" ]` / `case "$X"`
// comparison silently never matches. Boolean and numeric values are identical
// either way, which is exactly why the string sites survived testing.
//
// Exempt shape (a consumer that WANTS JSON — an object/array value):
//   * the receiving variable's name ends in `_JSON`
// Anything else that command-substitutes config-get must pass `--raw`.
//
// #4382 INVERTED the second exemption. A JSON array/object `--default` literal
// used to be treated as PROOF the call site was safe without `--raw`; it is the
// opposite. `--default` text is reinterpreted as a structure (config.cts
// coerceStructuredDefault) and the two paths now agree, but the flag is what
// makes the intent explicit at the call site and what keeps the encoding pinned
// if the coercion is ever narrowed. Both sites this exemption hid — the
// code-review depth-override read and the ship custom-PR-sections read — were
// genuinely broken while passing this guard, so a structured default now
// REQUIRES `--raw`, and it overrides the `_JSON` name exemption rather than
// stacking with it: a name is a convention, a default literal is evidence.
//
// A `_JSON` site with NO `--default` stays exempt and is deliberately left
// alone: it reads a genuinely-configured value, which the non-raw path has
// always encoded correctly in a single pass (verified on this issue for
// plan-review-convergence.md's reviewer read and pr-branch.md's sub-repo read).
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_ROOTS = [
  'gsd-core/workflows',
  'commands',
  'agents',
  'skills',
];

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// A config-get COMMAND SUBSTITUTION: any command substitution containing
// config-get — `$(gsd_run query config-get ...)`, `$(gsd-tools ... config-get
// ...)`, etc. Prose mentions (no `$(`) do not match; nested `$( )` inside the
// substitution is not a shape the shipped trees use for config-get calls.
const SUBSTITUTION_RE = /\$\([^)]*config-get[^)]*\)/g;

// A `--default` whose quoted literal opens with `[` or `{` — the structured
// shape config-get reinterprets, and the one that must carry --raw (#4382).
const STRUCTURED_DEFAULT_RE = /--default\s+(?:'\s*[[{]|"\s*[[{])/;

/**
 * The single rule, used by BOTH the shipped scan below and the synthetic
 * ordering cases at the bottom of this file.
 *
 * It lives in one place deliberately (Codex review round 2). A previous cut had
 * the ordering test carrying its own copy of this logic, which meant deleting
 * the scanner's structured-default check left the test green — the test pinned
 * a duplicate, not the rule the scan actually applies.
 *
 * Returns an `exempt:*` reason or an `offender:*` reason, so a caller can tell
 * WHICH rule fired, not merely whether the line passed.
 */
function classifySubstitution(line, sub) {
  // --raw must sit in the config-get command itself, before any `||` fallback —
  // an `echo "" --raw` fallback arg would otherwise false-pass the check while
  // config-get still lacks the flag.
  const cut = sub.indexOf('||');
  const cmd = cut >= 0 ? sub.slice(0, cut) : sub;
  if (cmd.includes('--raw')) return 'exempt:raw';
  // #4382: a JSON array/object `--default` literal REQUIRES --raw. This check
  // runs BEFORE the `_JSON` name exemption so a JSON-ish variable name cannot
  // buy the call site past a structured default.
  if (STRUCTURED_DEFAULT_RE.test(cmd)) return 'offender:structured-default';
  // Exempt shape: a JSON-consuming variable name reading a CONFIGURED value —
  // the caller wants JSON.stringify output, and a stored array/object already
  // encodes correctly in one pass.
  const varMatch = /^\s*[A-Za-z_][A-Za-z0-9_]*=/.exec(line);
  const varName = varMatch ? varMatch[0].trimEnd().slice(0, -1) : '';
  if (varName.endsWith('_JSON')) return 'exempt:json-name';
  return 'offender:no-raw';
}

test('#3763 + #4382: every config-get command substitution in shipped content passes --raw (or is an exempt JSON consumer with no structured default)', () => {
  const files = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), files);

  const offenders = [];
  let scannedSubstitutions = 0;
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('config-get')) continue;
      const subs = line.match(SUBSTITUTION_RE) || [];
      for (const sub of subs) {
        scannedSubstitutions++;
        if (classifySubstitution(line, sub).startsWith('exempt:')) continue;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  }

  assert.ok(scannedSubstitutions > 20,
    `guard self-check: expected to scan dozens of config-get substitutions, found ${scannedSubstitutions} — the scan roots or matcher rotted`);
  assert.deepEqual(
    offenders,
    [],
    `#3763/#4382: config-get command substitutions without --raw feed JSON.stringify output into bash string comparisons (they silently never match for string values), and a structured --default literal without --raw is the #4382 double-encoding shape. Add --raw. Renaming the receiving variable to *_JSON exempts only a call site that reads a configured value with NO structured --default. Offenders:\n${offenders.join('\n')}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// #4382 — the ORDERING of the two rules, pinned directly.
//
// The scan above cannot prove it. Neither repaired call site has a `_JSON`
// variable name, so if the structured-default check were deleted both would
// still be caught by the final catch-all and the scan would stay green while
// the rule it is supposed to enforce had silently vanished. Only a site that is
// BOTH `_JSON`-named AND carrying a structured default distinguishes "structured
// default is checked first" from "structured default is not checked at all".
// (Codex review round 1.)
// ─────────────────────────────────────────────────────────────────────────────
test('#4382: a structured --default requires --raw even when the variable is _JSON-named', () => {
  // The SAME function the scan above runs — not a copy of its logic, which is
  // what made an earlier version of this test unable to fail. (Codex round 2.)
  const classify = (line) => {
    const sub = (line.match(SUBSTITUTION_RE) || [])[0];
    if (!sub) return 'no-substitution';
    return classifySubstitution(line, sub);
  };

  assert.equal(
    classify(`X_JSON=$(gsd_run query config-get some.key --default '[]')`),
    'offender:structured-default',
    'a _JSON name must NOT exempt a call carrying a structured default — this is the #4382 inversion',
  );
  assert.equal(
    classify(`X_JSON=$(gsd_run query config-get some.key --default '{"a":1}')`),
    'offender:structured-default',
    'object literals too, not just arrays',
  );
  // The other three quadrants, so the rule is pinned in every direction.
  assert.equal(
    classify(`X_JSON=$(gsd_run query config-get some.key)`),
    'exempt:json-name',
    'a _JSON read of a CONFIGURED value stays exempt — this is what protects the two call sites #4382 triage refuted',
  );
  assert.equal(
    classify(`X_JSON=$(gsd_run query config-get some.key --raw --default '[]')`),
    'exempt:raw',
    'adding --raw is what clears a structured default',
  );
  assert.equal(
    classify(`PLAIN=$(gsd_run query config-get some.key)`),
    'offender:no-raw',
    'the original #3763 rule is unchanged',
  );
});
