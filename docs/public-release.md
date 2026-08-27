# Public release and data handling

This repository can hold local databases, uploaded decks, transcripts, test
audio, deployment credentials, and generated bundles. Treat a public release
as a source export, not as a copy of a developer's working directory.

## Recommended repository model

Keep the operational repository private as the canonical source and publish a
separate, squashed public mirror. A fresh mirror has three useful properties:

- ignored local files and `.git` metadata are not copied;
- deleted secrets, old domains, author emails, and private branch names do not
  survive in public history;
- the public project can have its own issues, releases, CI policy, and security
  settings.

Making an existing repository public exposes every reachable commit and its
metadata. Cleaning only the current files is not enough. If preserving history
is a hard requirement, use a reviewed history-rewrite process and rotate every
credential that may have appeared; do not improvise a force-push on the
operational repository.

Treat every later public update as a reviewed snapshot pull request. Never
force-push a public branch or replace its history to make it match the private
repository. Public contributions must be reviewed and ported back to the
private canonical repository before the next snapshot so the two code lines do
not silently diverge.

## Data that must stay private

| Material | Common locations | Handling |
|---|---|---|
| Environment credentials | `.env`, `.env.*`, provider dashboards | Never copy or commit; rotate after suspected exposure. |
| SQLite and journals | `data/`, `server/data/`, `*.db`, `*.db-wal`, `*.db-shm` | Contains session metadata and may contain every record described below. Exclude from source exports. |
| Attendee profiles | `attendees` table and SQLite backups | Viewer ID, optional name and company, join count, total watch time, and first-joined/last-seen timestamps. |
| Transcripts | `transcripts` table, exports, logs, and SQLite backups | Source and translated speech text, language, timing, slide position, finalization state, and session association. |
| Uploaded decks | `uploads/`, `data/**/uploads/`, backups, R2 objects | Treat as user content; delete or retain under the deployment's data policy. |
| Historical retired-flow data | Backups made by older releases, old database exports, logs, and upload/R2 copies | May include lead contact details, abuse-prevention hashes and audit rows, retired trial sessions, transcripts, attendee records, and decks. The current schema no longer collects these lead/audit records, but historical copies remain sensitive. |
| Evaluation media | `evaluation/corpus/`, results, reviewer packets, SFU captures | Use synthetic or explicitly licensed fixtures only in the public repository. |
| Generated builds | `client/dist/`, `server/dist/` | Rebuild from public source. Client bundles can contain `VITE_*` deployment values. |
| Logs and diagnostics | service logs, browser traces, screenshots, crash reports | Remove tokens, session slugs, names, emails, transcripts, and request bodies. |
| Backups | local and `/data/backups/`; separately managed R2 snapshots/exports | SQLite and local-upload copies do not include R2. Every copy can outlive primary-data deletion; encrypt, restrict, expire, and include it in deletion procedures. |
| Machine configuration | `.claude/`, editor files, absolute paths | Remove unless the file is portable and intentionally documented. |
| Git metadata | `.git/`, remotes, refs, commit authors | Do not copy into a fresh public mirror. Review any history before publishing it. |

The lockfile is source metadata and should remain committed. Public test
fixtures must be synthetic, minimal, and free of production identifiers.

## Pre-release review

Start from a clean, approved commit in the private repository.

1. Review tracked and ignored files:

   ```bash
   git status --short
   git status --ignored --short
   git ls-files
   ```

2. Search tracked source for credentials, local paths, email addresses, and
   deployment-specific URLs. Expected placeholders in `.env.example` still
   need manual review.

   ```bash
   git grep -n -I -E '(/Users/|/home/|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,})'
   git grep -n -I -E '(GEMINI_API_KEY|ADMIN_SECRET|CF_REALTIME_APP_SECRET|R2_SECRET_ACCESS_KEY|R2_CACHE_PURGE_API_TOKEN)='
   git grep -n -I -E 'https?://'
   git ls-files | rg '(^|/)(data|dist|uploads|backups)/|\.db($|-)|\.env($|\.)'
   ```

3. Review Git metadata even when using a fresh mirror, so the team knows what
   must not be preserved:

   ```bash
   git remote -v
   git branch --all
   git log --all --format='%h %an <%ae> %s'
   ```

4. Confirm the public package includes `README.md`, `LICENSE`,
   `CONTRIBUTING.md`, `SECURITY.md`, `.env.example`, deployment documentation,
   and tests.
5. Run the repository's public-release scanner, then the complete verification
   suite:

   ```bash
   npm run release:check
   npm ci
   npx playwright install chromium
   npm run verify
   ```

6. Rotate Gemini, admin, Cloudflare, R2, Sentry, and other credentials if a
   scan finds a real value or if exposure cannot be ruled out. Removing a value
   from Git does not revoke it.

## Create a clean public mirror

Export only tracked files from the approved commit. `git archive` excludes the
private repository's `.git` directory and all ignored working files.

```bash
release_root="$(mktemp -d)"
git archive --format=tar HEAD | tar -x -C "$release_root"
cd "$release_root"
```

Inspect the export before creating its history:

```bash
rg --hidden -n -g '!package-lock.json' '(/Users/|/home/|https?://|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,})' .
find . -type f \( -name '.env' -o -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' \)
npm ci
npm run verify
```

Initialize the public repository with the approved GitHub no-reply identity and
public destination:

```bash
git init -b main
git config user.name "ialimustufa"
git config user.email "ialimustufa@users.noreply.github.com"
git add .
git commit -m "Initial open-source release"
git remote add origin https://github.com/ialimustufa/fluent-live-oss.git
git push -u origin main
```

Do not copy the private working directory with Finder, `cp -R`, or an archive
that includes hidden files. Those methods can carry `.env`, `.git`, databases,
uploads, and private tool state into the new repository.

## Configure the public repository

After the first push:

- enable secret scanning and push protection;
- enable private vulnerability reporting;
- protect the default branch and require reviewed pull requests and passing CI
  before merge;
- limit who can publish releases and change repository settings;
- verify issue and pull-request templates do not request production data;
- document which versions receive security fixes;
- clone the public repository into a new directory and run the setup and
  verification instructions exactly as a new contributor would.

For every future sync:

1. Port accepted public contributions back to the private canonical repository,
   preserving attribution and resolving conflicts there.
2. Export an approved private commit to a new snapshot branch in the public
   repository.
3. Open a pull request from that snapshot branch, inspect the complete diff,
   run the release scanner and CI, and obtain review approval.
4. Merge through the protected branch. Never force-push public branches or
   rewrite public history, even when a snapshot needs correction; fix it with a
   new commit or pull request.

Never automate a blind mirror of the private repository. The public branch is
an auditable release history, while the private repository remains canonical.

## Deployment data lifecycle

Repository cleanup does not remove data from Render, R2, logs, backups, or
analytics providers. Define and enforce a deployment policy for:

- how long sessions, transcripts, attendee profiles, poll records, analytics,
  and uploaded decks are kept;
- who can access SQLite, uploaded decks, backups, and provider dashboards;
- when uploaded decks and R2 objects are deleted;
- how users request access or deletion;
- how backups expire and how restore access is audited;
- how incident logs are retained without keeping unnecessary content.

Backups are independent copies: deleting a row or upload from the live service
does not remove it from an older SQLite/upload backup. This includes backups
from releases that still contained retired trial-flow lead, abuse-audit,
session, attendee, transcript, and deck data. Operators must disclose the
deployed collection to users, choose an appropriate legal basis or consent
flow, minimize fields, restrict operator access, set primary and backup expiry,
honor applicable access/deletion requests, and assess provider and
cross-border-transfer obligations. Hashing an IP, viewer, or key-derived value
does not by itself make the record anonymous.

Before transferring or shutting down a deployment, back up required records,
verify retention obligations, revoke provider tokens, remove custom domains,
and delete residual disks and buckets only after the data owner approves.
