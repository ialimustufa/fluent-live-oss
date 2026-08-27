# Deployment

This runbook deploys the stateful Node.js app to Render and optionally uses
Cloudflare Realtime SFU for viewer audio and Cloudflare R2 for storage and CDN
delivery. Fluent is not a Cloudflare Workers or Pages application.

## Production topology

- Render runs one Node.js web-service instance.
- A persistent Render disk stores SQLite and local uploads under `/data`.
- Gemini Live performs translation from the server.
- Cloudflare Realtime SFU fans translated audio out to viewers when enabled.
- Cloudflare R2 can store uploaded PDFs and hashed client assets.

The single-instance requirement is intentional: active rooms, WebSocket
connections, and Gemini sessions live in process memory. A deploy or restart
ends active talks. Render services with an attached persistent disk do not use
zero-downtime deploys: Render stops the current instance before starting its
replacement, so the site is briefly unavailable as well as losing live room
state.

See Render's official [Blueprint](https://render.com/docs/infrastructure-as-code)
and [persistent disk](https://render.com/docs/disks/) documentation for the
platform behavior behind this setup.

## Prerequisites

- A Render account and a repository containing this project
- A Gemini API key
- A generated admin secret of at least 16 characters
- Optional: a Cloudflare account with Realtime and R2 enabled
- A production origin such as `https://talk.example.com`
- Optional CDN origin such as `https://cdn.example.com`

Keep all provider credentials in Render's environment settings. Do not commit
them or expose them through a `VITE_*` variable.

## 1. Configure Cloudflare Realtime SFU

Skip this section if viewers only need captions, subtitles, slides, polls, and
reactions.

1. In the Cloudflare Realtime dashboard, create a separate Realtime SFU app for
   each environment.
2. Copy the app ID and app secret shown at creation time. Store the secret in a
   password manager; it is a backend credential.
3. Map the values to `CF_REALTIME_APP_ID` and `CF_REALTIME_APP_SECRET`. The older
   `CF_REALTIME_APP_TOKEN` name is accepted only as a compatibility alias.
4. Leave `CF_REALTIME_API_BASE` unset to use
   `https://rtc.live.cloudflare.com/v1`.
5. Keep `AUDIO_SUBSCRIPTION_ACTIVE=false` until the Render service has a stable
   public HTTPS origin.

Fluent creates a Cloudflare WebSocket adapter for each live session. Cloudflare
must be able to open a secure WebSocket back to
`wss://talk.example.com/audio/ingest/<temporary-token>`. The public origin must
therefore support WebSocket upgrades and must not be protected by an
interactive login or challenge on that path.

Cloudflare's current references:

- [Realtime SFU quickstart](https://developers.cloudflare.com/realtime/sfu/get-started/)
- [WebSocket adapter](https://developers.cloudflare.com/realtime/sfu/media-transport-adapters/websocket-adapter/)

## 2. Configure Cloudflare R2

R2 is optional. Without all four R2 credential variables, PDFs remain in
`UPLOADS_DIR` on the Render disk.

1. In **Storage & databases > R2**, create a bucket.
2. Open **Manage R2 API tokens** and create an S3-compatible token with
   **Object Read & Write** access scoped to that bucket only.
3. Copy the account ID, access key ID, and secret access key. The secret is
   displayed once.
4. Set these Render variables:

   ```text
   R2_ACCOUNT_ID=<cloudflare-account-id>
   R2_ACCESS_KEY_ID=<r2-access-key-id>
   R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
   R2_BUCKET=<bucket-name>
   ```

The server uses Cloudflare's S3-compatible endpoint and writes uploaded PDFs
under `slides/`. `npm run upload:assets` writes Vite output under `assets/` in
the same bucket.

See Cloudflare's [R2 S3 setup](https://developers.cloudflare.com/r2/get-started/s3/)
and [R2 token guidance](https://developers.cloudflare.com/r2/api/tokens/).

### Private delivery

Leave `R2_PUBLIC_BASE_URL` and `ASSET_CDN_BASE_URL` unset. PDFs are fetched from
R2 by the server and returned through `/uploads`; built assets remain on the
Render service. The bucket does not need public access.

### Public PDF and asset delivery

For production, attach a custom domain to the bucket rather than using an
`r2.dev` development URL. In the bucket's **Settings > Custom Domains**, attach
`cdn.example.com` and wait for it to become active. Then set:

```text
R2_PUBLIC_BASE_URL=https://cdn.example.com
# Include any previous/secondary domain that exposed this bucket:
R2_CACHE_PURGE_BASE_URLS=https://old-cdn.example.com
R2_CACHE_PURGE_ZONE_ID=<custom-domain-zone-id>
R2_CACHE_PURGE_API_TOKEN=<cache-purge-api-token>
ASSET_CDN_BASE_URL=https://cdn.example.com
```

Create the API token under **Manage Account > API Tokens** with the zone-level
**Cache Purge** permission, scoped to the custom domain's zone. The server
uploads PDFs with `Cache-Control: no-store`. When a PDF is deleted it also
purges that generated filename by URL prefix (including cache-key variants),
and keeps the durable cleanup record until both R2 deletion and cache purge
succeed. Leave `R2_PUBLIC_BASE_URL` unset if the public domain cannot be purged
this way.

`R2_PUBLIC_BASE_URL` is added to the purge list automatically. An
`ASSET_CDN_BASE_URL` used only for compiled JavaScript and CSS does not require
slide-purge credentials and is never inferred as a slide origin. If that
hostname also exposes the shared bucket's `slides/` path, add it explicitly to
`R2_CACHE_PURGE_BASE_URLS`. Before upgrading, put every previous or secondary
public slide base in that comma-separated value. All listed hostnames must
belong to `R2_CACHE_PURGE_ZONE_ID`; manually purge and remove any domain from
another zone before the upgrade. Direct public PDF delivery will not start
without purge credentials.

Set only `R2_PUBLIC_BASE_URL` if direct PDF delivery is wanted without moving
compiled assets to the CDN. Set only `ASSET_CDN_BASE_URL` if only compiled
assets should reference the CDN, but note that a public domain attached to the
shared bucket can still serve any known `slides/` object URL. Do not use a
public bucket for confidential decks.

The custom domain must return CORS headers for module scripts, PDF range
requests, and other browser fetches. Add this GET-only bucket CORS policy,
replacing the origin if needed:

```json
[
  {
    "AllowedOrigins": ["https://talk.example.com"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": [
      "Accept-Ranges",
      "Content-Length",
      "Content-Range",
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

After changing CORS on an active custom domain, purge cached responses for that
hostname so stale headers are not served. See Cloudflare's [public bucket](https://developers.cloudflare.com/r2/buckets/public-buckets/)
and [CORS](https://developers.cloudflare.com/r2/buckets/cors/) documentation,
plus the [prefix purge API](https://developers.cloudflare.com/cache/how-to/purge-cache/purge_by_prefix/).

`ASSET_CDN_BASE_URL` is a build-time setting. The deployed `index.html` and the
uploaded hashed assets must come from the same build. Render's blueprint runs
`npm run build` followed by `npm run upload:assets`; redeploy the exact build if
an `assets/index-*.js` request returns 404.

Asset uploads are additive: the upload script does not delete older hashed
files. Keep every hashed asset referenced by a deployment that remains eligible
for rollback. An older `index.html` points to its original hashes and will fail
after rollback if those objects were removed. If an R2 lifecycle rule cleans up
`assets/`, make its retention window longer than the deployment rollback window
and remove a hash only after no supported deployment references it.

## 3. Deploy on Render

The steps below describe a new deployment. For an existing data-bearing
service, do not start the candidate release before taking rollback backups;
follow the **Retired-data upgrade sequence** under Operations.

1. Create a [Render Blueprint](https://render.com/docs/infrastructure-as-code)
   from the repository. Render reads `render.yaml`.
2. Confirm the service has one instance and its [persistent disk](https://render.com/docs/disks/)
   is mounted at `/data`.
3. Set the required secrets in the Render dashboard:

   ```text
   GEMINI_API_KEY=<gemini-api-key>
   ADMIN_SECRET=<long-random-secret>
   PUBLIC_ORIGIN=https://talk.example.com
   ```

4. Keep the blueprint's production values for `NODE_ENV`, `TRUST_PROXY`,
   `DATABASE_PATH`, and `UPLOADS_DIR`.
5. Add the optional Cloudflare variables from the earlier sections.
6. Deploy with viewer audio disabled first.
7. Attach the production domain, confirm HTTPS, and update `PUBLIC_ORIGIN` if
   the visible origin changed.
8. Open a Render shell and run the read-only inspection:

   ```bash
   npm run preflight
   ```

   The command opens the deployed database read-only and validates migrations
   against a temporary copy. It does not delete objects or compact SQLite.
9. Check `https://talk.example.com/healthz`, create a test session, and exercise
   the viewer and host pages.

The blueprint installs development dependencies because Vite and TypeScript are
needed during the build. The Node process serves the compiled client and API on
the same origin. The attached disk prevents zero-downtime deploys, so schedule
each deploy for a quiet period and expect a short outage while Render replaces
the instance. Never deploy during an active talk.

## 4. Enable and verify viewer audio

After the final public origin is working, set:

```text
AUDIO_SUBSCRIPTION_ACTIVE=true
CF_REALTIME_APP_ID=<realtime-app-id>
CF_REALTIME_APP_SECRET=<realtime-app-secret>
```

Redeploy, then run this from a Render shell:

```bash
npm run check:sfu
```

The diagnostic creates a temporary Realtime session and adapter, waits for
Cloudflare to connect back to the ingest WebSocket, and closes the adapter. It
requires `ADMIN_SECRET` and does not print credentials.

Finish with a real browser test: start a short session, send microphone audio,
join from a second device, and verify both captions and translated audio.

## Data and privacy responsibilities

The operator controls the deployment and is responsible for deciding what may
be collected, telling users, restricting access, setting retention periods, and
honoring applicable access or deletion requests. The application can persist:

- attendee profiles: a viewer ID, optional name and company, join count, total
  watch time, and first-joined and last-seen timestamps;
- source and translated transcript text with language, timing, slide position,
  finalization state, and session association;
- session metadata, poll votes tied to viewer IDs, reaction tallies, attendance
  analytics, and uploaded decks.

Hashes and stable viewer IDs are pseudonymous identifiers, not anonymous data.
Limit dashboard, database, log, and backup access accordingly. Publish a privacy
notice appropriate to the deployment, collect only what is needed, define a
deletion process that covers provider copies, and review the terms and data
locations of Render, Cloudflare, Gemini, analytics, and error-reporting
providers. Operators must determine which consent, lawful-basis, retention,
cross-border-transfer, and user-rights duties apply to their use.

## Operations

Back up SQLite and local uploads before deployments or maintenance:

```bash
npm run backup -- --out /data/backups/backup-name
```

Restore only while the service is stopped:

```bash
npm run restore -- --backup /data/backups/backup-name --force
```

Each backup contains a complete SQLite copy and files in `UPLOADS_DIR`, so it
can retain attendee profiles, transcripts, and locally stored decks after the
live database is cleaned. It does **not** export R2. Before an upgrade that may
retire decks, separately create and verify a versioned copy or export of the
bucket's `slides/` prefix and inventory every current and historical public
slide origin needed for rollback.

Backups created by older releases can also retain data from the retired trial
flows, including lead contact details, abuse-prevention hashes and audit rows,
trial sessions, transcripts, attendee records, and uploaded decks. The upgrade
removes those records from the active schema but does not rewrite historical
backups. Encrypt and access-control off-service copies, apply a documented
expiry schedule to backups as well as primary data, and include backup copies
in deletion and incident-response procedures.

The restore command keeps a safety copy of replaced data. Schedule recurring
backups outside active talks, copy backups off the service disk, and monitor the
disk's free space.

### Retired-data upgrade sequence

Use a quiet window with one application instance and no active talk:

1. Build the candidate release and run `npm run preflight` against the existing
   database. This is read-only; it reports legacy schema and queued maintenance
   without exposing slide references or personal data.
2. Stop or quiesce application writes. Create and verify off-service SQLite,
   local-upload, and R2 `slides/` backups. Rehearse the migration on a
   production-sized copy and record elapsed time and peak disk use.
3. Deploy client and server together. Startup performs only the transactional
   logical migration. Failed local, R2, or cache deletion remains queued and is
   retried every 30 seconds while the service stays healthy.
4. Inspect maintenance state with `npm run preflight`. When deck cleanup has
   completed, stop the service and ensure the database filesystem has free
   space of at least twice the database size plus the current WAL size, then
   run:

   ```bash
   npm run maintenance:compact
   npm run preflight -- --strict-current
   ```

   A lock, busy checkpoint, or insufficient-space error leaves compaction
   queued for a later retry and does not affect the next application start.
5. After health and strict preflight pass, exercise session creation, host,
   stage, viewer, end, and restart behavior.

Rollback after the logical migration requires stopping the service and
restoring the matching SQLite, local-upload, and R2 snapshots. Reverting code
without restoring data is not a complete rollback.

Before each release:

```bash
npm run verify
```

Never deploy during a live talk. WebSocket clients reconnect, but in-memory
room state and the Gemini session cannot survive a process restart.

## Troubleshooting

| Symptom | Check |
|---|---|
| Server exits during startup | Production has `GEMINI_API_KEY`, a non-placeholder `ADMIN_SECRET` of at least 16 characters, and writable `/data` paths. Pending deck cleanup and compaction do not block startup. |
| Cloudflare callback check fails | `PUBLIC_ORIGIN` is HTTPS, WebSocket upgrades reach the app, the Realtime app ID and app secret match, and no access challenge covers `/audio/ingest/*`. |
| PDFs fall back to local disk | All four R2 credential variables are present and scoped to the configured bucket. |
| CDN module or PDF request fails CORS | The exact app origin is in `AllowedOrigins`; purge the CDN cache after changing the policy. |
| Built JS returns 404 | Rebuild and upload assets together; do not mix `index.html` from one deployment with assets from another. |
| SQLite native-module error | Activate Node 24 and rebuild `better-sqlite3`. |
