import { appendFileSync, readFileSync } from 'node:fs';

const verdict = (run) => ['success', 'failure'].includes(run.conclusion);
const positiveId = (value) => /^[1-9][0-9]*$/.test(String(value));
const sameRepo = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) && Number.isFinite(Date.parse(value));
const compare = (a, b) => a.created_at.localeCompare(b.created_at) || Math.sign(a.id - b.id);
const escapeSlack = (value) => String(value).replaceAll(/[\r\n]/g, ' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export class HistoryError extends Error {}

export function validateRun(run) {
  if (!run || !Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isSafeInteger(run.workflow_id) ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
      !timestamp(run.created_at) || !timestamp(run.updated_at) || !timestamp(run.run_started_at) ||
      typeof run.path !== 'string' || typeof run.head_branch !== 'string' ||
      typeof run.event !== 'string' || (run.head_repository !== null && typeof run.head_repository?.full_name !== 'string') ||
      !/^[a-f0-9]{40}$/i.test(run.head_sha) ||
      !['completed', 'queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(run.status) ||
      !(run.conclusion === null || typeof run.conclusion === 'string')) {
    throw new Error('Malformed workflow run; cannot establish its identity or timestamps');
  }
  return run;
}

export function eligible(run, { repository, mainBranch, releaseWorkflows }) {
  return sameRepo(run.head_repository?.full_name, repository) &&
    !['pull_request', 'pull_request_target'].includes(run.event) &&
    (releaseWorkflows.includes(run.path) || run.head_branch === mainBranch);
}

export class GitHub {
  constructor({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid caller repository');
    if (!token) throw new Error('GitHub token is required');
    this.base = `${apiUrl.replace(/\/$/, '')}/repos/${repository}`;
    this.token = token;
    this.fetch = fetchImpl;
  }
  async get(path) {
    let response;
    try {
      response = await this.fetch(`${this.base}/${path}`, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    } catch { throw new Error('GitHub API request failed or timed out'); }
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
    try { return await response.json(); }
    catch { throw new Error('GitHub API returned invalid JSON'); }
  }
  async run(id, attempt) {
    const run = validateRun(await this.get(`actions/runs/${id}${attempt ? `/attempts/${attempt}` : ''}`));
    if (String(run.id) !== String(id) || (attempt && String(run.run_attempt) !== String(attempt))) {
      throw new Error('GitHub returned a different run or attempt');
    }
    return run;
  }
}

async function verdictBefore(run, target, api) {
  if (verdict(run) && run.updated_at < target.updated_at) return run;
  if (verdict(run) && run.updated_at === target.updated_at) {
    throw new HistoryError('Completions share a timestamp; their order is unknown');
  }
  for (let attempt = run.run_attempt - 1; attempt >= 1; attempt--) {
    const earlier = await api.run(run.id, attempt);
    if (earlier.workflow_id !== run.workflow_id || compare(earlier, run) !== 0 ||
        earlier.path !== run.path || earlier.event !== run.event ||
        earlier.head_repository.full_name !== run.head_repository.full_name) {
      throw new HistoryError('Attempt identity changed');
    }
    if (verdict(earlier) && earlier.updated_at === target.updated_at) {
      throw new HistoryError('Attempts share a completion timestamp');
    }
    if (verdict(earlier) && earlier.updated_at < target.updated_at) return earlier;
  }
  return null;
}

export async function evaluate(target, api, options) {
  if (!eligible(target, options) || target.status !== 'completed' || !verdict(target)) {
    return { kind: 'none', reason: 'Run is outside scope or has no completed verdict' };
  }
  try {
    const predecessors = [];
    if (target.run_attempt > 1) {
      const previous = await verdictBefore({ ...target, conclusion: null }, target, api);
      if (previous) predecessors.push(previous);
    }
    let floor = null;
    const seen = new Set();
    const enough = () => predecessors.length &&
      (target.conclusion === 'failure' || predecessors.some((run) => run.conclusion === 'success'));
    history: for (let page = 1; ; page++) {
      const body = await api.get(`actions/workflows/${target.workflow_id}/runs?per_page=100&page=${page}`);
      if (!Array.isArray(body.workflow_runs)) throw new HistoryError('History has no workflow_runs array');
      if (!body.workflow_runs.length) break;
      const runs = body.workflow_runs.map(validateRun).sort((a, b) => compare(b, a));
      if (floor && compare(runs[0], floor) > 0) throw new HistoryError('History pages are not newest first');
      floor = runs.at(-1);
      for (const run of runs) {
        if (seen.has(run.id)) throw new HistoryError('History repeats a run across pages');
        seen.add(run.id);
        if (run.workflow_id !== target.workflow_id) throw new HistoryError('History contains another workflow');
        if (compare(run, target) <= 0 && enough()) break history;
        if (run.id === target.id || !eligible(run, options)) continue;
        const previous = await verdictBefore(run, target, api);
        if (!previous) continue;
        if (compare(run, target) > 0) return { kind: 'none', reason: 'A newer run already held the effective verdict' };
        predecessors.push(previous);
        if (enough()) break history;
      }
      predecessors.sort((a, b) => compare(b, a));
      if (compare(floor, target) <= 0 && enough()) break;
    }
    predecessors.sort((a, b) => compare(b, a));
    const previous = predecessors[0];
    if (target.conclusion === 'failure') {
      return previous?.conclusion === 'failure' ? { kind: 'none', reason: 'Workflow remains red' } : { kind: 'red' };
    }
    if (previous?.conclusion !== 'failure') return { kind: 'none', reason: 'No failure to recover from' };
    const streak = [];
    for (const run of predecessors) {
      if (run.conclusion === 'success') break;
      streak.push(run);
    }
    const minutes = Math.floor((Date.parse(target.run_started_at) - Date.parse(streak.at(-1).created_at)) / 60_000);
    if (minutes < 0) throw new HistoryError('Recovery duration would be negative');
    return { kind: 'green', minutes };
  } catch (error) {
    if (target.conclusion === 'failure') return { kind: 'red', uncertain: true, reason: error.message };
    throw new HistoryError(`Previous verdict unknown; recovery withheld: ${error.message}`);
  }
}

export function render(result, run, { repository, serverUrl, mainBranch, releaseWorkflows }, workflowName) {
  if (result.kind === 'none') return '';
  const scope = releaseWorkflows.includes(run.path) ? 'release' : mainBranch;
  const duration = result.minutes >= 60 ? `${Math.floor(result.minutes / 60)}h ${result.minutes % 60}m` : `${result.minutes}m`;
  const headline = result.kind === 'red'
    ? `🚨 ${repository.split('/')[1]}: ${escapeSlack(scope)} is red: ${escapeSlack(workflowName)} failed${result.uncertain ? ' (previous verdict unread)' : ''}`
    : `✅ ${repository.split('/')[1]}: ${escapeSlack(workflowName)} is green again (red for ${duration})`;
  const commit = `<${serverUrl}/${repository}/commit/${run.head_sha}|${run.head_sha.slice(0, 8)}>`;
  const subject = escapeSlack((run.head_commit?.message || '').split('\n')[0]);
  const author = escapeSlack(run.head_commit?.author?.name || 'unknown');
  const runUrl = `${serverUrl}/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  return `${headline}\n${commit} on ${escapeSlack(run.head_branch)} by ${author}: ${subject}\n<${runUrl}|the run>`;
}

export async function deliver(text, { postForReal, webhook, fetchImpl = fetch }) {
  if (!postForReal) return 'Slack post withheld (rehearsal).';
  if (!webhook) throw new Error('Slack webhook is required when post_for_real is true');
  let response;
  try {
    response = await fetchImpl(webhook, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
  } catch { throw new Error('Slack request failed or timed out; delivery is unconfirmed'); }
  if (!response.ok) throw new Error(`Slack rejected the notification (HTTP ${response.status})`);
  return 'Posted to Slack.';
}

export function configuration(env, event) {
  if (!['true', 'false'].includes(env.POST_FOR_REAL)) throw new Error('Invalid post_for_real boolean');
  if (env.POST_FOR_REAL === 'true' && !env.SLACK_WEBHOOK_URL) throw new Error('Slack webhook is required when post_for_real is true');
  const automatic = env.GITHUB_EVENT_NAME === 'workflow_run';
  const runId = automatic ? event.workflow_run?.id : env.INPUT_RUN_ID;
  const attempt = automatic ? event.workflow_run?.run_attempt : env.INPUT_RUN_ATTEMPT;
  if (runId && !positiveId(runId)) throw new Error('run_id must be a positive integer');
  if (attempt && (!runId || !positiveId(attempt))) throw new Error('run_attempt requires a run_id and must be a positive integer');
  if (automatic && (!runId || !attempt)) throw new Error('Completion event lacks run ID or attempt');
  if (!automatic && env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && env.POST_FOR_REAL === 'true') {
    throw new Error('Posting requires workflow_run or workflow_dispatch');
  }
  return {
    repository: env.GITHUB_REPOSITORY, mainBranch: env.MAIN_BRANCH || 'main',
    serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
    releaseWorkflows: (env.RELEASE_WORKFLOWS || '').split(',').map((path) => path.trim()).filter(Boolean),
    runId, attempt, postForReal: env.POST_FOR_REAL === 'true', webhook: env.SLACK_WEBHOOK_URL,
  };
}

export async function main(env = process.env) {
  const summary = (text) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); };
  try {
    const options = configuration(env, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')));
    const api = new GitHub({ repository: options.repository, token: env.GH_TOKEN, apiUrl: env.GITHUB_API_URL });
    let text;
    let result;
    if (!options.runId) {
      result = { kind: 'diagnostic' };
      text = `🧪 ${escapeSlack(options.repository.split('/')[1])}: Main Status test message from ${escapeSlack(env.GITHUB_ACTOR || 'unknown')}, not an alert\n<${options.serverUrl}/${options.repository}/actions/runs/${env.GITHUB_RUN_ID}|this run>`;
    } else {
      const run = await api.run(options.runId, options.attempt);
      result = await evaluate(run, api, options);
      if (result.kind === 'none') {
        console.log(result.reason);
        summary(`Main Status: ${result.reason}`);
        return result;
      }
      const workflow = await api.get(`actions/workflows/${run.workflow_id}`);
      if (typeof workflow.name !== 'string') throw new Error('Workflow name is missing');
      text = render(result, run, options, workflow.name);
    }
    console.log(text);
    const delivery = await deliver(text, options);
    console.log(delivery);
    if (result.uncertain) console.log(`::warning::${result.reason.replaceAll(/[\r\n]/g, ' ')}`);
    summary(`Main Status: ${result.kind}${result.uncertain ? ' (previous verdict unknown)' : ''}. ${delivery}`);
    return result;
  } catch (error) {
    summary(`Main Status failed: ${error.message}`);
    throw error;
  }
}
