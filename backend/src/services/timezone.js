const formatterCache = new Map();

function getFormatter(timeZone) {
  const zone = timeZone || 'America/Sao_Paulo';
  if (formatterCache.has(zone)) {
    return formatterCache.get(zone);
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  formatterCache.set(zone, formatter);
  return formatter;
}

function getZonedParts(date, timeZone) {
  const formatter = getFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const out = {
    year: 0,
    month: 0,
    day: 0,
    hour: 0,
    minute: 0,
    second: 0
  };

  for (const part of parts) {
    if (part.type === 'year') out.year = Number(part.value);
    if (part.type === 'month') out.month = Number(part.value);
    if (part.type === 'day') out.day = Number(part.value);
    if (part.type === 'hour') out.hour = Number(part.value);
    if (part.type === 'minute') out.minute = Number(part.value);
    if (part.type === 'second') out.second = Number(part.value);
  }

  return out;
}

function normalizeParts(parts) {
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
    second: Number(parts.second || 0)
  };
}

function partsToUtc(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0
  );
}

function diffPartsInMinutes(actual, desired) {
  return (partsToUtc(desired) - partsToUtc(actual)) / (60 * 1000);
}

function zonedPartsToDate(parts, timeZone) {
  const zone = timeZone || 'America/Sao_Paulo';
  const normalized = normalizeParts(parts);
  const utcGuess = partsToUtc(normalized);
  let date = new Date(utcGuess);
  let actual = getZonedParts(date, zone);
  let diff = diffPartsInMinutes(actual, normalized);

  if (diff !== 0) {
    date = new Date(date.getTime() + diff * 60 * 1000);
    actual = getZonedParts(date, zone);
    diff = diffPartsInMinutes(actual, normalized);
    if (diff !== 0) {
      date = new Date(date.getTime() + diff * 60 * 1000);
    }
  }

  return date;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDateValue(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function formatTimeValue(parts) {
  return `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

module.exports = {
  getZonedParts,
  zonedPartsToDate,
  daysInMonth,
  pad2,
  formatDateValue,
  formatTimeValue
};
