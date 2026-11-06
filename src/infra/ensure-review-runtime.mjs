// Marketplace installs copy the plugin without its dependencies. Prepare the locked runtime outside
// the reviewed repository, and publish it atomically so another process never sees a partial install.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const REMOVE = { recursive: true, force: true, maxRetries: 20, retryDelay: 250 };

function containsPinnedDependencies(root, dependencies) {
  try {
    return Object.entries(dependencies).every(([name, version]) => {
      const manifest = JSON.parse(readFileSync(path.join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
      return manifest.name === name && manifest.version === version;
    });
  } catch {
    return false;
  }
}

function resolveFuturePath(target) {
  let current = path.resolve(target);
  const missing = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('cannot determine the runtime cache location');
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync.native(current), ...missing);
}

/** Provision the exact lockfile once; concurrent first launches install in separate directories. */
export function ensureReviewRuntime({ kitRoot, repoRoot, bun, bunVersion, home = homedir(), installTimeoutMs = 300_000 }) {
  const manifestPath = path.join(kitRoot, 'package.json');
  const lockPath = path.join(kitRoot, 'bun.lock');
  const manifestBytes = readFileSync(manifestPath);
  const lockBytes = readFileSync(lockPath);
  const dependencies = JSON.parse(manifestBytes.toString('utf8')).dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)
    || !dependencies['@oh-my-pi/pi-coding-agent'] || !dependencies['@babel/parser']) {
    throw new Error('the plugin has no pinned runtime dependencies');
  }
  const key = createHash('sha256').update(JSON.stringify(dependencies)).update(lockBytes)
    .update(process.platform).update(process.arch).update(bunVersion).digest('hex');
  const cache = resolveFuturePath(path.join(home, '.omp', 'review-kit-runtime'));
  const relative = path.relative(realpathSync.native(repoRoot), cache);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error('the review runtime cache would be inside the reviewed repository');
  }
  const destination = path.join(cache, key);
  if (containsPinnedDependencies(destination, dependencies)) return destination;
  if (existsSync(destination)) throw new Error(`the cached review runtime is incomplete: ${destination}`);
  mkdirSync(cache, { recursive: true });
  const temp = mkdtempSync(path.join(cache, '.install-'));
  try {
    copyFileSync(manifestPath, path.join(temp, 'package.json'));
    copyFileSync(lockPath, path.join(temp, 'bun.lock'));
    const result = spawnSync(bun, ['install', '--frozen-lockfile', '--ignore-scripts', '--cwd', temp], {
      encoding: 'utf8', windowsHide: true, timeout: installTimeoutMs,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.code ?? (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
      throw new Error(`dependency installation failed (${detail}); check Bun registry access and the pinned lockfile`);
    }
    if (!containsPinnedDependencies(temp, dependencies)) throw new Error('the installed runtime does not contain the pinned dependencies');
    try {
      renameSync(temp, destination);
    } catch (error) {
      // Another process may have published the same complete runtime while this install ran.
      if (!containsPinnedDependencies(destination, dependencies)) throw error;
    }
    return destination;
  } finally {
    rmSync(temp, REMOVE);
  }
}
