# Open core boundary

This document records which capabilities are permanently free and which may be offered commercially.
It exists to avoid "open-wash then take away" risk.

## Permanently free (core)

All of the current core scenario:

- git diff collection, including merge-base resolution and working tree changes,
- workspace discovery for npm/pnpm/yarn/bun,
- manifest and source dependency graphs,
- affected package computation with reasons and confidence,
- test command suggestions and GitHub matrix output,
- deployable mapping,
- text, JSON and GitHub output formats,
- `impact doctor`,
- the local source graph cache.

The core CLI will not add paid gating, accounts, telemetry, or network requirements.

## Commercial (separate repositories, not in core)

- Policy packs (required paths/owners, exemptions, compliance audit).
- CI cost packs (historical test selection, flaky hints, sharding advice).
- Additional CI integrations beyond the generic GitHub matrix.
- Scale packs (worker parallelism, shared graph cache).
- Optional hosted dashboard that receives only user-exported JSON metadata, never source.
- Enterprise governance (SSO/SCIM, RBAC, audit logs) for hosted/enterprise editions.

Constraints on commercial work:

- It lives in separate repositories under separate licenses.
- It must not change core output semantics; it may extend through the versioned plugin interfaces.
- A commercial outage must never prevent the local CLI from working.
- No core code is forked into closed source.

## Trademarks

The project name and logos may not be used to imply endorsement of a fork or a commercial offering.
