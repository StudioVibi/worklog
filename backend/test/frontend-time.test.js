const test = require('node:test');
const assert = require('node:assert/strict');

// The frontend Time helper is a browser global, but is pure (no DOM) and
// exports itself under Node for testing. Path is relative to this test file.
const Time = require('../../js/time.js');

const SP = 'America/Sao_Paulo';

test('billing timezone is Sao Paulo and is immutable across view changes', () => {
  assert.equal(Time.getBillingTimeZone(), SP);
  Time.setTimeZone('Europe/Lisbon');
  assert.equal(Time.getBillingTimeZone(), SP, 'billing zone must not follow the view zone');
  assert.equal(Time.getTimeZone(), 'Europe/Lisbon');
  Time.setTimeZone(SP); // reset for other tests
});

test('setTimeZone ignores empty values', () => {
  Time.setTimeZone('Europe/Lisbon');
  Time.setTimeZone('');
  assert.equal(Time.getTimeZone(), 'Europe/Lisbon');
  Time.setTimeZone(SP);
});

test('isBillingTimeZone only matches Sao Paulo', () => {
  assert.equal(Time.isBillingTimeZone(SP), true);
  assert.equal(Time.isBillingTimeZone('Europe/Lisbon'), false);
  assert.equal(Time.isBillingTimeZone(''), false);
  assert.equal(Time.isBillingTimeZone(null), false);
});

test('shortZoneLabel produces a friendly label', () => {
  assert.equal(Time.shortZoneLabel(SP), 'Sao Paulo');
  assert.equal(Time.shortZoneLabel('Europe/Lisbon'), 'Lisbon');
  assert.equal(Time.shortZoneLabel('America/New_York'), 'New York');
  assert.equal(Time.shortZoneLabel('UTC'), 'UTC');
});

test('detectLocalTimeZone returns a non-empty zone string', () => {
  const zone = Time.detectLocalTimeZone();
  assert.equal(typeof zone, 'string');
  assert.ok(zone.length > 0);
});

test('view-zone round-trip matches the backend (UTC-3 in Sao Paulo)', () => {
  Time.setTimeZone(SP);
  const instant = new Date('2026-06-08T12:34:56.000Z');
  const parts = Time.getZonedParts(instant, SP);
  assert.equal(parts.hour, 9);
  const restored = Time.zonedPartsToDate(parts, SP);
  assert.equal(restored.getTime(), instant.getTime());
});
