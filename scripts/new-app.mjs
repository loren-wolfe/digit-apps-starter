#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const usage = `Usage: npm run new-app -- <app-name> [--from <example-or-template>] [--no-install]

Scaffold apps/<app-name> from templates/<name> or examples/<name> (default:
examples/full-featured) and link it into the workspace so \`npm run pack\` works.
`;

const SOURCE_DIRS = ['templates', 'examples'];

const SKIP_ANYWHERE = new Set(['node_modules', '.vite', '.DS_Store']);
// Build outputs (siblings of package.json, never src/frontend or src/backend) and the
// example's Studio card image, which belongs to the example rather than a scaffolded app.
const SKIP_AT_ROOT = new Set(['frontend', 'backend', 'package-lock.json', 'preview.jpg']);

function parseArgs(argv) {
  const options = { from: 'full-featured', install: true };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') {
      options.from = argv[i + 1];
      i += 1;
    } else if (arg === '--no-install') {
      options.install = false;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) throw new Error('Expected exactly one app name');
  options.name = positional[0];

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(options.name)) {
    throw new Error(`Invalid app name "${options.name}" — use kebab-case (e.g. order-tracker)`);
  }
  if (!options.from) throw new Error('--from requires an example or template name');

  return options;
}

async function copyTemplate(src, dest, { atRoot = true } = {}) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    if (SKIP_ANYWHERE.has(entry.name) || entry.name.endsWith('.zip')) continue;
    if (atRoot && SKIP_AT_ROOT.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTemplate(from, to, { atRoot: false });
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

function specTemplate(name, source) {
  return `# ${name}

Iteration context for the next agent. Keep this current — chat history is not always
available, so this file is how a later session understands the app.

## What it does

TODO: purpose, who uses it, key behaviors, non-obvious constraints.

## Data & permissions

TODO: why each manifest permission, env var, and secret exists (names only for secrets),
plus any gotchas.

## Prompts

TODO: the verbatim original request, then each refinement.

## Context supplied

Scaffolded from \`${source}\`. TODO: docs, tickets, screenshots, and user
decisions that shaped the app.
`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${usage}`);
    process.exit(1);
  }

  const dest = path.join(repoRoot, 'apps', options.name);

  let source;
  for (const dir of SOURCE_DIRS) {
    try {
      await fs.access(path.join(repoRoot, dir, options.from));
      source = `${dir}/${options.from}`;
      break;
    } catch {
      // Not in this folder; try the next one.
    }
  }
  if (!source) {
    console.error(`No template or example named "${options.from}" under templates/ or examples/`);
    process.exit(1);
  }
  const template = path.join(repoRoot, source);

  try {
    await fs.access(dest);
    console.error(`apps/${options.name} already exists`);
    process.exit(1);
  } catch {
    // Expected: the destination must not exist yet.
  }

  await copyTemplate(template, dest);

  const pkgPath = path.join(dest, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  pkg.name = `@digit-apps/${options.name}`;
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  await fs.writeFile(path.join(dest, 'SPEC.md'), specTemplate(options.name, source));
  await fs.rm(path.join(dest, 'README.md'), { force: true });

  console.log(`Created apps/${options.name} from ${source}`);

  if (options.install) {
    console.log('Installing workspace dependencies…');
    const result = spawnSync('npm', ['install'], { cwd: repoRoot, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('npm install failed — run it manually from the repo root before packing.');
      process.exit(1);
    }
  }

  console.log(
    [
      '',
      'Next:',
      `  1. Edit apps/${options.name}/src/frontend (and src/backend if you need a Worker)`,
      `  2. Update apps/${options.name}/manifest.json and SPEC.md`,
      `  3. npm run pack -w apps/${options.name}`,
      `  4. Keep apps/${options.name} source in this workspace (not frontend/, backend/, or *.zip)`,
      '  5. Do not push or open PRs against the upstream starter',
    ].join('\n'),
  );
}

main();
