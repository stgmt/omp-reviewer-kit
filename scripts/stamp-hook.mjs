// Stamps templates/githooks/pre-commit with the marker of the package version. Run after every
// edit of the template; check-layout rejects a template whose marker is missing, stale or wrong.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stampHookTemplate } from '../src/domain/hook-template.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(root, 'templates', 'githooks', 'pre-commit');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(templatePath, stampHookTemplate(await readFile(templatePath, 'utf8'), version));
console.log(`stamped templates/githooks/pre-commit as v${version}`);
