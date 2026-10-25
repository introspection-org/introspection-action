import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const template = readFileSync(new URL('src/main-status.workflow.yml', root), 'utf8');
const source = readFileSync(new URL('src/main-status.mjs', root), 'utf8').trimEnd();
const script = `node --input-type=module <<'MAIN_STATUS_NODE'\n${source}\nawait main();\nMAIN_STATUS_NODE`;
const generated = template.replace('          __MAIN_STATUS_SCRIPT__', script.split('\n').map((line) => line ? `          ${line}` : '').join('\n'));
const output = new URL('.github/workflows/main-status.yml', root);
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== generated) throw new Error('Run npm run generate and commit the generated workflow');
} else writeFileSync(output, generated);
