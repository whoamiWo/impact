# Security Policy

## Supported versions

| Version | Status |
| --- | --- |
| 0.x (latest minor) | Supported with fixes |

Older minor versions are not maintained. The CLI is read-only for your repository; its only write
target is the cache under `.git/impact-cache/v1/`.

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public issue, discussion, or pull request for
unpatched vulnerabilities.

Prefer GitHub Security Advisories if the repository has that feature enabled; otherwise, send a
report to whoami@wo.cn. Include:

- The affected version(s).
- A description of the issue and its impact.
- Steps to reproduce or a proof of concept, if available.

Response targets: acknowledgement within 5 business days; a plan or fix proposal within 14 days
for confirmed issues. These are goals, not guarantees.

## Out of scope

- Issues in third-party dependencies (report upstream; we track advisories and update).
- Attacks requiring the reporter to modify the repository being analyzed (the tool reads it).
- Denial of service against the analyzer itself (it is a local developer tool).
