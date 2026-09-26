'use strict';

const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { chmod, mkdir, mkdtemp, rename, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const http = require('node:http');
const https = require('node:https');
const { join } = require('node:path');
const { gunzipSync, inflateRawSync } = require('node:zlib');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function validateVersion(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error(`Package version is not valid SemVer: ${String(version)}`);
  }
  return version;
}

function resolveTarget(platform, arch, version) {
  validateVersion(version);
  if (platform === 'win32') throw new Error('Unsupported platform: Windows support is currently unavailable. Use macOS or Linux.');
  const targets = {
    'darwin-arm64': ['darwin-arm64', 'tar.gz', 'provod'],
    'darwin-x64': ['darwin-x64', 'tar.gz', 'provod'],
    'linux-arm64': ['linux-arm64', 'tar.gz', 'provod'],
    'linux-x64': ['linux-x64', 'tar.gz', 'provod'],
  };
  const target = targets[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported platform: ${platform}-${arch}`);
  return {
    asset: `provod-v${version}-${target[0]}.${target[1]}`,
    executable: target[2],
  };
}

function resolveRedirect(current, location) {
  const redirect = new URL(location, current);
  if (redirect.username || redirect.password) throw new Error('Redirect URL is unsafe');
  if (current.protocol === 'https:' && redirect.protocol !== 'https:') {
    throw new Error('Refusing HTTPS redirect downgrade');
  }
  if (!['https:', 'http:'].includes(redirect.protocol)) throw new Error('Redirect URL is unsafe');
  return redirect;
}

async function download(url, options = {}) {
  const { maxBytes = 150 * 1024 * 1024, timeoutMs = 30_000, maxRedirects = 3 } = options;
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Download URL is unsafe');
  }
  if (parsed.protocol !== 'https:' && options.allowInsecureTestUrl !== true) {
    throw new Error('Downloads require HTTPS');
  }
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(parsed, { headers: { 'User-Agent': '@provod-ai/cli installer' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || maxRedirects <= 0) {
          reject(new Error('Download exceeded the redirect limit'));
          return;
        }
        let redirect;
        try {
          redirect = resolveRedirect(parsed, response.headers.location);
        } catch (error) {
          reject(error);
          return;
        }
        download(redirect.href, { ...options, maxBytes, timeoutMs, maxRedirects: maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }
      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.resume();
        reject(new Error(`Download exceeds ${maxBytes} bytes`));
        return;
      }
      const chunks = [];
      let size = 0;
      let failed = false;
      response.on('error', reject);
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          failed = true;
          response.destroy();
          reject(new Error(`Download exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Download timed out')), timeoutMs);
    request.once('close', () => clearTimeout(deadline));
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Download timed out')));
    request.on('error', reject);
  });
}

function expectedChecksum(text, asset) {
  const identity = /^provod-v(.+)-(darwin|linux)-(arm64|x64)\.tar\.gz$/.exec(asset);
  if (!identity) throw new Error('Unsupported checksum asset');
  const expected = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
    .map((target) => `provod-v${identity[1]}-${target}.tar.gz`));
  const lines = String(text).split('\n');
  if (lines.pop() !== '') throw new Error('Malformed SHA256SUMS: missing final newline');
  const seen = new Set();
  const matches = lines.map((line) => {
    const match = /^([0-9a-f]{64}) {2}([^\r\n]+)$/.exec(line);
    if (!match) throw new Error('Malformed SHA256SUMS');
    if (!expected.has(match[2]) || seen.has(match[2])) throw new Error('SHA256SUMS checksum entries are missing, unexpected or ambiguous');
    seen.add(match[2]);
    return match[2] === asset ? match[1] : null;
  }).filter(Boolean);
  if (seen.size !== 4) throw new Error('SHA256SUMS checksum entries are missing: expected exactly four archives');
  if (matches.length !== 1) throw new Error('Checksum entry is missing or ambiguous');
  return matches[0];
}

function extractTarGz(archive, expectedName) {
  const tar = gunzipSync(archive, { maxOutputLength: 200 * 1024 * 1024 });
  let offset = 0;
  let executable;
  let terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      const trailer = tar.subarray(offset);
      if (trailer.length < 1024 || trailer.some((byte) => byte !== 0)) {
        throw new Error('Archive contains unexpected trailing data');
      }
      terminated = true;
      break;
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const checksumText = header.subarray(148, 156).toString('ascii').replace(/[\0 ]+$/, '');
    if (!/^[0-7]{1,6}$/.test(checksumText)) throw new Error('Archive header checksum is invalid');
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const checksumActual = [...checksumHeader].reduce((sum, byte) => sum + byte, 0);
    if (Number.parseInt(checksumText, 8) !== checksumActual) throw new Error('Archive header checksum mismatch');
    const type = String.fromCharCode(header[156] || 48);
    const linkName = header.subarray(157, 257).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Archive has an invalid member size');
    const size = Number.parseInt(sizeText, 8);
    if (name !== expectedName || linkName || prefix || (type !== '0' && type !== '\0') || executable) {
      throw new Error('Archive contains an unexpected or unsafe member');
    }
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end > tar.length) throw new Error('Archive member is truncated');
    executable = Buffer.from(tar.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!executable || !terminated) throw new Error('Archive does not contain exactly the expected executable');
  return executable;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractZip(archive, expectedName) {
  if (archive.length < 22) throw new Error('ZIP archive is truncated');
  const endOffset = archive.length - 22;
  if (archive.readUInt32LE(endOffset) !== 0x06054b50 || archive.readUInt16LE(endOffset + 20) !== 0) {
    throw new Error('ZIP archive has an invalid end record');
  }
  const entries = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (entries !== 1 || archive.readUInt16LE(endOffset + 8) !== 1 || centralOffset + centralSize !== endOffset) {
    throw new Error('Archive contains unexpected members');
  }
  if (centralOffset + 46 > endOffset || archive.readUInt32LE(centralOffset) !== 0x02014b50) {
    throw new Error('ZIP central directory is invalid');
  }
  const flags = archive.readUInt16LE(centralOffset + 8);
  const method = archive.readUInt16LE(centralOffset + 10);
  const checksum = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const size = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const commentLength = archive.readUInt16LE(centralOffset + 32);
  const external = archive.readUInt32LE(centralOffset + 38);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const name = archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
  const unixType = (external >>> 16) & 0xf000;
  if (name !== expectedName || flags !== 0 || ![0, 8].includes(method) || unixType === 0xa000 || (external & 0x10)) {
    throw new Error('Archive contains an unexpected or unsafe member');
  }
  if (46 + nameLength + extraLength + commentLength !== centralSize || localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error('ZIP member metadata is invalid');
  }
  const localFlags = archive.readUInt16LE(localOffset + 6);
  const localMethod = archive.readUInt16LE(localOffset + 8);
  const localChecksum = archive.readUInt32LE(localOffset + 14);
  const localCompressedSize = archive.readUInt32LE(localOffset + 18);
  const localSize = archive.readUInt32LE(localOffset + 22);
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + compressedSize;
  if (
    localOffset !== 0 || localFlags !== flags || localMethod !== method || localChecksum !== checksum ||
    localCompressedSize !== compressedSize || localSize !== size || localName !== name || dataEnd !== centralOffset ||
    size > 200 * 1024 * 1024
  ) throw new Error('ZIP member metadata is invalid');
  const compressed = archive.subarray(dataOffset, dataEnd);
  const executable = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: 200 * 1024 * 1024 });
  if (executable.length !== size || crc32(executable) !== checksum) throw new Error('ZIP member integrity check failed');
  return executable;
}

async function install(options) {
  const { version, platform, arch, packageRoot, baseUrl, beforeCommit } = options;
  const target = resolveTarget(platform, arch, version);
  const releaseUrl = `${baseUrl.replace(/\/$/, '')}/v${version}`;
  const [archive, sums] = await Promise.all([
    download(`${releaseUrl}/${target.asset}`, options),
    download(`${releaseUrl}/SHA256SUMS`, { ...options, maxBytes: 1024 * 1024 }),
  ]);
  const expected = expectedChecksum(sums.toString('utf8'), target.asset);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (!timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw new Error('Release checksum mismatch');
  const bundle = await download(`${releaseUrl}/${target.asset}.sigstore.json`, { ...options, maxBytes: 1024 * 1024 });
  const verification = await mkdtemp(join(tmpdir(), 'provod-provenance-'));
  try {
    const archiveFile = join(verification, target.asset);
    const bundleFile = `${archiveFile}.sigstore.json`;
    await writeFile(archiveFile, archive, { mode: 0o600, flag: 'wx' });
    await writeFile(bundleFile, bundle, { mode: 0o600, flag: 'wx' });
    await execute('cosign', ['verify-blob-attestation', '--new-bundle-format=true', '--type', 'slsaprovenance1',
      '--bundle', bundleFile, '--certificate-identity', `https://github.com/provod-ai/cli-source/.github/workflows/native-release.yml@refs/tags/v${version}`,
      '--certificate-oidc-issuer', 'https://token.actions.githubusercontent.com', archiveFile], { timeout: 120000, maxBuffer: 1024 * 1024, shell: false });
  } catch { throw new Error('Release provenance verification failed; install a trusted Cosign locally'); }
  finally { await rm(verification, { recursive: true, force: true }); }
  const executable = target.asset.endsWith('.tar.gz')
    ? extractTarGz(archive, target.executable)
    : extractZip(archive, target.executable);
  const vendor = join(packageRoot, 'vendor');
  const destination = join(vendor, target.executable);
  const staged = join(vendor, `.${target.executable}.${randomUUID()}.tmp`);
  await mkdir(vendor, { recursive: true });
  try {
    await writeFile(staged, executable, { mode: 0o755, flag: 'wx' });
    await chmod(staged, 0o755);
    if (beforeCommit) await beforeCommit(staged);
    await rename(staged, destination);
  } finally {
    await rm(staged, { force: true });
  }
  return destination;
}

module.exports = { download, expectedChecksum, extractTarGz, extractZip, install, resolveRedirect, resolveTarget, validateVersion };
