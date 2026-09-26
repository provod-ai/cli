'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const { download, expectedChecksum, extractTarGz, extractZip, install, resolveRedirect, resolveTarget, validateVersion } = require('../lib/installer.cjs');

function checksumManifest(asset, digest) {
  const version = /^provod-v(.+)-linux-x64\.tar\.gz$/.exec(asset)[1];
  return ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
    .map((target) => `${digest}  provod-v${version}-${target}.tar.gz\n`).join('');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(name, contents, externalAttributes = 0) {
  const filename = Buffer.from(name);
  const crc = crc32(contents);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(externalAttributes, 38);
  const centralOffset = local.length + filename.length + contents.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, filename, contents, central, filename, end]);
}

function tarArchive(name, contents, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, contents, padding, Buffer.alloc(1024)]));
}

async function mockCosign(context, packageRoot) {
  const tools = join(packageRoot, 'test-tools'); await mkdir(tools);
  const executable = join(tools, 'cosign');
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== 'verify-blob-attestation' || args[args.indexOf('--certificate-identity') + 1] !== 'https://github.com/provod-ai/cli-source/.github/workflows/native-release.yml@refs/tags/v1.2.3' || args[args.indexOf('--certificate-oidc-issuer') + 1] !== 'https://token.actions.githubusercontent.com') process.exit(1);
`);
  await chmod(executable, 0o755);
  const original = process.env.PATH; process.env.PATH = `${tools}:${original}`;
  context.after(() => { process.env.PATH = original; });
}

async function releaseServer(routes) {
  const server = http.createServer((request, response) => {
    const route = routes[request.url];
    if (!route) { response.writeHead(404).end(); return; }
    if (typeof route === 'function') { route(request, response); return; }
    response.writeHead(route.status || 200, route.headers || {});
    response.end(route.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('maps only the four supported release targets', () => {
  assert.deepEqual(resolveTarget('darwin', 'arm64', '1.2.3'), {
    asset: 'provod-v1.2.3-darwin-arm64.tar.gz', executable: 'provod',
  });
  assert.equal(resolveTarget('darwin', 'x64', '1.2.3').asset, 'provod-v1.2.3-darwin-x64.tar.gz');
  assert.equal(resolveTarget('linux', 'arm64', '1.2.3').asset, 'provod-v1.2.3-linux-arm64.tar.gz');
  assert.equal(resolveTarget('linux', 'x64', '1.2.3').asset, 'provod-v1.2.3-linux-x64.tar.gz');
  assert.throws(() => resolveTarget('win32', 'x64', '1.2.3'), /Windows.*unavailable/);
  for (const [platform, arch] of [['win32', 'arm64'], ['freebsd', 'x64'], ['linux', 'ia32']]) {
    assert.throws(() => resolveTarget(platform, arch, '1.2.3'), /Unsupported platform/);
  }
});

test('checksum manifest requires exactly four same-version POSIX archives', () => {
  const asset = 'provod-v1.2.3-linux-x64.tar.gz';
  const names = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((target) => `provod-v1.2.3-${target}.tar.gz`);
  const lines = names.map((name) => `${'a'.repeat(64)}  ${name}`);
  assert.equal(expectedChecksum(lines.join('\n') + '\n', asset), 'a'.repeat(64));
  for (const invalid of [lines.slice(1), [...lines, `${'a'.repeat(64)}  provod-v1.2.3-windows-x64.zip`],
    [...lines.slice(1), lines[1]], lines.map((line, i) => i === 0 ? line.replace('v1.2.3', 'v9.9.9') : line)]) {
    assert.throws(() => expectedChecksum(invalid.join('\n') + '\n', asset), /checksum|SHA256SUMS/i);
  }
});

test('accepts strict SemVer and rejects ambiguous versions', () => {
  for (const value of ['0.0.0', '1.2.3', '1.2.3-alpha.1', '1.2.3+build.5', '1.2.3-rc.1+build']) {
    assert.equal(validateVersion(value), value);
  }
  for (const value of ['v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3-01', '../1.2.3', '1.2.3\n']) {
    assert.throws(() => validateVersion(value), /valid SemVer/);
  }
});

test('downloads, verifies, and atomically installs the matching native archive', async (context) => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'provod-npm-'));
  context.after(() => rm(packageRoot, { recursive: true, force: true }));
  const binary = Buffer.from('#!/bin/sh\nprintf installed');
  const archive = tarArchive('provod', binary);
  const digest = createHash('sha256').update(archive).digest('hex');
  const asset = 'provod-v1.2.3-linux-x64.tar.gz';
  await mockCosign(context, packageRoot);
  const server = await releaseServer({
    [`/v1.2.3/${asset}.sigstore.json`]: { body: '{}' },
    [`/v1.2.3/${asset}`]: { body: archive },
    '/v1.2.3/SHA256SUMS': { body: checksumManifest(asset, digest) },
  });
  context.after(server.close);

  const installed = await install({
    version: '1.2.3', platform: 'linux', arch: 'x64', packageRoot,
    baseUrl: server.baseUrl, allowInsecureTestUrl: true,
  });

  assert.equal(installed, join(packageRoot, 'vendor', 'provod'));
  assert.deepEqual(await readFile(installed), binary);
  await writeFile(join(packageRoot, 'test-tools', 'cosign'), '#!/bin/sh\nexit 1\n');
  await assert.rejects(install({ version: '1.2.3', platform: 'linux', arch: 'x64', packageRoot,
    baseUrl: server.baseUrl, allowInsecureTestUrl: true }), /provenance verification failed/);
  assert.deepEqual(await readFile(installed), binary);
});

test('refuses checksum-valid archives without signed provenance', async (context) => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'provod-npm-'));
  context.after(() => rm(packageRoot, { recursive: true, force: true }));
  const archive = tarArchive('provod', Buffer.from('untrusted'));
  const asset = 'provod-v1.2.3-linux-x64.tar.gz';
  const server = await releaseServer({
    [`/v1.2.3/${asset}`]: { body: archive },
    '/v1.2.3/SHA256SUMS': { body: checksumManifest(asset, createHash('sha256').update(archive).digest('hex')) },
  });
  context.after(server.close);
  await assert.rejects(install({ version: '1.2.3', platform: 'linux', arch: 'x64', packageRoot, baseUrl: server.baseUrl, allowInsecureTestUrl: true }), /404|provenance/);
  assert.deepEqual(await readdir(packageRoot), []);
});

test('Windows installation fails before network access or filesystem writes', async (context) => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'provod-npm-'));
  context.after(() => rm(packageRoot, { recursive: true, force: true }));
  let requests = 0;
  const server = await releaseServer({ '/v2.0.0/SHA256SUMS': () => { requests += 1; } });
  context.after(server.close);
  for (const arch of ['x64', 'arm64']) {
    await assert.rejects(install({ version: '2.0.0', platform: 'win32', arch,
      packageRoot, baseUrl: server.baseUrl, allowInsecureTestUrl: true }), /Windows.*unavailable/);
  }
  assert.equal(requests, 0);
  assert.deepEqual(await readdir(packageRoot), []);
});

test('rejects a tar archive whose header checksum is invalid', () => {
  const tar = gunzipSync(tarArchive('provod', Buffer.from('binary')));
  tar[300] ^= 1;
  assert.throws(() => extractTarGz(gzipSync(tar), 'provod'), /checksum/);
});

test('follows a bounded redirect to the same URL scheme', async (context) => {
  const server = await releaseServer({
    '/start': { status: 302, headers: { location: '/finish' }, body: '' },
    '/finish': { body: 'ok' },
  });
  context.after(server.close);
  assert.equal((await download(`${server.baseUrl}/start`, { maxRedirects: 2, allowInsecureTestUrl: true })).toString(), 'ok');
});

test('rejects a non-HTTPS initial download unless explicitly injected by tests', async (context) => {
  const server = await releaseServer({ '/asset': { body: 'unsafe' } });
  context.after(server.close);
  await assert.rejects(download(`${server.baseUrl}/asset`), /HTTPS/);
});

test('rejects an HTTPS redirect downgrade', () => {
  assert.throws(
    () => resolveRedirect(new URL('https://github.com/start'), 'http://github.com/finish'),
    /downgrade/,
  );
});

test('rejects traversal encoded in a tar prefix field', () => {
  const tar = gunzipSync(tarArchive('provod', Buffer.from('x')));
  tar.write('../escape', 345, 155, 'utf8');
  tar.fill(0x20, 148, 156);
  const checksum = [...tar.subarray(0, 512)].reduce((sum, byte) => sum + byte, 0);
  tar.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  assert.throws(() => extractTarGz(gzipSync(tar), 'provod'), /unsafe/);
});

test('rejects hidden data after the tar end marker', () => {
  const tar = gunzipSync(tarArchive('provod', Buffer.from('x')));
  const hidden = gunzipSync(tarArchive('other', Buffer.from('y'))).subarray(0, 512);
  hidden.copy(tar, 1536);
  assert.throws(() => extractTarGz(gzipSync(tar), 'provod'), /unexpected/);
});

test('rejects malformed, missing, and ambiguous checksum manifests', () => {
  const asset = 'provod-v1.2.3-linux-x64.tar.gz';
  assert.throws(() => expectedChecksum(`not-a-checksum  ${asset}\n`, asset), /Malformed/);
  assert.throws(() => expectedChecksum(`${'a'.repeat(64)} ${asset}\n`, asset), /Malformed/);
  assert.throws(() => expectedChecksum(`${'A'.repeat(64)}  ${asset}\n`, asset), /Malformed/);
  assert.throws(() => expectedChecksum(`${'a'.repeat(64)}  other.tar.gz\n`, asset), /missing/);
  assert.throws(() => expectedChecksum(`${'a'.repeat(64)}  ${asset}\n${'b'.repeat(64)}  ${asset}\n`, asset), /ambiguous/);
});

test('checksum mismatch preserves an existing executable', async (context) => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'provod-npm-'));
  context.after(() => rm(packageRoot, { recursive: true, force: true }));
  await mkdir(join(packageRoot, 'vendor'));
  await writeFile(join(packageRoot, 'vendor', 'provod'), 'existing');
  const archive = tarArchive('provod', Buffer.from('replacement'));
  const asset = 'provod-v1.2.3-linux-x64.tar.gz';
  const server = await releaseServer({
    [`/v1.2.3/${asset}`]: { body: archive },
    '/v1.2.3/SHA256SUMS': { body: checksumManifest(asset, '0'.repeat(64)) },
  });
  context.after(server.close);

  await assert.rejects(install({
    version: '1.2.3', platform: 'linux', arch: 'x64', packageRoot,
    baseUrl: server.baseUrl, allowInsecureTestUrl: true,
  }), /checksum mismatch/);
  assert.equal((await readFile(join(packageRoot, 'vendor', 'provod'))).toString(), 'existing');
});

test('rejects traversal, link, and unexpected archive members', () => {
  assert.throws(() => extractTarGz(tarArchive('../provod', Buffer.from('x')), 'provod'), /unsafe/);
  assert.throws(() => extractTarGz(tarArchive('provod', Buffer.from('target'), '2'), 'provod'), /unsafe/);
  assert.throws(() => extractZip(zipArchive('../provod.exe', Buffer.from('x')), 'provod.exe'), /unsafe/);
  assert.throws(
    () => extractZip(zipArchive('provod.exe', Buffer.from('target'), (0xa000 << 16) >>> 0), 'provod.exe'),
    /unsafe/,
  );
});

test('rejects inconsistent ZIP local and central metadata', () => {
  const archive = zipArchive('provod.exe', Buffer.from('binary'));
  archive.writeUInt16LE(8, 8);
  assert.throws(() => extractZip(archive, 'provod.exe'), /metadata/);
});

test('bounds response size, timeout, and redirects', async (context) => {
  const server = await releaseServer({
    '/large': { body: '123456' },
    '/slow': (_request, response) => {
      response.writeHead(200);
      setTimeout(() => response.end('late'), 100);
    },
    '/one': { status: 302, headers: { location: '/two' }, body: '' },
    '/two': { status: 302, headers: { location: '/finish' }, body: '' },
    '/finish': { body: 'ok' },
  });
  context.after(server.close);
  const options = { allowInsecureTestUrl: true };
  await assert.rejects(download(`${server.baseUrl}/large`, { ...options, maxBytes: 5 }), /exceeds/);
  await assert.rejects(download(`${server.baseUrl}/slow`, { ...options, timeoutMs: 10 }), /timed out/);
  await assert.rejects(download(`${server.baseUrl}/one`, { ...options, maxRedirects: 1 }), /redirect limit/);
});

test('applies timeout to the whole response, not just idle periods', async (context) => {
  const server = await releaseServer({
    '/trickle': (_request, response) => {
      response.writeHead(200);
      const timer = setInterval(() => response.write('x'), 4);
      setTimeout(() => { clearInterval(timer); response.end(); }, 40);
      response.on('close', () => clearInterval(timer));
    },
  });
  context.after(server.close);
  await assert.rejects(
    download(`${server.baseUrl}/trickle`, { allowInsecureTestUrl: true, timeoutMs: 10 }),
    /timed out/,
  );
});

test('interrupted installation leaves the existing executable intact', async (context) => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'provod-npm-'));
  context.after(() => rm(packageRoot, { recursive: true, force: true }));
  const vendor = join(packageRoot, 'vendor');
  await mkdir(vendor);
  await writeFile(join(vendor, 'provod'), 'existing');
  const archive = tarArchive('provod', Buffer.from('replacement'));
  const digest = createHash('sha256').update(archive).digest('hex');
  const asset = 'provod-v1.2.3-linux-x64.tar.gz';
  await mockCosign(context, packageRoot);
  const server = await releaseServer({
    [`/v1.2.3/${asset}.sigstore.json`]: { body: '{}' },
    [`/v1.2.3/${asset}`]: { body: archive },
    '/v1.2.3/SHA256SUMS': { body: checksumManifest(asset, digest) },
  });
  context.after(server.close);

  await assert.rejects(install({
    version: '1.2.3', platform: 'linux', arch: 'x64', packageRoot,
    baseUrl: server.baseUrl, allowInsecureTestUrl: true,
    beforeCommit: () => { throw new Error('simulated interruption'); },
  }), /simulated interruption/);
  assert.equal((await readFile(join(vendor, 'provod'))).toString(), 'existing');
  assert.deepEqual(await readdir(vendor), ['provod']);
});
