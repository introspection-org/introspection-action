import { appendFileSync, readFileSync } from 'node:fs';

// A run that failed, timed out or never started leaves the branch red; GitHub sends no
// completion event for one that never started, so only a reconcile finds it.
const red = (run) => ['failure', 'timed_out', 'startup_failure'].includes(run?.conclusion);
const verdict = (run) => run.conclusion === 'success' || red(run);
const positiveId = (value) => /^[1-9][0-9]*$/.test(String(value));
const sameRepo = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) && Number.isFinite(Date.parse(value));
const compare = (a, b) => a.created_at.localeCompare(b.created_at) || Math.sign(a.id - b.id);
// One line, so external text cannot start a workflow command or a Slack line of its own.
const oneLine = (value) => String(value).replaceAll(/[\r\n]/g, ' ');
const escapeSlack = (value) => oneLine(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const list = (value) => (value || '').split(',').map((item) => item.trim()).filter(Boolean);

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
    this.cache = new Map();
  }
  // One read per path for the life of a job: completed runs and attempts do not change,
  // and every evaluation in one job should see the same history.
  get(path) {
    if (!this.cache.has(path)) this.cache.set(path, this.read(path));
    return this.cache.get(path);
  }
  async read(path) {
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
    if (!attempt) return run;
    // An attempt reports its own creation time, while history reports the run's.
    // Runs are ordered and attempts matched by the run's creation time.
    const latest = validateRun(await this.get(`actions/runs/${id}`));
    if (latest.id !== run.id || latest.workflow_id !== run.workflow_id) {
      throw new Error('GitHub returned a different run or attempt');
    }
    return { ...run, created_at: latest.created_at };
  }
  async workflow(ref) {
    const workflow = await this.get(`actions/workflows/${ref}`);
    if (!Number.isSafeInteger(workflow?.id) || typeof workflow.name !== 'string') throw new Error('Workflow identity is missing');
    return workflow;
  }
}

// The caller names each Main Status run after what it evaluates, so a later run can
// tell which completions an earlier evaluation settled.
export const EVALUATION_TITLE = /^Main Status: run (\d*) attempt (\d*) of workflow ?(\d*)$/;
export const RECONCILE_TITLE = 'Main Status: reconcile';
const UNTITLED = 'Main Status';

// One workflow's runs, newest created first, each page read once per evaluation.
class History {
  constructor(api, workflow, workflowId) {
    Object.assign(this, { api, workflow, workflowId, pages: [], seen: new Set(), done: false });
  }
  async page(index) {
    while (this.pages.length <= index && !this.done) {
      const body = await this.api.get(`actions/workflows/${this.workflow}/runs?per_page=100&page=${this.pages.length + 1}`);
      if (!Array.isArray(body.workflow_runs)) throw new HistoryError('History has no workflow_runs array');
      if (!body.workflow_runs.length) { this.done = true; break; }
      const runs = body.workflow_runs.map(validateRun).sort((a, b) => compare(b, a));
      const floor = this.pages.at(-1)?.at(-1);
      if (floor && compare(runs[0], floor) > 0) throw new HistoryError('History pages are not newest first');
      for (const run of runs) {
        if (this.seen.has(run.id)) throw new HistoryError('History repeats a run across pages');
        this.seen.add(run.id);
        if (this.workflowId !== null && run.workflow_id !== this.workflowId) throw new HistoryError('History contains another workflow');
      }
      this.pages.push(runs);
    }
    return this.pages[index];
  }
  // Yields every run, with `event` standing in for its own run and inserted if history lacks it.
  async *runs(event = null) {
    let pending = event;
    for (let index = 0; ; index++) {
      const page = await this.page(index);
      if (!page) break;
      for (const run of page) {
        if (pending && compare(pending, run) >= 0) { yield pending; pending = null; }
        if (run.id !== event?.id) yield run;
      }
    }
    if (pending) yield pending;
  }
}

// A point in a workflow's history: completions up to `at` count, and `event`'s own attempt
// counts only when `inclusive`. Any other completion at exactly `at` has an unknown order.
async function verdictAt(run, point, api) {
  const own = point.event !== null && run.id === point.event.id;
  if (own && point.inclusive) return point.event;
  let current = run;
  let counts = !own;
  for (;;) {
    if (counts && verdict(current) && current.updated_at < point.at) return current;
    if (counts && verdict(current) && current.updated_at === point.at) {
      throw new HistoryError(current === run ? 'Completions share a timestamp; their order is unknown' : 'Attempts share a completion timestamp');
    }
    counts = true;
    if (current.run_attempt <= 1) return null;
    const earlier = await api.run(run.id, current.run_attempt - 1);
    if (earlier.workflow_id !== run.workflow_id || compare(earlier, run) !== 0 ||
        earlier.path !== run.path || earlier.event !== run.event ||
        earlier.head_repository.full_name !== run.head_repository.full_name) {
      throw new HistoryError('Attempt identity changed');
    }
    current = earlier;
  }
}

// The effective verdict at a point: the newest-created eligible run that held a verdict then.
async function effectiveAt(history, point, api, options) {
  for await (const run of history.runs(point.event)) {
    if (!eligible(run, options)) continue;
    const held = await verdictAt(run, point, api);
    if (held) return { run, held };
  }
  return null;
}

// Evaluations of this workflow, other than this one, that completed or may still complete:
// successful or unfinished Main Status runs, read by title. `before` is the one settling the
// latest state strictly before `target` completed; `covered` says whether one settles a state
// at or after it. An evaluation is created after the completion it settles, and a reconcile
// settles the state at its creation, so the scan stops once runs are older than `before`.
async function settledPoints(target, api, options) {
  const found = { before: null, covered: false };
  if (!options.statusWorkflow) return found;
  const evaluations = new History(api, options.statusWorkflow, null);
  for await (const run of evaluations.runs()) {
    if (found.before && run.created_at < found.before.at) break;
    if (String(run.id) === String(options.selfRunId)) continue;
    if (run.display_title === UNTITLED) break;
    if (run.status === 'completed' && run.conclusion !== 'success') continue;
    let point;
    if (run.display_title === RECONCILE_TITLE) {
      if (!options.reconcileWorkflows.includes(target.path)) continue;
      point = { at: run.created_at, event: null, inclusive: true };
    } else {
      const [, id, attempt, workflowId] = EVALUATION_TITLE.exec(run.display_title || '') || [];
      if (!positiveId(id) || !positiveId(attempt) || (workflowId && Number(workflowId) !== target.workflow_id)) continue;
      const latest = await api.run(id);
      if (latest.workflow_id !== target.workflow_id || !eligible(latest, options)) continue;
      const event = Number(attempt) === latest.run_attempt ? latest : await api.run(id, attempt);
      if (event.status !== 'completed' || !verdict(event)) continue;
      point = { at: event.updated_at, event, inclusive: true };
    }
    const same = point.event?.id === target.id && point.event.run_attempt === target.run_attempt;
    if (same || point.at > target.updated_at) {
      found.covered = true;
      if (options.reconcile) break;
    } else if (point.at < target.updated_at && (!found.before || point.at > found.before.at)) found.before = point;
  }
  return found;
}

function transition(current, previous) {
  if (red(current)) return red(previous) ? { kind: 'none', reason: 'Workflow remains red' } : { kind: 'red' };
  return red(previous) ? { kind: 'green' } : { kind: 'none', reason: 'No failure to recover from' };
}

// Minutes from the creation of the earliest run in the failure streak before `target` to
// its start; null when no failure precedes it, as after a lost recovery.
async function streakMinutes(history, target, holder, api, options) {
  const point = { at: target.updated_at, event: target, inclusive: false };
  let earliest = null;
  for await (const run of history.runs(target)) {
    if (compare(run, holder) > 0 || !eligible(run, options)) continue;
    const held = await verdictAt(run, point, api);
    if (!held) continue;
    if (held.conclusion === 'success') break;
    earliest = run;
  }
  if (!earliest) return null;
  const minutes = Math.floor((Date.parse(target.run_started_at) - Date.parse(earliest.created_at)) / 60_000);
  if (minutes < 0) throw new HistoryError('Recovery duration would be negative');
  return minutes;
}

// Announces when the effective verdict after `target` differs from the verdict at the last
// settled evaluation, so an evaluation that never completed is caught by the next one.
export async function evaluate(target, api, options) {
  if (!eligible(target, options) || target.status !== 'completed' || !verdict(target)) {
    return { kind: 'none', reason: 'Run is outside scope or has no completed verdict' };
  }
  try {
    const history = new History(api, target.workflow_id, target.workflow_id);
    const after = { at: target.updated_at, event: target, inclusive: true };
    const current = await effectiveAt(history, after, api, options);
    if (!current) throw new HistoryError('Target is missing from its own history');
    const settled = await settledPoints(target, api, options);
    // Only a reconcile, which revisits the latest verdict hourly, defers to a covering evaluation
    // or to untitled history; an evaluation of a completion always answers for it.
    if (options.reconcile && settled.covered) return { kind: 'none', reason: 'A later evaluation already settled this workflow' };
    if (options.reconcile && !settled.before) return { kind: 'none', reason: 'No titled evaluation to compare with' };
    const before = await effectiveAt(history, { ...after, inclusive: false }, api, options);
    const previous = settled.before ? await effectiveAt(history, settled.before, api, options) : before;
    const result = transition(current.held, previous?.held);
    if (result.kind === 'none') {
      return current.run.id === target.id ? result : { kind: 'none', reason: 'A newer run already held the effective verdict' };
    }
    // The notification names the run that holds the verdict, which a newer run can be.
    if (current.run.id !== target.id) result.run = current.held;
    if (result.kind === 'green') {
      const minutes = await streakMinutes(history, target, current.run, api, options);
      if (minutes !== null) result.minutes = minutes;
    }
    if (settled.before && transition(current.held, before?.held).kind !== result.kind) result.late = true;
    return result;
  } catch (error) {
    if (red(target)) return { kind: 'red', uncertain: true, reason: error.message };
    throw new HistoryError(`Previous verdict unknown; recovery withheld: ${error.message}`);
  }
}

// The latest verdict-bearing attempt of the newest-created eligible run, for a reconcile.
export async function latestVerdict(workflowId, api, options) {
  const history = new History(api, workflowId, workflowId);
  const now = { at: '9999-12-31T23:59:59Z', event: null, inclusive: true };
  return (await effectiveAt(history, now, api, options))?.held ?? null;
}

export function render(result, run, { repository, serverUrl, mainBranch, releaseWorkflows }, workflowName) {
  if (result.kind === 'none') return '';
  const scope = releaseWorkflows.includes(run.path) ? 'release' : mainBranch;
  const duration = result.minutes >= 60 ? `${Math.floor(result.minutes / 60)}h ${result.minutes % 60}m` : `${result.minutes}m`;
  const late = result.late ? ' (late: an earlier evaluation did not complete)' : '';
  const headline = result.kind === 'red'
    ? `🚨 ${repository.split('/')[1]}: ${escapeSlack(scope)} is red: ${escapeSlack(workflowName)} failed${result.uncertain ? ' (previous verdict unread)' : ''}${late}`
    : `✅ ${repository.split('/')[1]}: ${escapeSlack(workflowName)} is green again${result.minutes === undefined ? '' : ` (red for ${duration})`}${late}`;
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
  const reconcile = env.GITHUB_EVENT_NAME === 'schedule';
  // Where each event takes the run it evaluates from; a reconcile chooses its own.
  const [runId, attempt] = automatic ? [event.workflow_run?.id, event.workflow_run?.run_attempt]
    : reconcile ? ['', ''] : [env.INPUT_RUN_ID, env.INPUT_RUN_ATTEMPT];
  if (runId && !positiveId(runId)) throw new Error('run_id must be a positive integer');
  if (attempt && (!runId || !positiveId(attempt))) throw new Error('run_attempt requires a run_id and must be a positive integer');
  if (automatic && (!runId || !attempt)) throw new Error('Completion event lacks run ID or attempt');
  if (!['workflow_run', 'schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) && env.POST_FOR_REAL === 'true') {
    throw new Error('Posting requires workflow_run, workflow_dispatch or schedule');
  }
  const reconcileWorkflows = list(env.RECONCILE_WORKFLOWS);
  if (reconcile && !reconcileWorkflows.length) throw new Error('A scheduled reconcile requires reconcile_workflows');
  // The caller's own Main Status workflow, whose run history records past evaluations.
  const statusWorkflow = /\/\.github\/workflows\/([^/@]+)@/.exec(env.STATUS_WORKFLOW_REF || '')?.[1] || null;
  return {
    repository: env.GITHUB_REPOSITORY, mainBranch: env.MAIN_BRANCH || 'main',
    serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
    releaseWorkflows: list(env.RELEASE_WORKFLOWS), reconcileWorkflows, reconcile, statusWorkflow,
    selfRunId: env.GITHUB_RUN_ID || null,
    runId, attempt, postForReal: env.POST_FOR_REAL === 'true', webhook: env.SLACK_WEBHOOK_URL,
  };
}

export async function main(env = process.env) {
  const summary = (text) => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); };
  try {
    const options = configuration(env, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')));
    const api = new GitHub({ repository: options.repository, token: env.GH_TOKEN, apiUrl: env.GITHUB_API_URL });
    // Reports a result under `label`, delivering it unless it is quiet.
    const announce = async (label, result, text) => {
      if (result.kind === 'none') {
        console.log(result.reason);
        summary(`Main Status${label}: ${result.reason}`);
        return result;
      }
      console.log(text);
      const delivery = await deliver(text, options);
      console.log(delivery);
      if (result.uncertain) console.log(`::warning::${oneLine(result.reason)}`);
      summary(`Main Status${label}: ${result.kind}${result.uncertain ? ' (previous verdict unknown)' : ''}${result.late ? ' (late)' : ''}. ${delivery}`);
      return result;
    };
    const evaluated = async (label, run, workflow) => {
      const result = run ? await evaluate(run, api, options) : { kind: 'none', reason: 'No verdict yet' };
      const text = result.kind === 'none' ? '' : render(result, result.run ?? run, options, (await workflow()).name);
      return announce(label, result, text);
    };
    if (options.reconcile) {
      const failures = [];
      for (const path of options.reconcileWorkflows) {
        try {
          const workflow = await api.workflow(path.split('/').pop());
          await evaluated(` ${path}`, await latestVerdict(workflow.id, api, options), async () => workflow);
        } catch (error) {
          console.log(`::error::${oneLine(`${path}: ${error.message}`)}`);
          failures.push(path);
        }
      }
      if (failures.length) throw new Error(`Reconcile incomplete for ${failures.join(', ')}`);
      return { kind: 'reconcile' };
    }
    if (!options.runId) {
      const text = `🧪 ${escapeSlack(options.repository.split('/')[1])}: Main Status test message from ${escapeSlack(env.GITHUB_ACTOR || 'unknown')}, not an alert\n<${options.serverUrl}/${options.repository}/actions/runs/${env.GITHUB_RUN_ID}|this run>`;
      return announce('', { kind: 'diagnostic' }, text);
    }
    const run = await api.run(options.runId, options.attempt);
    return evaluated('', run, () => api.workflow(run.workflow_id));
  } catch (error) {
    summary(`Main Status failed: ${error.message}`);
    throw error;
  }
}
