#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENGLISH = 'Codex stop-time review found issues that still need fixes before ending the session:';
const CHINESE = 'Codex 提出了以下 review 意见，请仔细阅读并分析是否有价值：';
const TIMEOUT_RE = /(const\s+STOP_REVIEW_TIMEOUT_MS\s*=\s*)([^;]+)(;)/;
const TIMEOUT_NEW = '5 * 60 * 1000';

const codexRoot = join(homedir(), '.claude/plugins/cache/openai-codex/codex');

if (!existsSync(codexRoot)) {
  console.error(`codex plugin cache not found: ${codexRoot}`);
  process.exit(1);
}

const versions = readdirSync(codexRoot, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

if (versions.length === 0) {
  console.error(`no version subdirs under ${codexRoot}`);
  process.exit(1);
}

let touched = 0;
let drift = false;

for (const version of versions) {
  const file = join(codexRoot, version, 'scripts/stop-review-gate-hook.mjs');
  if (!existsSync(file)) {
    console.error(`[miss] ${file}`);
    continue;
  }
  const before = readFileSync(file, 'utf8');
  let after = before;

  if (after.includes(ENGLISH)) {
    after = after.replace(ENGLISH, CHINESE);
  } else if (!after.includes(CHINESE)) {
    console.error(`[drift] ${file}: english marker missing — upstream string may have changed`);
    drift = true;
  }

  const m = after.match(TIMEOUT_RE);
  if (!m) {
    console.error(`[drift] ${file}: STOP_REVIEW_TIMEOUT_MS declaration not found`);
    drift = true;
  } else if (m[2].trim() !== TIMEOUT_NEW) {
    after = after.replace(TIMEOUT_RE, `$1${TIMEOUT_NEW}$3`);
  }

  if (after === before) {
    console.log(`[skip] ${file}`);
  } else {
    writeFileSync(file, after);
    console.log(`[ok]   ${file}`);
    touched++;
  }
}

console.log(`\ntouched=${touched}/${versions.length}`);
process.exit(drift ? 2 : 0);
