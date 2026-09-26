'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { promisify } = require('node:util');
const { gunzipSync } = require('node:zlib');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const execFileAsync = promisify(execFile);
const packageRoot = join(__dirname, '..');

function tarMembers(archive) {
  const tar = gunzipSync(archive);
  const names = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names.sort();
}

test('public package manifest has no runtime dependencies and pins install to its own version', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@provod-ai/cli');
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.bin, { provod: 'bin/provod.js' });
  assert.equal(manifest.scripts.postinstall, 'node scripts/postinstall.cjs');
  assert.deepEqual(manifest.dependencies, undefined);
  assert.deepEqual(manifest.os, ['darwin', 'linux']);
  assert.deepEqual(manifest.cpu, ['arm64', 'x64']);
  assert.match(manifest.engines.node, /^>=/);
});

test('npm tarball contains only the public wrapper allowlist', async (context) => {
  const destination = await mkdtemp(join(tmpdir(), 'provod-pack-'));
  context.after(() => rm(destination, { recursive: true, force: true }));
  assert.ok(process.env.npm_execpath, 'npm_execpath is required for cross-platform package inspection');
  const { stdout } = await execFileAsync(
    process.execPath,
    [process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    { cwd: packageRoot },
  );
  const [{ filename }] = JSON.parse(stdout);
  const members = tarMembers(await readFile(join(destination, filename)));
  assert.deepEqual(members, [
    'package/LICENSE',
    'package/README.md',
    'package/bin/provod.js',
    'package/lib/installer.cjs',
    'package/package.json',
    'package/scripts/postinstall.cjs',
  ]);
});
