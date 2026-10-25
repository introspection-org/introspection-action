# introspection-action

This public GitHub repository owns shared GitHub automation. Keep private repository names, private issues, Slack links, credentials, and agent attribution out of tracked files, commits, and public PRs.

`src/main-status.mjs` owns evaluation and delivery. `src/main-status.workflow.yml` owns the reusable interface. `.github/workflows/main-status.yml` is generated: edit the sources, run `npm run generate`, and commit the result. CI checks reproducibility.

Keep caller workflow subscriptions in callers. Do not execute a monitored commit or consume its artifacts or caches. Preserve exact run attempts on automatic events, keep secrets out of logs, and test changes to ordering and eligibility against the existing regression cases.

Use Node.js 24 or newer with built-in modules. Run `npm test`, `npm run check`, and `actionlint` on workflow changes. Read `README.md` for the interface, failure behavior, delivery limits, and rollback procedure. Use Conventional Commits for commit messages and PR titles. Leave merges to a maintainer.
