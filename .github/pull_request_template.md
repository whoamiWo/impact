# Pull request checklist

- [ ] I ran `npm run build && npm test` and both pass.
- [ ] Commits are signed off (`git commit -s`, DCO).
- [ ] Behavior changes have matching tests (unit or e2e).
- [ ] Docs updated for CLI flags, config or output schema changes.

Documentation wording checklist (required for any doc change):

- [ ] No absolute claims (no "fastest", "only", "zero false positives", "production-ready").
- [ ] No unverified performance numbers; any number links to a reproducible benchmark.
- [ ] No disparagement or speculation about other tools.
- [ ] Limitations and the local-first/no-telemetry promise remain accurate.
- [ ] Experimental features are labeled `experimental`.
