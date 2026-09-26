'use strict';

const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { install } = require('../lib/installer.cjs');

async function main() {
  const packageRoot = join(__dirname, '..');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const destination = await install({
    version: manifest.version,
    platform: process.platform,
    arch: process.arch,
    packageRoot,
    baseUrl: 'https://github.com/provod-ai/cli/releases/download',
  });
  process.stdout.write(`Installed Provod CLI ${manifest.version} at ${destination}\n`);
}

main().catch((error) => {
  process.stderr.write(`Failed to install Provod CLI: ${error.message}\n`);
  process.exitCode = 1;
});
