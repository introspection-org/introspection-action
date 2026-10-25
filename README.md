# introspection-action

Shared GitHub automation with a reusable Main Status workflow. Callers own their workflow subscriptions; the shared workflow evaluates status transitions and sends Slack notifications.

## Main Status caller

Keep this workflow on the caller's default branch. Replace `RELEASE_TAG` with a release tag, such as `v0.1.0`.

```yaml
name: Main Status
on:
  workflow_run:
    workflows: [CI, Release]
    types: [completed]
  workflow_dispatch:
    inputs:
      run_id:
        type: string
        required: false
      run_attempt:
        type: string
        required: false
      post_for_real:
        type: boolean
        default: false
permissions:
  actions: read
jobs:
  alert:
    uses: introspection-org/introspection-action/.github/workflows/main-status.yml@RELEASE_TAG
    with:
      run_id: ${{ inputs.run_id || '' }}
      run_attempt: ${{ inputs.run_attempt || '' }}
      post_for_real: ${{ github.event_name == 'workflow_run' || inputs.post_for_real == true }}
    secrets:
      slack_webhook_url: ${{ secrets.MAIN_STATUS_SLACK_WEBHOOK_URL }}
```

The caller's Actions settings must allow this public reusable workflow. Its token needs only `actions: read`; no personal access token or caller checkout is needed. Pass the webhook explicitly. The workflow does not inherit other secrets or execute monitored code, artifacts, or caches.

## Interface

| Input or secret | Default | Contract |
| --- | --- | --- |
| `run_id` | Empty | Manual override. Empty manual invocation emits a diagnostic marked as a test. Automatic completion events use their own run ID. |
| `run_attempt` | Empty | Manual attempt override. Empty selects the latest attempt. Automatic completion events use their original attempt even after a later rerun. |
| `main_branch` | `main` | Branch counted for mainline workflows. |
| `release_workflows` | Empty | Comma-separated workflow file paths. These workflows count non-PR runs on any branch or tag. Use only for workflows dedicated to publishing releases. |
| `post_for_real` | `false` | Rehearsals print the notification without sending it. Posting requires a nonempty webhook, including invocations with no transition. |
| Secret `slack_webhook_url` | Empty | Required at runtime when posting is enabled; optional for rehearsals. |

API requests use the caller's `github.repository`, `github.token`, and API server. Generated links use the caller's GitHub server URL. Only completed `success` and `failure` conclusions carry verdicts; cancelled, timed-out, skipped, and other conclusions do not. PR events and foreign head repositories are excluded from both the target and history. Release Please remains mainline unless explicitly classified otherwise.

## Transition semantics

A workflow's effective verdict is the last verdict-bearing attempt of its newest-created eligible run at the time being evaluated. Creation time and then run ID order runs; the attempt's `updated_at` orders completions. An older run completing after a newer run already holds a verdict changes nothing. A rerun retains its last verdict until another attempt reaches a verdict.

The evaluator reconstructs the state before the triggering attempt completed. Failure after success or no prior verdict sends red; failure after failure stays quiet. Success after failure sends recovery; success without a preceding failure stays quiet. Each workflow has its own state. Publishing workflows maintain a state across their releases, rather than one state per tag.

Recovery duration measures from the creation of the earliest run in the failure streak to the recovering attempt's start. It preserves that run-based measure rather than claiming elapsed time between failure and recovery completion.

History is traversed without GitHub search filters or a fixed page-count limit. Unreadable or malformed history, repeated or out-of-order pages, missing attempts, and tied completion timestamps produce unknown state. A known failing target sends red labelled `previous verdict unread`; a successful target fails evaluation without sending an unverified recovery. A delivered uncertain red leaves the job successful with a warning. Failure to fetch the target or workflow metadata fails the job. Slack rejection or timeout fails the job, while a successfully delivered build-failure notification leaves the job successful.

Delivery has no durable deduplication or ordering guarantee. Retrying an evaluation can repeat a notification, and delayed evaluations can deliver historical edges out of order. Do not use a concurrency group that replaces pending evaluations, because it can discard an edge. GitHub history retention and API availability limit historical reconstruction.

## Development

Use Node.js 24 or newer. There are no npm dependencies.

```bash
npm test
npm run generate
npm run check
actionlint .github/workflows/main-status.yml .github/workflows/test.yml
```

Edit `src/main-status.mjs` and `src/main-status.workflow.yml`, then regenerate `.github/workflows/main-status.yml`. The generated workflow embeds the source as an inline Node module so its code and workflow share one revision. CI rejects generated-file drift and exercises a reusable diagnostic with posting disabled.

Replay a real workflow through the evaluator using an authenticated `gh` session:

```bash
node scripts/replay.mjs owner/repo RUN_ID [RUN_ATTEMPT]
```

Set `MAIN_BRANCH` or `RELEASE_WORKFLOWS` for a caller with those overrides. Replay prints its verdict and notification without posting to Slack. Unit tests use synthetic histories; a replay checks the real API shape and workflow history.

## Versioning and rollback

Callers pin a release tag. Release Please keeps a release PR open from the Conventional Commits on `main`, and merging it creates the `vX.Y.Z` tag and GitHub release; a caller can reference a tag only after it exists. Changes to inputs, verdict semantics, or notification behavior require review and tests before callers move to the new tag. A rollback restores the caller's previous tag.

Configure branch protection and required review through GitHub settings before adopting this workflow broadly. Those settings are separate from the workflow files.
