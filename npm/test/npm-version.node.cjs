'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requireTrustedPublishingNpm } = require('../scripts/require-npm-version.cjs');

test('requires npm 11.5.1 or newer for Trusted Publishing', () => {
  for (const version of ['11.5.1', '11.5.2', '11.19.0', '12.0.0']) {
    assert.equal(requireTrustedPublishingNpm(version), version);
  }
  for (const version of ['10.99.99', '11.4.99', '11.5.0', 'invalid', '11.5']) {
    assert.throws(() => requireTrustedPublishingNpm(version), /npm 11\.5\.1 or newer is required/);
  }
});
