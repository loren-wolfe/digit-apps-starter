import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBackend } from './buildBackend.js';
import { buildFrontend } from './buildFrontend.js';
import { copyPath, pathExists, rmrf } from './fsutils.js';
import { buildInfo } from './buildInfo.js';

const PROJECT_ALLOWLIST = [
  'src',
  'SPEC.md',
  'README.md',
  'manifest.json',
  'package.json',
  'tsconfig.json',
  'index.html',
];

function libBuildPackagesDir() {
  // packages/lib-build/src/pack.js → packages/
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

async function resolvePackagesDir({ root }) {
  if (await pathExists(path.join(root, 'packages', 'lib-build'))) {
    return path.join(root, 'packages');
  }
  const monorepo = libBuildPackagesDir();
  if (await pathExists(path.join(monorepo, 'lib-build'))) {
    return monorepo;
  }
  throw new Error(
    'cannot find @digit/lib-* packages (expected ./packages or monorepo packages/ next to lib-build)',
  );
}

function digitLibFoldersFromPackageJson(pkg) {
  const folders = new Set();
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@digit/lib-')) continue;
      folders.add(name.slice('@digit/'.length));
    }
  }
  // Always vendor the build tooling used to re-pack.
  folders.add('lib-build');
  return [...folders];
}

function rewriteDigitLibDeps(pkg) {
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@digit/lib-')) continue;
      const folder = name.slice('@digit/'.length);
      deps[name] = `file:./packages/${folder}`;
    }
  }
  return pkg;
}

async function stageProject({ root, staging, packagesDir }) {
  const projectDir = path.join(staging, 'project');
  await fs.mkdir(projectDir, { recursive: true });

  for (const name of PROJECT_ALLOWLIST) {
    const src = path.join(root, name);
    if (await pathExists(src)) {
      await copyPath(src, path.join(projectDir, name));
    }
  }

  if (!(await pathExists(path.join(projectDir, 'manifest.json')))) {
    throw new Error('manifest.json is required in the project archive');
  }
  if (!(await pathExists(path.join(projectDir, 'package.json')))) {
    throw new Error('package.json is required in the project archive');
  }

  const pkgPath = path.join(projectDir, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  const libFolders = digitLibFoldersFromPackageJson(pkg);

  const packagesOut = path.join(projectDir, 'packages');
  await fs.mkdir(packagesOut, { recursive: true });

  for (const folder of libFolders) {
    const src = path.join(packagesDir, folder);
    if (!(await pathExists(src))) {
      if (folder === 'lib-build') {
        throw new Error(`missing required package ${folder} under ${packagesDir}`);
      }
      continue;
    }
    await copyPath(src, path.join(packagesOut, folder));
  }

  const rewritten = rewriteDigitLibDeps(pkg);
  await fs.writeFile(pkgPath, `${JSON.stringify(rewritten, null, 2)}\n`);

  // Monorepo lockfiles point at ../../packages — omit them. Keep a lock only when
  // already vendored (deps already file:./packages/*).
  const isVendoredTree = packagesDir === path.join(root, 'packages');
  if (isVendoredTree && (await pathExists(path.join(root, 'package-lock.json')))) {
    await copyPath(
      path.join(root, 'package-lock.json'),
      path.join(projectDir, 'package-lock.json'),
    );
  }
}

function zipStaging({ staging, outZip }) {
  const result = spawnSync('zip', ['-r', outZip, '.', '-x', '*.DS_Store', '-x', '**/.DS_Store'], {
    cwd: staging,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(
      `failed to run zip (${result.error.message}). Install the zip CLI to pack apps.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`zip exited with code ${result.status}`);
  }
}

export async function pack({ root = process.cwd() } = {}) {
  const appRoot = path.resolve(root);

  if (!(await pathExists(path.join(appRoot, 'SPEC.md')))) {
    throw new Error('SPEC.md is required before pack (iteration context for the next agent)');
  }
  if (!(await pathExists(path.join(appRoot, 'package.json')))) {
    throw new Error('package.json not found — run digit-app pack from the app root');
  }

  console.log('Building frontend…');
  await buildFrontend({ root: appRoot });

  console.log('Building backend (if present)…');
  const builtBackend = await buildBackend({ root: appRoot });
  if (!builtBackend) {
    console.log('No src/backend/index.js — skipping backend build');
  }

  const packagesDir = await resolvePackagesDir({ root: appRoot });
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'digit-app-pack-'));

  try {
    // Digit expects manifest.json at the zip root; the staged copy gains "build" — the author's file is untouched.
    const manifest = JSON.parse(await fs.readFile(path.join(appRoot, 'manifest.json'), 'utf8'));
    manifest.build = await buildInfo({ packagesDir });
    await fs.writeFile(
      path.join(staging, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await copyPath(path.join(appRoot, 'frontend'), path.join(staging, 'frontend'));
    if (await pathExists(path.join(appRoot, 'backend'))) {
      await copyPath(path.join(appRoot, 'backend'), path.join(staging, 'backend'));
    }
    await stageProject({ root: appRoot, staging, packagesDir });

    const outZip = path.join(appRoot, 'app.zip');
    await fs.rm(outZip, { force: true });
    zipStaging({ staging, outZip });
    console.log(`Wrote ${outZip}`);
  } finally {
    await rmrf(staging);
  }
}
