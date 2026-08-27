# Security policy

## Supported versions

Security fixes are applied to the current default branch and the latest
published release. Older commits and privately modified deployments are not
maintained.

| Version | Supported |
|---|---|
| Current default branch / latest release | Yes |
| Older releases and commits | No |

## Report a vulnerability

Use GitHub's private vulnerability reporting flow from the repository's
**Security** tab. Include:

- the affected commit or release;
- the component, route, or message type involved;
- reproduction steps or a minimal proof of concept;
- the likely impact and required privileges;
- any suggested mitigation.

Do not include real credentials, production databases, uploaded decks,
transcripts, attendee details, or other user data. Use synthetic examples and
redact tokens and session identifiers.

If private vulnerability reporting is unavailable, open a minimal public issue
asking for a private reporting channel. Do not disclose the vulnerability or
its reproduction steps in that issue.

Maintainers aim to acknowledge a complete report within three business days,
confirm scope or request more information within seven business days, and keep
the reporter informed until a fix or mitigation is available. Timelines can
vary with severity and provider dependencies.

## In scope

Reports are especially useful when they involve:

- authentication or authorization bypass;
- exposure of Gemini, admin, Cloudflare, R2, or other server credentials;
- unauthorized host WebSocket actions or viewer-to-host privilege escalation;
- unsafe file upload, path handling, or deck embedding;
- access to sessions, transcripts, attendance, leads, analytics, or uploads
  beyond the intended public interface;
- server-side request forgery, injection, cross-site scripting, or CSP bypass;
- denial of service caused by a small number of crafted requests rather than
  ordinary capacity limits.

Reports about provider outages, unsupported browser features, expected
single-instance restart behavior, or attacks requiring access to the reporter's
own deployment configuration are generally not vulnerabilities in Fluent.

## Deployment guidance

- Keep every non-`VITE_*` credential on the server.
- Use a unique `ADMIN_SECRET` of at least 16 characters in production.
- Set `TRUST_PROXY=true` only behind a trusted proxy that controls
  `X-Forwarded-For`.
- Use HTTPS for `PUBLIC_ORIGIN` and restrict provider tokens to the minimum
  required account, app, and bucket.
- Keep SQLite, uploads, backups, and logs outside the source repository.
- Rotate credentials immediately after suspected disclosure; deleting them
  from source or Git history is not revocation.
- Run `npm run verify` and `npm run preflight` before deployment.

See [Deployment](docs/deployment.md) and [Public release and data
handling](docs/public-release.md) for the complete operational checklist.
