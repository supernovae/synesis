import { readFile, writeFile } from 'node:fs/promises';
import { compareTrials } from './compare.js';
const [path, output, ...extra] = process.argv.slice(2);
if (!path || extra.length) throw new Error('Usage: cli.js trials.jsonl [result.json]');
const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const result = JSON.stringify({ frontDoor: compareTrials(rows), existing: compareTrials(rows, 'existing') }, null, 2) + '\n';
if (output) await writeFile(output, result);
else process.stdout.write(result);
