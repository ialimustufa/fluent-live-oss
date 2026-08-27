#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const rootPath = fileURLToPath(root);
const prunedDirectoryNames = new Set(['.git', '.cache', 'coverage', 'dist', 'node_modules']);

function listFilesFromFilesystem() {
  const files = [];
  const directories = [rootPath];
  while (directories.length > 0) {
    const directory = directories.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(rootPath, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!prunedDirectoryNames.has(entry.name)) directories.push(absolute);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  return files.sort();
}

const discoveredGitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: rootPath,
  encoding: 'utf8',
});
const isRepositoryRoot =
  discoveredGitRoot.status === 0 &&
  fs.realpathSync(discoveredGitRoot.stdout.trim()) === fs.realpathSync(rootPath);

let files;
let listingMode;
if (isRepositoryRoot) {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: rootPath,
    encoding: 'utf8',
  });
  if (listed.status === 0) {
    files = listed.stdout.split('\0').filter(Boolean).filter((file) => fs.existsSync(path.join(rootPath, file)));
    listingMode = 'Git';
  }
}

if (!files) {
  files = listFilesFromFilesystem();
  listingMode = 'filesystem';
}

const findings = [];
const forbiddenPaths = [
  { label: 'environment file', test: (file) => /^\.env(?:\.|$)/.test(file) && file !== '.env.example' },
  { label: 'local data', test: (file) => /(^|\/)data\//.test(file) || /\.(?:db|db-wal|db-shm)$/.test(file) },
  { label: 'generated dependency/build output', test: (file) => /(^|\/)(?:node_modules|dist)\//.test(file) },
  { label: 'private handover', test: (file) => /(^|\/)HANDOVER\.md$/.test(file) },
  { label: 'machine-specific launcher', test: (file) => /^\.claude\//.test(file) },
];

for (const file of files) {
  for (const rule of forbiddenPaths) {
    if (rule.test(file)) findings.push({ file, line: 1, label: rule.label });
  }
}

const privateDomain = new RegExp(['cdn', 'ali', 'org', 'in'].join('\\.'));
const productionDomain = new RegExp(['fluent', 'iali', 'in'].join('\\.'));
const privateEmailUser = ['alimustafa', 'ats24'].join('');
const privateEmail = new RegExp(`${privateEmailUser}[.@]${['gmail', 'com'].join('[.@]')}`, 'i');
const personalName = new RegExp(['Ali', 'Mustufa'].join('\\s+'), 'i');
const formShortId = ['xaV2eha', '9175Q1Crm7'].join('');
const formEmbedId = ['1FAIpQLScrYjwyMUwOijPpolXwntYbI5', '--SC38pw', 'R26Qab4bNwTLKx5A'].join('');

const contentRules = [
  { label: 'absolute macOS home path', regex: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: 'absolute Windows home path', regex: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/i },
  { label: 'personal Gmail address', regex: /[A-Z0-9._%+-]+@gmail\.com/i },
  { label: 'private CDN domain', regex: privateDomain },
  { label: 'private production domain', regex: productionDomain },
  { label: 'private author email', regex: privateEmail },
  { label: 'personal attribution', regex: personalName },
  { label: 'account-owned Google Form', regex: /(?:forms\.gle\/|docs\.google\.com\/forms\/)/i },
  { label: 'account-owned Google Form id', regex: new RegExp(`${formShortId}|${formEmbedId}`) },
  { label: 'Google identity link', regex: /kgmid=\/g\//i },
  { label: 'private key material', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'GitHub token', regex: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { label: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { label: 'AWS access key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'non-placeholder analytics id', regex: /\bG-(?!X{6,}\b)[A-Z0-9]{8,}\b/ },
];

for (const file of files) {
  let data;
  try {
    data = fs.readFileSync(new URL(file, root));
  } catch {
    continue;
  }
  if (data.includes(0)) continue;
  const lines = data.toString('utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of contentRules) {
      if (rule.regex.test(lines[index])) {
        findings.push({ file, line: index + 1, label: rule.label });
      }
    }
  }
}

if (findings.length > 0) {
  console.error('Public release check failed:');
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} (${finding.label})`);
  }
  process.exit(1);
}

console.log(`Public release check passed (${files.length} release files scanned via ${listingMode}).`);
