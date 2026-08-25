import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { pathExists } from './fsutils.js';

// Libs are not stamped — the vendored project/packages/* copies are the record (once libs come from npm, ship the lockfile instead; Digit scans both).
export async function buildInfo({ packagesDir }) {
  const starterRoot = path.dirname(packagesDir);

  // Stamped into the root package.json by publish-starter-asset.yml — release zips only.
  const rootPkgFile = path.join(starterRoot, 'package.json');
  if (await pathExists(rootPkgFile)) {
    const rootPkg = JSON.parse(await fs.readFile(rootPkgFile, 'utf8'));
    if (typeof rootPkg.starterRelease === 'string') return { starter: rootPkg.starterRelease };
    // A vendored project/ tree's root is the app's package.json — a git sha there would be the author's repo.
    if (rootPkg.name !== 'digit-apps-starter') return { starter: null };
  }

  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: starterRoot,
    encoding: 'utf8',
  });
  if (git.status === 0) return { starter: `git:${git.stdout.trim()}` };
  return { starter: null };
}
