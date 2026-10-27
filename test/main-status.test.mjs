import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { configuration, deliver, eligible, evaluate, EVALUATION_TITLE, GitHub, HistoryError, main, RECONCILE_TITLE, render, validateRun } from '../src/main-status.mjs';

const options = { repository: 'example/project', mainBranch: 'main', releaseWorkflows: [], serverUrl: 'https://github.com' };
const time = (minutes) => new Date(Date.UTC(2026, 9, 24, 0, minutes)).toISOString().replace('.000Z', 'Z');
const run = (id, created, conclusion, done = created + 1, extra = {}) => ({
  id, workflow_id: 42, run_attempt: 1, path: '.github/workflows/ci.yml', event: 'push',
  head_repository: { full_name: options.repository }, head_branch: 'main', head_sha: 'a'.repeat(40),
  created_at: time(created), updated_at: time(done), run_started_at: time(created),
  status: conclusion === null ? 'in_progress' : 'completed', conclusion,
  head_commit: { message: 'subject <@here> & details\nbody', author: { name: 'A & B' } }, ...extra,
});
function history(pages, attempts = {}) {
  const calls = [];
  return {
    calls,
    async get(path) {
      calls.push(path);
      const page = Number(new URL(`https://example.invalid/${path}`).searchParams.get('page'));
      const value = pages[page - 1] || [];
      if (value instanceof Error) throw value;
      return { workflow_runs: value };
    },
    async run(id, attempt) {
      calls.push(`${id}/${attempt}`);
      if (!attempts[`${id}/${attempt}`]) throw new Error('Attempt unreadable');
      return validateRun(attempts[`${id}/${attempt}`]);
    },
  };
}
const evaluateRuns = (target, runs, attempts, config = options) => evaluate(target, history([runs], attempts), config);

test('first failure sends red, including an empty history', async () => {
  const target = run(2, 10, 'failure');
  assert.equal((await evaluateRuns(target, [target, run(1, 0, 'success')])).kind, 'red');
  assert.equal((await evaluateRuns(target, [])).kind, 'red');
});
test('repeated failure and success stay quiet', async () => {
  for (const conclusion of ['success', 'failure']) {
    assert.equal((await evaluateRuns(run(2, 10, conclusion), [run(1, 0, conclusion)])).kind, 'none');
  }
});
test('recovery spans the whole failure streak through cancelled runs', async () => {
  const target = run(5, 120, 'success');
  const result = await evaluateRuns(target, [target, run(4, 100, 'cancelled'), run(3, 60, 'failure'), run(2, 10, 'failure'), run(1, 0, 'success')]);
  assert.deepEqual(result, { kind: 'green', minutes: 110 });
});
test('non-verdicts and incomplete runs read no history', async () => {
  for (const conclusion of ['cancelled', 'skipped', 'timed_out', 'neutral', null]) {
    const api = history([]);
    assert.equal((await evaluate(run(2, 10, conclusion), api, options)).kind, 'none');
    assert.equal(api.calls.length, 0);
  }
});
test('eligibility excludes PRs, foreign repositories and other branches from target and history', async () => {
  for (const extra of [{ event: 'pull_request' }, { event: 'pull_request_target' }, { head_branch: 'feature' }, { head_repository: { full_name: 'foreign/project' } }]) {
    const excluded = run(2, 10, 'failure', 11, extra);
    assert.equal(eligible(excluded, options), false);
    assert.equal((await evaluateRuns(excluded, [])).kind, 'none');
    assert.equal((await evaluateRuns(run(3, 20, 'success'), [excluded, run(1, 0, 'success')])).kind, 'none');
  }
});
test('release paths count tag and manual runs but exclude PR events', async () => {
  const config = { ...options, releaseWorkflows: ['.github/workflows/ci.yml'] };
  const target = run(2, 10, 'success', 11, { event: 'workflow_dispatch', head_branch: 'v2' });
  const previous = run(1, 0, 'failure', 1, { event: 'release', head_branch: 'v1' });
  assert.equal((await evaluateRuns(target, [target, previous], {}, config)).kind, 'green');
  assert.equal((await evaluateRuns({ ...target, event: 'pull_request' }, [previous], {}, config)).kind, 'none');
});
test('a configurable main branch replaces main filtering', async () => {
  const config = { ...options, mainBranch: 'trunk' };
  assert.equal((await evaluateRuns(run(1, 0, 'failure', 1, { head_branch: 'trunk' }), [], {}, config)).kind, 'red');
});
for (const [description, a, b, expected] of [
  ['older failure finishes first', run(2, 10, 'failure', 20), run(3, 15, 'failure', 30), ['red', 'none']],
  ['newer failure finishes first', run(2, 10, 'failure', 30), run(3, 15, 'failure', 20), ['none', 'red']],
  ['failure then recovery', run(2, 10, 'failure', 20), run(3, 15, 'success', 30), ['red', 'green']],
  ['old failure after newer success', run(2, 10, 'failure', 30), run(3, 15, 'success', 20), ['none', 'none']],
]) {
  test(description, async () => {
    const rows = [b, a, run(1, 0, 'success')];
    assert.deepEqual([(await evaluateRuns(a, rows)).kind, (await evaluateRuns(b, rows)).kind], expected);
  });
}
test('rerun failure to success recovers using its earlier attempt', async () => {
  const target = run(2, 10, 'success', 51, { run_attempt: 3, run_started_at: time(50) });
  const result = await evaluateRuns(target, [target, run(1, 0, 'success')], {
    '2/2': run(2, 10, 'cancelled', 40, { run_attempt: 2 }), '2/1': run(2, 10, 'failure', 20),
  });
  assert.deepEqual(result, { kind: 'green', minutes: 40 });
});
test('a rerunning predecessor retains its previous verdict', async () => {
  const target = run(3, 30, 'success', 50);
  const previous = run(2, 10, null, 40, { run_attempt: 2 });
  assert.equal((await evaluateRuns(target, [target, previous, run(1, 0, 'success')], { '2/1': run(2, 10, 'failure', 20) })).kind, 'green');
});
test('history uses earlier attempts when a later rerun finishes after the target', async () => {
  const target = run(3, 30, 'success', 50);
  const previous = run(2, 10, 'success', 60, { run_attempt: 2 });
  assert.equal((await evaluateRuns(target, [target, previous, run(1, 0, 'success')], { '2/1': run(2, 10, 'failure', 20) })).kind, 'green');
});
test('pagination crosses more than five pages without search filters', async () => {
  const target = run(9, 90, 'success', 100);
  const api = history([[target], ...[80, 70, 60, 50, 40].map((minute, index) => [run(8 - index, minute, 'cancelled')]), [run(2, 10, 'failure'), run(1, 0, 'success')]]);
  assert.equal((await evaluate(target, api, options)).kind, 'green');
  assert.equal(api.calls.length, 7);
  assert.ok(api.calls.every((call) => !/[?&](branch|event|status|created)=/.test(call)));
});
test('an earlier self attempt cannot stop scanning pages containing newer runs', async () => {
  const target = run(2, 10, 'failure', 100, { run_attempt: 2 });
  const api = history([[run(4, 40, 'cancelled')], [run(3, 30, 'failure', 50)], [target]], { '2/1': run(2, 10, 'success', 20) });
  assert.equal((await evaluate(target, api, options)).kind, 'none');
  assert.ok(api.calls.some((call) => call.includes('page=2')));
});
test('unknown history sends uncertain red and withholds recovery', async () => {
  for (const conclusion of ['failure', 'success']) {
    const promise = evaluate(run(2, 10, conclusion), history([new Error('API unavailable')]), options);
    if (conclusion === 'failure') assert.equal((await promise).uncertain, true);
    else await assert.rejects(promise, HistoryError);
  }
});
test('malformed, duplicated, unordered, and wrong-workflow histories remain unknown', async () => {
  const target = run(9, 90, 'success', 100);
  for (const api of [
    { get: async () => ({ message: 'missing' }) },
    history([[{ ...run(2, 10, 'failure'), updated_at: 'bad' }]]),
    history([[run(8, 80, 'cancelled')], [run(7, 85, 'failure')]]),
    history([[run(8, 80, 'cancelled')], [run(8, 80, 'cancelled')]]),
    history([[run(2, 10, 'failure', 20, { workflow_id: 99 })]]),
  ]) await assert.rejects(evaluate(target, api, options), HistoryError);
});
test('equal completion timestamps are unknown rather than invented ordering', async () => {
  await assert.rejects(evaluateRuns(run(3, 30, 'success', 50), [run(2, 10, 'failure', 50)]), /timestamp/);
});
test('missing or mismatched attempts cannot produce recovery', async () => {
  const target = run(2, 10, 'success', 50, { run_attempt: 2 });
  await assert.rejects(evaluateRuns(target, []), /Attempt unreadable/);
  await assert.rejects(evaluateRuns(target, [], { '2/1': run(2, 10, 'failure', 20, { event: 'pull_request' }) }), /identity/);
});
test('renderer escapes external metadata and links the exact attempt', () => {
  const text = render({ kind: 'green', minutes: 110 }, run(2, 10, 'success'), options, 'Build <name>');
  assert.match(text, /Build &lt;name&gt;/);
  assert.match(text, /&lt;@here&gt; &amp; details/);
  assert.match(text, /A &amp; B/);
  assert.match(text, /red for 1h 50m/);
  assert.match(text, /runs\/2\/attempts\/1/);
  assert.doesNotMatch(text, /\nbody/);
});
test('delivery dry run makes no network call', async () => {
  assert.match(await deliver('hello', { postForReal: false, fetchImpl: () => assert.fail('network') }), /withheld/);
});
test('delivery requires a webhook and reports Slack rejection and timeouts without exposing URLs', async () => {
  await assert.rejects(deliver('hello', { postForReal: true }), /required/);
  await assert.rejects(deliver('hello', { postForReal: true, webhook: 'secret', fetchImpl: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  await assert.rejects(deliver('hello', { postForReal: true, webhook: 'secret', fetchImpl: async () => { throw new Error('secret'); } }), (error) => !error.message.includes('secret'));
});
test('delivery sends JSON and accepts successful responses', async () => {
  const result = await deliver('hello', { postForReal: true, webhook: 'secret', fetchImpl: async (url, init) => {
    assert.equal(url, 'secret'); assert.deepEqual(JSON.parse(init.body), { text: 'hello' }); assert.equal(init.redirect, 'error');
    return { ok: true };
  } });
  assert.equal(result, 'Posted to Slack.');
});
test('automatic configuration preserves event attempt and ignores manual overrides', () => {
  const config = configuration({ POST_FOR_REAL: 'false', GITHUB_EVENT_NAME: 'workflow_run', INPUT_RUN_ID: '999' }, { workflow_run: { id: 12, run_attempt: 2 } });
  assert.equal(config.runId, 12); assert.equal(config.attempt, 2);
});
test('manual configuration rejects invalid IDs, attempts, and missing production secrets', () => {
  for (const extra of [{ INPUT_RUN_ID: '../other' }, { INPUT_RUN_ATTEMPT: '2' }, { POST_FOR_REAL: 'true' }, { POST_FOR_REAL: '' }]) {
    assert.throws(() => configuration({ POST_FOR_REAL: 'false', GITHUB_EVENT_NAME: 'workflow_dispatch', ...extra }, {}));
  }
});
// Serves recorded API bodies by path, as GitHub returns them.
const github = (responses) => new GitHub({ repository: options.repository, token: 'token', fetchImpl: async (url, init) => {
  assert.equal(init.headers.authorization, 'Bearer token');
  const path = url.slice(`https://api.github.com/repos/${options.repository}/`.length);
  if (!(path in responses)) throw new Error(`unexpected ${path}`);
  return { ok: true, json: async () => responses[path] };
} });
// A run created at minute 10 that failed, then reran at minute 30 and succeeded:
// each attempt reports its own created_at, and the run reports the first.
const rerun = {
  'actions/runs/2/attempts/1': run(2, 10, 'failure', 11),
  'actions/runs/2/attempts/2': run(2, 30, 'success', 31, { run_attempt: 2 }),
  'actions/runs/2': run(2, 10, 'success', 31, { run_attempt: 2, run_started_at: time(30) }),
};
test('GitHub reads the requested attempt and the run creation time', async () => {
  const attempt = await github(rerun).run(2, 2);
  assert.equal(attempt.run_attempt, 2);
  assert.equal(attempt.run_started_at, time(30));
  assert.equal(attempt.created_at, time(10));
  assert.equal((await github(rerun).run(2, 1)).conclusion, 'failure');
});
test('a rerun that turns a failure green recovers against the real attempt shape', async () => {
  const api = github({ ...rerun, 'actions/workflows/42/runs?per_page=100&page=1': { workflow_runs: [rerun['actions/runs/2'], run(1, 0, 'success')] } });
  assert.deepEqual(await evaluate(await api.run(2, 2), api, options), { kind: 'green', minutes: 20 });
});
test('a run created before the rerun but after the original attempt orders as newer', async () => {
  const api = github({ ...rerun, 'actions/workflows/42/runs?per_page=100&page=1': { workflow_runs: [run(3, 20, 'success', 25), rerun['actions/runs/2'], run(1, 0, 'success')] } });
  assert.deepEqual(await evaluate(await api.run(2, 2), api, options), { kind: 'none', reason: 'A newer run already held the effective verdict' });
});
test('GitHub refuses mismatched identities and API errors', async () => {
  const api = (response) => new GitHub({ repository: options.repository, token: 'token', fetchImpl: async () => response });
  await assert.rejects(api({ ok: true, json: async () => run(3, 10, 'failure') }).run(2, 1), /different run/);
  await assert.rejects(api({ ok: false, status: 403 }).get('actions/runs/2'), /HTTP 403/);
  await assert.rejects(api({ ok: true, json: async () => { throw new Error(); } }).get('actions/runs/2'), /invalid JSON/);
});
test('generated inline artifact executes a diagnostic without checkout or network', () => {
  const workflow = readFileSync(new URL('../.github/workflows/main-status.yml', import.meta.url), 'utf8');
  const block = workflow.split('        run: |\n')[1].split('\n').filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'main-status-'));
  writeFileSync(join(dir, 'event.json'), '{}');
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync('bash', ['-c', block], { encoding: 'utf8', env: {
    ...childEnv, POST_FOR_REAL: 'false', GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_RUN_ID: '', INPUT_RUN_ATTEMPT: '',
    GITHUB_REPOSITORY: options.repository, GITHUB_ACTOR: 'tester', GITHUB_RUN_ID: '123',
    GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), GH_TOKEN: 'unused', SLACK_WEBHOOK_URL: '',
  } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /test message from tester, not an alert/);
  assert.match(readFileSync(join(dir, 'summary'), 'utf8'), /diagnostic/);
});

test('a resolved edge does not inspect older irrelevant attempts', async () => {
  const target = run(9, 90, 'failure', 100);
  const api = history([[target, run(8, 80, 'success', 85), run(7, 70, 'success', 110, { run_attempt: 2 })]]);
  assert.deepEqual(await evaluate(target, api, options), { kind: 'red' });
  assert.equal(api.calls.length, 1);
});

test('deleted head repositories are excluded rather than poisoning history', async () => {
  const deleted = validateRun(run(2, 20, 'failure', 21, { head_repository: null }));
  assert.equal((await evaluateRuns(deleted, [])).kind, 'none');
  assert.equal((await evaluateRuns(run(3, 30, 'success'), [deleted, run(1, 0, 'success')])).kind, 'none');
});
test('metadata cannot inject workflow command lines into logs', () => {
  const text = render({ kind: 'red' }, run(2, 10, 'failure', 11, { head_commit: { author: { name: 'name\n::error::injected' } } }), options, 'CI\n::error::injected');
  assert.doesNotMatch(text, /\n::error::/);
});

// Self-recovery: each Main Status run is titled with the completion it evaluates, so a
// later evaluation compares against the last one that completed rather than the last edge.
const recovering = { ...options, statusWorkflow: 'main-status.yml', selfRunId: '900', reconcileWorkflows: [] };
const evaluation = (id, created, conclusion, title, extra = {}) => run(id, created, conclusion, created + 1, {
  workflow_id: 7, path: '.github/workflows/main-status.yml', event: 'workflow_run', display_title: title, ...extra,
});
const titled = (ci, created, conclusion, extra) => evaluation(800 + ci, created, conclusion, `Main Status: run ${ci} attempt 1 of workflow 42`, extra);
// Serves CI history, Main Status history and each CI run's attempt; later pages are empty.
function recorded(ciRuns, evaluations) {
  const responses = {
    'actions/workflows/42/runs?per_page=100&page=1': { workflow_runs: ciRuns },
    'actions/workflows/main-status.yml/runs?per_page=100&page=1': { workflow_runs: evaluations },
  };
  for (const ci of ciRuns) Object.assign(responses, { [`actions/runs/${ci.id}`]: ci, [`actions/runs/${ci.id}/attempts/1`]: ci });
  return new GitHub({ repository: options.repository, token: 'token', fetchImpl: async (url) => {
    const path = url.slice(`https://api.github.com/repos/${options.repository}/`.length);
    if (path in responses) return { ok: true, json: async () => responses[path] };
    if (/\/runs\?per_page=100&page=\d+$/.test(path)) return { ok: true, json: async () => ({ workflow_runs: [] }) };
    throw new Error(`unexpected ${path}`);
  } });
}
const self = evaluation(900, 22, null, 'Main Status: run 3 attempt 1 of workflow 42');

test('a red whose evaluation was lost is sent at the next failure', async () => {
  const ci = [run(3, 20, 'failure'), run(2, 10, 'failure'), run(1, 0, 'success')];
  const api = recorded(ci, [self, titled(2, 12, 'failure'), titled(1, 2, 'success')]);
  assert.deepEqual(await evaluate(ci[0], api, recovering), { kind: 'red', late: true });
});
test('a recovery whose evaluation was lost is sent at the next success', async () => {
  const ci = [run(3, 20, 'success'), run(2, 10, 'success'), run(1, 0, 'failure')];
  const api = recorded(ci, [self, titled(2, 12, 'failure'), titled(1, 2, 'success')]);
  assert.deepEqual(await evaluate(ci[0], api, recovering), { kind: 'green', late: true });
});
test('an evaluation that never started is lost like one that failed', async () => {
  const ci = [run(3, 20, 'success'), run(2, 10, 'success'), run(1, 0, 'failure')];
  const blocked = titled(2, 12, 'failure', { run_started_at: time(12) });
  assert.equal((await evaluate(ci[0], recorded(ci, [self, blocked, titled(1, 2, 'success')]), recovering)).late, true);
});
test('a completed evaluation is not repeated', async () => {
  const ci = [run(3, 20, 'success'), run(2, 10, 'success'), run(1, 0, 'failure')];
  const api = recorded(ci, [self, titled(2, 12, 'success'), titled(1, 2, 'success')]);
  assert.deepEqual(await evaluate(ci[0], api, recovering), { kind: 'none', reason: 'No failure to recover from' });
});
test('an unfinished evaluation counts as settled, so a recovery after it is not late', async () => {
  const ci = [run(3, 20, 'success'), run(2, 10, 'failure'), run(1, 0, 'success')];
  const api = recorded(ci, [self, titled(2, 12, null), titled(1, 2, 'success')]);
  assert.deepEqual(await evaluate(ci[0], api, recovering), { kind: 'green', minutes: 10 });
});
test('a reconcile stays quiet for a completion a later or repeated evaluation settled', async () => {
  const ci = [run(3, 20, 'failure'), run(2, 10, 'success'), run(1, 0, 'failure')];
  const reconciling = { ...recovering, reconcile: true, selfRunId: '901' };
  assert.deepEqual(await evaluate(ci[1], recorded(ci, [titled(3, 22, 'success'), titled(1, 2, 'success')]), reconciling),
    { kind: 'none', reason: 'A later evaluation already settled this workflow' });
  assert.equal((await evaluate(ci[0], recorded(ci, [titled(3, 22, 'success'), titled(1, 2, 'success')]), reconciling)).kind, 'none');
});
test('an evaluation answers for its completion even when a later one already ran', async () => {
  const ci = [run(3, 20, 'failure'), run(2, 10, 'success'), run(1, 0, 'failure')];
  const api = recorded(ci, [titled(3, 22, 'success'), titled(2, 12, 'success'), titled(1, 2, 'success')]);
  assert.deepEqual(await evaluate(ci[1], api, { ...recovering, selfRunId: '802' }), { kind: 'green', minutes: 10 });
});
test('two completions evaluated concurrently send both red and recovery', async () => {
  // Run 1's settled success is what a recovery would wrongly compare with if run 2's
  // unfinished evaluation were not counted as settled.
  const ci = [run(3, 10, 'success', 13), run(2, 5, 'failure', 11), run(1, 0, 'success', 1)];
  const all = [titled(3, 14, null), titled(2, 12, null), titled(1, 2, 'success')];
  assert.deepEqual(await evaluate(ci[1], recorded(ci, all), { ...recovering, selfRunId: '802' }), { kind: 'red' });
  assert.deepEqual(await evaluate(ci[0], recorded(ci, all), { ...recovering, selfRunId: '803' }), { kind: 'green', minutes: 5 });
});
test('a settled completion tied with the target keeps the order unknown', async () => {
  const ci = [run(3, 20, 'success', 30), run(2, 10, 'failure', 30), run(1, 0, 'success')];
  await assert.rejects(evaluate(ci[0], recorded(ci, [self, titled(2, 31, 'success'), titled(1, 2, 'success')]), recovering), /timestamp/);
});
test('a later manual evaluation of an old completion does not move the comparison back', async () => {
  const ci = [run(4, 30, 'failure'), run(3, 20, 'success'), run(2, 10, 'failure'), run(1, 0, 'success')];
  const redispatch = evaluation(860, 25, 'success', 'Main Status: run 2 attempt 1 of workflow ');
  const api = recorded(ci, [evaluation(900, 32, null, 'Main Status: run 4 attempt 1 of workflow 42'), redispatch, titled(3, 22, 'success'), titled(2, 12, 'success')]);
  assert.deepEqual(await evaluate(ci[0], api, recovering), { kind: 'red' });
});
test('a late notification names the newer run that holds the verdict', async () => {
  const ci = [run(3, 10, 'failure', 12), run(2, 5, 'success', 20), run(1, 0, 'success', 1)];
  const api = recorded(ci, [evaluation(900, 21, null, 'Main Status: run 2 attempt 1 of workflow 42'), titled(3, 13, 'failure'), titled(1, 2, 'success')]);
  const result = await evaluate(ci[1], api, recovering);
  assert.deepEqual([result.kind, result.late, result.run?.id], ['red', true, 3]);
});
test('a first reconcile over untitled history stays quiet', async () => {
  const ci = [run(2, 10, 'success'), run(1, 0, 'failure')];
  const api = recorded(ci, [evaluation(850, 12, 'success', 'Main Status')]);
  assert.deepEqual(await evaluate(ci[0], api, { ...recovering, reconcile: true }), { kind: 'none', reason: 'No titled evaluation to compare with' });
});
test('an ineligible titled evaluation costs one read and is skipped', async () => {
  const ci = [run(3, 20, 'failure'), run(2, 10, 'failure'), run(1, 0, 'success')];
  const pr = run(5, 15, 'failure', 16, { event: 'pull_request', head_branch: 'feature' });
  const reads = [];
  const api = recorded([...ci, pr], [self, titled(5, 17, 'success'), titled(2, 12, 'failure'), titled(1, 2, 'success')]);
  const original = api.fetch; api.fetch = async (url, init) => { reads.push(url); return original(url, init); };
  assert.deepEqual(await evaluate(ci[0], api, recovering), { kind: 'red', late: true });
  assert.equal(reads.filter((url) => /actions\/runs\/5(\/|$)/.test(url)).length, 1);
});
test('evaluations of other workflows, rehearsals and unparsed titles are skipped without reads', async () => {
  const ci = [run(3, 20, 'failure'), run(2, 10, 'failure'), run(1, 0, 'success')];
  const others = [
    evaluation(851, 15, 'success', 'Main Status: run 99 attempt 1 of workflow 5'),
    evaluation(852, 14, 'success', 'Main Status: rehearsal'),
    evaluation(853, 13, 'success', 'Main Status: run  attempt  of workflow '),
  ];
  const api = recorded(ci, [self, ...others, titled(2, 12, 'failure'), titled(1, 2, 'success')]);
  assert.deepEqual(await evaluate(ci[0], api, recovering), { kind: 'red', late: true });
});
test('a dispatch title without a workflow id is resolved by reading its run', async () => {
  const ci = [run(3, 20, 'success'), run(2, 10, 'success'), run(1, 0, 'failure')];
  const dispatched = evaluation(860, 30, 'success', 'Main Status: run 2 attempt 1 of workflow ');
  assert.equal((await evaluate(ci[0], recorded(ci, [self, dispatched, titled(2, 12, 'failure')]), recovering)).kind, 'none');
});
test('history before titled evaluations falls back to the immediate predecessor', async () => {
  const ci = [run(3, 20, 'failure'), run(2, 10, 'failure'), run(1, 0, 'success')];
  const api = recorded(ci, [self, evaluation(850, 12, 'failure', 'Main Status'), titled(1, 2, 'success')]);
  assert.deepEqual(await evaluate(ci[0], api, recovering), { kind: 'none', reason: 'Workflow remains red' });
});
test('a reconcile settles the workflows it lists', async () => {
  const ci = [run(3, 20, 'failure'), run(2, 10, 'success')];
  const reconciled = evaluation(870, 25, 'success', 'Main Status: reconcile');
  const listed = { ...recovering, reconcileWorkflows: ['.github/workflows/ci.yml'] };
  assert.equal((await evaluate(ci[0], recorded(ci, [self, reconciled]), { ...listed, reconcile: true })).reason, 'A later evaluation already settled this workflow');
  const lost = [run(3, 20, 'failure'), run(2, 10, 'failure'), run(1, 0, 'success')];
  const history = [self, titled(2, 12, 'failure'), evaluation(871, 5, 'success', 'Main Status: reconcile')];
  assert.deepEqual(await evaluate(lost[0], recorded(lost, history), listed), { kind: 'red', late: true });
  assert.deepEqual(await evaluate(lost[0], recorded(lost, history), recovering), { kind: 'none', reason: 'Workflow remains red' });
});
test('renderer marks a late notification and omits an unknown red duration', () => {
  const text = render({ kind: 'green', late: true }, run(2, 10, 'success'), options, 'CI');
  assert.match(text, /CI is green again \(late: an earlier evaluation did not complete\)\n/);
  assert.match(render({ kind: 'red', late: true }, run(2, 10, 'failure'), options, 'CI'), /CI failed \(late: /);
});
test('configuration reads the status workflow and requires a reconcile list on schedule', () => {
  const env = { POST_FOR_REAL: 'false', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_RUN_ID: '900',
    STATUS_WORKFLOW_REF: 'example/project/.github/workflows/main-status.yml@refs/heads/main' };
  const config = configuration(env, { workflow_run: { id: 3, run_attempt: 1 } });
  assert.equal(config.statusWorkflow, 'main-status.yml'); assert.equal(config.selfRunId, '900');
  assert.throws(() => configuration({ ...env, GITHUB_EVENT_NAME: 'schedule' }, {}), /reconcile_workflows/);
  const scheduled = configuration({ ...env, GITHUB_EVENT_NAME: 'schedule', RECONCILE_WORKFLOWS: 'a.yml, b.yml', POST_FOR_REAL: 'true', SLACK_WEBHOOK_URL: 'x' }, {});
  assert.deepEqual([scheduled.reconcile, scheduled.reconcileWorkflows, scheduled.runId], [true, ['a.yml', 'b.yml'], '']);
});
test('a scheduled reconcile sends the lost recovery of each listed workflow', async () => {
  const ci = [run(3, 20, 'success'), run(2, 10, 'success'), run(1, 0, 'failure')];
  const api = recorded(ci, [titled(3, 22, 'failure'), titled(2, 12, 'failure'), titled(1, 2, 'success')]);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => url.endsWith('/actions/workflows/ci.yml')
    ? { ok: true, json: async () => ({ id: 42, name: 'CI' }) } : api.fetch(url, init);
  const dir = mkdtempSync(join(tmpdir(), 'main-status-'));
  writeFileSync(join(dir, 'event.json'), '{}');
  try {
    assert.deepEqual(await main({ POST_FOR_REAL: 'false', GITHUB_EVENT_NAME: 'schedule', GITHUB_RUN_ID: '900', GH_TOKEN: 'token',
      GITHUB_REPOSITORY: options.repository, GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      RECONCILE_WORKFLOWS: '.github/workflows/ci.yml', STATUS_WORKFLOW_REF: 'example/project/.github/workflows/main-status.yml@refs/heads/main' }),
    { kind: 'reconcile' });
  } finally { globalThis.fetch = original; }
  assert.match(readFileSync(join(dir, 'summary'), 'utf8'), /ci\.yml: green \(late\)\. Slack post withheld/);
});
test('the README caller titles runs in the forms the evaluator parses', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const evaluated = /format\('(Main Status: run \{0\} attempt \{1\} of workflow \{2\})'/.exec(readme)?.[1];
  assert.ok(evaluated, 'README run-name lost its evaluation title');
  assert.match(evaluated.replace('{0}', '12').replace('{1}', '3').replace('{2}', '42'), EVALUATION_TITLE);
  assert.match(evaluated.replace('{0}', '12').replace('{1}', '3').replace(' {2}', ''), EVALUATION_TITLE);
  assert.ok(readme.includes(`'${RECONCILE_TITLE}'`), 'README run-name lost its reconcile title');
});
