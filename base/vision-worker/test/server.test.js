const assert = require('node:assert/strict');
const test = require('node:test');

const { buildApp, isAuthorized, validatePublicHttps } = require('../app/server');

test('requires a configured token', () => {
  assert.throws(() => buildApp(), /required/);
});

test('compares bearer tokens', () => {
  assert.equal(isAuthorized('Bearer secret', 'secret'), true);
  assert.equal(isAuthorized('Bearer wrong', 'secret'), false);
  assert.equal(isAuthorized(undefined, 'secret'), false);
});

test('accepts public HTTPS and strips fragments', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.equal(await validatePublicHttps('https://example.com/a#b', lookup), 'https://example.com/a');
});

test('rejects unsafe destinations', async () => {
  const privateLookup = async () => [{ address: '10.0.0.8', family: 4 }];
  await assert.rejects(validatePublicHttps('http://example.com'), /public HTTPS/);
  await assert.rejects(validatePublicHttps('https://example.com:8443', privateLookup), /port 443/);
  await assert.rejects(validatePublicHttps('https://example.com', privateLookup), /blocked network/);
  await assert.rejects(validatePublicHttps('https://user:pass@example.com'), /without credentials/);
});
