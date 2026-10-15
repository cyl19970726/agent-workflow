/** Opt-in isolated Docker build context for the fixed, in-container Agent worker. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = 'docker.io/library/node@sha256:156e9bc7a0a267cc6ca77b4283e32b123479342df684ce297455d7b95ff5a6b5'; // ARM64 Node 24 base
const PACKAGE_NAMES = ['core', 'agent-sdk'];

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function command(bin, args, cwd) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(bin, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveCommand() : reject(new Error(`${bin} exited ${code}`)));
  });
}

function output(bin, args, cwd) {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    let result = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { result += chunk; if (result.length > 16_384) child.kill(); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveOutput(result.trim()) : reject(new Error(`${bin} exited ${code}`)));
  });
}

async function copyJsOnly(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) await copyJsOnly(from, to);
    else if (entry.isFile() && entry.name.endsWith('.js')) await cp(from, to);
    else if (entry.isSymbolicLink()) throw new Error('Build input contains a symlink');
  }
}

async function main() {
  const base = option('--base', DEFAULT_BASE);
  const tag = option('--tag', 'local/workflow-container-agent:dev');
  if (!base || !/@sha256:[a-f0-9]{64}$/.test(base) || !/^[a-zA-Z0-9_./:@-]+$/.test(base))
    throw new Error('Base must be an explicit digest-pinned local Node24/Python3/Codex image');
  if (!tag || !/^[a-zA-Z0-9_./:-]+$/.test(tag)) throw new Error('Invalid local image tag');
  await command('npm', ['run', 'build', '-w', '@signal-room/workflow'], ROOT);
  await command('npm', ['run', 'build', '-w', '@signal-room/workflow-agent-sdk'], ROOT);
  await command('npm', ['run', 'build', '-w', '@signal-room/workflow-opensandbox'], ROOT);
  const context = await mkdtemp(join(tmpdir(), 'workflow-osb-image-'));
  try {
    for (const name of PACKAGE_NAMES) {
      const destination = join(context, 'packages', name);
      await copyJsOnly(join(ROOT, 'packages', name, 'dist'), join(destination, 'dist'));
      const manifest = JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
      delete manifest.scripts;
      if (name === 'agent-sdk') manifest.dependencies['@signal-room/workflow'] = 'file:../core';
      await writeFile(join(destination, 'package.json'), JSON.stringify(manifest));
    }
    const workerRoot = join(ROOT, 'packages', 'opensandbox', 'dist', 'src');
    for (const file of ['container-worker.js', 'container-protocol.js'])
      await cp(join(workerRoot, file), join(context, file));
    await writeFile(join(context, 'package.json'), JSON.stringify({ name: 'workflow-container-agent',
      version: '0.1.0', private: true, type: 'module', dependencies: {
        '@openai/agents': '0.20.0', '@signal-room/workflow': 'file:./packages/core',
        '@signal-room/workflow-agent-sdk': 'file:./packages/agent-sdk',
      } }));
    await command('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], context);
    const dockerfile = [
      `FROM ${base}`,
      'ENV DEBIAN_FRONTEND=noninteractive HOME=/home/node npm_config_update_notifier=false',
      'USER root',
      'RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/* && npm install --global --ignore-scripts --no-audit --no-fund @openai/codex@0.154.0 && npm cache clean --force',
      'WORKDIR /opt/workflow',
      'COPY package.json package-lock.json ./',
      'COPY packages ./packages',
      'RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && node -e "process.exit(Number(process.versions.node.split(\'.\')[0])===24?0:1)" && python3 --version && codex --version',
      'COPY container-worker.js container-protocol.js ./',
      'RUN install -d -o node -g node /work /work/shared /work/.workflow /home/node',
      'USER node',
      'WORKDIR /work/shared',
      'CMD ["node", "/opt/workflow/container-worker.js"]',
      '',
    ].join('\n');
    await writeFile(join(context, 'Dockerfile'), dockerfile);
    await command('docker', ['build', '--pull=false', '--file', join(context, 'Dockerfile'), '--tag', tag, context], ROOT);
    const imageId = await output('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], ROOT);
    assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
    const repoDigests = JSON.parse(await output('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', tag], ROOT));
    process.stdout.write(`${JSON.stringify({ tag, imageId, repoDigests, localImageReference: `${tag.replace(/:[^/]+$/, '')}@${imageId}` })}\n`);
  } finally { await rm(context, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Image build failed'); process.exitCode = 1; });
