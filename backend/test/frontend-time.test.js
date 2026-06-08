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

test('interpreting billing-zone parts is independent of the view zone (buildDate guarantee)', () => {
  // A log filename encodes 09:00 Sao Paulo; the reconstructed instant must be
  // 12:00Z no matter what zone the user is currently viewing in.
  const spParts = { year: 2026, month: 6, day: 8, hour: 9, minute: 0, second: 0 };
  const expected = '2026-06-08T12:00:00.000Z';

  for (const viewZone of [SP, 'Europe/Lisbon', 'America/New_York', 'Asia/Tokyo']) {
    Time.setTimeZone(viewZone);
    const instant = Time.zonedPartsToDate(spParts, Time.getBillingTimeZone());
    assert.equal(instant.toISOString(), expected, `wrong instant while viewing in ${viewZone}`);
  }
  Time.setTimeZone(SP);
});

test('view-zone round-trip matches the backend (UTC-3 in Sao Paulo)', () => {
  Time.setTimeZone(SP);
  const instant = new Date('2026-06-08T12:34:56.000Z');
  const parts = Time.getZonedParts(instant, SP);
  assert.equal(parts.hour, 9);
  const restored = Time.zonedPartsToDate(parts, SP);
  assert.equal(restored.getTime(), instant.getTime());
});
