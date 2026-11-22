#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const rules = [
  // Escape the first character of each literal so the scanner can scan itself.
  ['private-reference', /\x7aamil|\u0632ميل|\x6dario\.garden|\x6dario|\x68awat|\x6byra-server|\x63osmos|\x2fdatapool|\x2fhome\/|\x73haredbrain|\x72uling|\x66orgejo|\x73cratch\//i],
  ['internal-note', /(?:\bout\/[^\s"'()]*\.md|\(#[0-9]+\))/i],
  ['internal-host', /\b(?:[a-z0-9-]+\.)+(?:lan|internal|local)\b(?![.\w-])/i],
  ['personal-email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['credential', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i],
  ['credential-assignment', /(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["'][A-Za-z0-9_+/-]{20,}["']/i],
];

const manifestBytes = execFileSync(process.execPath, ['scripts/export-manifest'], { cwd: root });
const { files } = JSON.parse(manifestBytes);
const byPath = new Map(files.map(file => [file.path, file]));
const findings = [];

for (const { path, bytes, sha256: expected } of files) {
  const absolute = join(root, path);
  if (!lstatSync(absolute).isFile()) throw new Error('Export input is not a regular file');
  const body = readFileSync(absolute);
  if (body.length !== bytes || sha256(body) !== expected) throw new Error('Export input changed during scan');
  const lines = [path, ...new TextDecoder('utf-8', { fatal: true }).decode(body).split(/\r?\n/)];
  for (const [line, text] of lines.entries()) {
    // Preserve the original MIT copyright notice, not other personal references.
    if (path === 'LICENSE' && line === 3 && /^Copyright \(c\) 2026 \x4dario \x48awat$/.test(text)) continue;
    for (const [kind, pattern] of rules) {
      if (pattern.test(text)) findings.push({ path, line, kind });
    }
  }
}

// npm may include only files from the checked manifest. The release check
// compares the actual tar member bytes against these same manifest hashes.
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root }));
for (const { path, size } of pack.files) {
  if (byPath.get(path)?.bytes !== size) findings.push({ path, kind: 'pack-outside-manifest' });
}
for (const file of files) {
  if (sha256(readFileSync(join(root, file.path))) !== file.sha256) throw new Error('Export input changed during pack check');
}
console.log(JSON.stringify({
  status: findings.length ? 'blocked' : 'clear',
  manifestSha256: sha256(manifestBytes),
  files: files.length,
  packFiles: pack.files.length,
  findings,
}, null, 2));
if (findings.length) process.exitCode = 1;
