// Time helpers for Worklog (default: Sao Paulo)
const Time = {
  timeZone: 'America/Sao_Paulo',
  tzFormatters: {},

  getTimeZone() {
    return this.timeZone || 'America/Sao_Paulo';
  },

  setTimeZone(timeZone) {
    if (!timeZone) return;
    this.timeZone = timeZone;
    this.tzFormatters = {};
  },

  getTimeZoneFormatter(timeZone) {
    const zone = timeZone || this.getTimeZone();
    if (!this.tzFormatters[zone]) {
      this.tzFormatters[zone] = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }
    return this.tzFormatters[zone];
  },

  getZonedParts(date, timeZone) {
    const formatter = this.getTimeZoneFormatter(timeZone);
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
  },

  normalizeParts(parts) {
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour || 0),
      minute: Number(parts.minute || 0),
      second: Number(parts.second || 0)
    };
  },

  partsToUtc(parts) {
    return Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour || 0,
      parts.minute || 0,
      parts.second || 0
    );
  },

  diffPartsInMinutes(actual, desired) {
    return (this.partsToUtc(desired) - this.partsToUtc(actual)) / (60 * 1000);
  },

  zonedPartsToDate(parts, timeZone) {
    const zone = timeZone || this.getTimeZone();
    const normalized = this.normalizeParts(parts);
    const utcGuess = this.partsToUtc(normalized);
    let date = new Date(utcGuess);
    let actual = this.getZonedParts(date, zone);
    let diff = this.diffPartsInMinutes(actual, normalized);

    if (diff !== 0) {
      date = new Date(date.getTime() + diff * 60 * 1000);
      actual = this.getZonedParts(date, zone);
      diff = this.diffPartsInMinutes(actual, normalized);
      if (diff !== 0) {
        date = new Date(date.getTime() + diff * 60 * 1000);
      }
    }

    return date;
  },

  daysInMonthParts(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  },

  pad2(value) {
    return String(value).padStart(2, '0');
  },

  formatDateValue(parts) {
    return `${parts.year}-${this.pad2(parts.month)}-${this.pad2(parts.day)}`;
  },

  formatTimeValue(parts) {
    return `${this.pad2(parts.hour)}:${this.pad2(parts.minute)}`;
  },

  parseDateValue(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!year || month < 1 || month > 12 || day < 1) return null;
    const maxDay = this.daysInMonthParts(year, month);
    if (day > maxDay) return null;
    return { year, month, day };
  },

  parseTimeValue(value) {
    const match = String(value || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }
};
