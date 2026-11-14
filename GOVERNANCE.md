# Governance

## Roles

- Maintainers: merge code, cut releases, enforce the Code of Conduct, respond to security reports.
- Contributors: anyone who opens an issue, PR, discussion, or documentation change.

## Decisions

1. Small changes (fixes, docs, tests): any maintainer may merge after a green CI.
2. Behavior changes (output schema, defaults, CLI flags): require a short proposal in an issue and
   approval from at least two maintainers.
3. Scope changes (new core capabilities): must satisfy the scope guard in `CONTRIBUTING.md` and be
   added to the roadmap before implementation.

Disagreements are settled by discussion first, then by maintainer vote. A tie defaults to keeping
the status quo.

## Scope freeze

The core scenario is frozen to change-impact analysis of JS/TS workspace monorepos. New capabilities
that do not directly serve diff -> impact analysis go to the roadmap backlog or an external package.
The freeze exists to keep the core small, auditable, and dependency-light.

## Conflicts of interest

- Maintainers with a financial or personal interest in a decision must disclose it and recuse
  themselves from the vote.
- Code of Conduct reports involving a maintainer are handled by the remaining maintainers only.

## Information visibility

- Conduct reports are private to the maintainers handling the case.
- Security reports are private until a fix is available.

## Changes to this document

Governance changes follow the "behavior changes" process: proposal + two-maintainer approval.
