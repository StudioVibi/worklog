const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getZonedParts,
  zonedPartsToDate,
  formatDateValue,
  formatTimeValue,
  daysInMonth
} = require('../src/services/timezone');

const SP = 'America/Sao_Paulo';

test('getZonedParts renders a UTC instant in Sao Paulo wall-clock (UTC-3)', () => {
  // Brazil has no DST since 2019, so Sao Paulo is a stable UTC-3.
  const instant = new Date('2026-06-08T12:00:00.000Z');
  const parts = getZonedParts(instant, SP);
  assert.deepEqual(parts, {
    year: 2026,
    month: 6,
    day: 8,
    hour: 9,
    minute: 0,
    second: 0
  });
});

test('getZonedParts respects an arbitrary zone (New York, EDT = UTC-4 in June)', () => {
  const instant = new Date('2026-06-08T12:00:00.000Z');
  const parts = getZonedParts(instant, 'America/New_York');
  assert.equal(parts.hour, 8);
  assert.equal(parts.day, 8);
});

test('zonedPartsToDate is the inverse of getZonedParts (round-trip to the second)', () => {
  for (const iso of [
    '2026-06-08T12:34:56.000Z',
    '2026-01-15T03:00:00.000Z',
    '2025-12-31T23:59:59.000Z'
  ]) {
    const instant = new Date(iso);
    const parts = getZonedParts(instant, SP);
    const restored = zonedPartsToDate(parts, SP);
    assert.equal(restored.getTime(), instant.getTime(), `round-trip failed for ${iso}`);
  }
});

test('zonedPartsToDate interprets wall-clock parts in the given zone', () => {
  // Midnight Sao Paulo on 2026-01-15 is 03:00 UTC (UTC-3).
  const date = zonedPartsToDate(
    { year: 2026, month: 1, day: 15, hour: 0, minute: 0, second: 0 },
    SP
  );
  assert.equal(date.toISOString(), '2026-01-15T03:00:00.000Z');
});

test('the same wall-clock parts map to different instants across zones', () => {
  const parts = { year: 2026, month: 6, day: 8, hour: 9, minute: 0, second: 0 };
  const sp = zonedPartsToDate(parts, SP);
  const lisbon = zonedPartsToDate(parts, 'Europe/Lisbon');
  assert.notEqual(sp.getTime(), lisbon.getTime());
});

test('formatDateValue and formatTimeValue zero-pad', () => {
  const parts = { year: 2026, month: 3, day: 5, hour: 7, minute: 4, second: 9 };
  assert.equal(formatDateValue(parts), '2026-03-05');
  assert.equal(formatTimeValue(parts), '07:04:09');
});

test('daysInMonth handles leap and non-leap February', () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2026, 12), 31);
});
