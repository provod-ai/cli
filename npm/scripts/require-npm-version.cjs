'use strict';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function requireTrustedPublishingNpm(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error('npm 11.5.1 or newer is required');
  }
  const [major, minor, patch] = version.split('.', 3).map(Number);
  if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) {
    throw new Error('npm 11.5.1 or newer is required');
  }
  return version;
}

if (require.main === module) {
  try {
    requireTrustedPublishingNpm(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { requireTrustedPublishingNpm };
