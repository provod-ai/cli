'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chmod, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { mkdtemp } = require('node:fs/promises');

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('wrapper launches the vendored binary without a shell and preserves arguments and exit status', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'provod-wrapper-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'vendor'));
  const wrapper = await readFile(join(__dirname, '..', 'bin', 'provod.js'), 'utf8');
  await writeFile(join(root, 'bin', 'provod.js'), wrapper);
  await writeFile(join(root, 'vendor', 'provod'), '#!/bin/sh\nprintf "%s" "$1"\nexit 23\n');
  await chmod(join(root, 'vendor', 'provod'), 0o755);

  const result = await run(process.execPath, [join(root, 'bin', 'provod.js'), 'value with spaces'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.stdout, 'value with spaces');
  assert.equal(result.stderr, '');
  assert.equal(result.code, 23);
});

test('wrapper fails closed with reinstall guidance when lifecycle scripts were skipped', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'provod-wrapper-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin', 'provod.js'), await readFile(join(__dirname, '..', 'bin', 'provod.js')));

  const result = await run(process.execPath, [join(root, 'bin', 'provod.js')], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /reinstall @provod-ai\/cli without --ignore-scripts/);
});

test('wrapper refuses Windows even when lifecycle scripts were bypassed', async () => {
  const wrapper = join(__dirname, '..', 'bin', 'provod.js');
  const result = await run(process.execPath, ['-e',
    "Object.defineProperty(process, 'platform', { value: 'win32' }); require(process.argv[1]);", wrapper], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Windows support is currently unavailable/);
  assert.doesNotMatch(result.stderr, /ENOENT|reinstall/);
});

test('wrapper forwards termination signals from the shim to the native process', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'provod-wrapper-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'vendor'));
  await writeFile(join(root, 'bin', 'provod.js'), await readFile(join(__dirname, '..', 'bin', 'provod.js')));
  await writeFile(join(root, 'vendor', 'provod'), '#!/bin/sh\nexec sleep 30\n');
  await chmod(join(root, 'vendor', 'provod'), 0o755);
  const child = spawn(process.execPath, [join(root, 'bin', 'provod.js')], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  child.kill('SIGTERM');
  const result = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(result, { code: null, signal: 'SIGTERM' });
});

test('wrapper forwards SIGQUIT instead of orphaning the native process', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'provod-wrapper-'));
  let nativePid;
  context.after(async () => {
    if (Number.isInteger(nativePid)) {
      try { process.kill(nativePid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'bin'));
  await mkdir(join(root, 'vendor'));
  await writeFile(join(root, 'bin', 'provod.js'), await readFile(join(__dirname, '..', 'bin', 'provod.js')));
  await writeFile(join(root, 'vendor', 'provod'), '#!/bin/sh\nprintf "%s" "$$" > "$CHILD_PID_FILE"\nexec sleep 30\n');
  await chmod(join(root, 'vendor', 'provod'), 0o755);
  const pidFile = join(root, 'child.pid');
  const child = spawn(process.execPath, [join(root, 'bin', 'provod.js')], {
    env: { ...process.env, CHILD_PID_FILE: pidFile },
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      nativePid = Number(await readFile(pidFile, 'utf8'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.ok(Number.isInteger(nativePid) && nativePid > 0, 'native child did not report its PID');
  child.kill('SIGQUIT');
  const result = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(result, { code: null, signal: 'SIGQUIT' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(nativePid, 0), { code: 'ESRCH' });
});
