import { execFileSync } from 'node:child_process';
import { evaluate, GitHub, list, render } from '../src/main-status.mjs';

const [repository, id, attempt] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^[1-9][0-9]*$/.test(id || '') ||
    (attempt && !/^[1-9][0-9]*$/.test(attempt))) {
  throw new Error('Usage: node scripts/replay.mjs owner/repo run_id [run_attempt]');
}
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const api = new GitHub({ repository, token });
const options = {
  repository, mainBranch: process.env.MAIN_BRANCH || 'main', serverUrl: 'https://github.com',
  releaseWorkflows: list(process.env.RELEASE_WORKFLOWS), reconcileWorkflows: list(process.env.RECONCILE_WORKFLOWS),
  statusWorkflow: process.env.STATUS_WORKFLOW || null, selfRunId: null,
};
const run = await api.run(id, attempt);
const result = await evaluate(run, api, options);
console.log(JSON.stringify({ id: run.id, attempt: run.run_attempt, ...result }));
if (result.kind !== 'none') {
  const workflow = await api.get(`actions/workflows/${run.workflow_id}`);
  console.log(render(result, result.run ?? run, options, workflow.name));
}
console.log('Slack post withheld (replay).');
