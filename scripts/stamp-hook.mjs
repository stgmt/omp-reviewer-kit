// Stamps templates/githooks/pre-commit with the hook format and the digest of its own body. Run after
// every edit of the template; check-layout rejects a template whose marker is missing or stale. No
// release version goes into the file, so shipping a release never rewrites a repository's hook.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_FORMAT, stampHookTemplate } from '../src/domain/hook-template.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(root, 'templates', 'githooks', 'pre-commit');
await writeFile(templatePath, stampHookTemplate(await readFile(templatePath, 'utf8'), HOOK_FORMAT));
console.log(`stamped templates/githooks/pre-commit as hook-format v${HOOK_FORMAT}`);
