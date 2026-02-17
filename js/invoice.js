// Invoice helpers for Worklog
const Invoice = {
  settingsKeyPrefix: 'worklog_invoice_settings_v1',

  getDefaultSettings() {
    return {
      contractorCompany: '',
      contractorId: '',
      currency: 'USD',
      hourlyRate: '',
      bankInfo: '',
      paymentMethod: ''
    };
  },

  settingsKey(userLogin) {
    const normalized = String(userLogin || '').trim().toLowerCase();
    return `${this.settingsKeyPrefix}:${normalized}`;
  },

  loadSettings(userLogin) {
    const defaults = this.getDefaultSettings();
    if (!userLogin) return defaults;

    const raw = localStorage.getItem(this.settingsKey(userLogin));
    if (!raw) return defaults;

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return defaults;
      return {
        ...defaults,
        ...parsed
      };
    } catch (err) {
      return defaults;
    }
  },

  saveSettings(userLogin, settings) {
    if (!userLogin) return;
    const payload = {
      ...this.getDefaultSettings(),
      ...(settings || {})
    };
    localStorage.setItem(this.settingsKey(userLogin), JSON.stringify(payload));
  },

  normalizeDescription(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    return normalized || '(no description)';
  },

  normalizeDescriptionKey(text) {
    return this.normalizeDescription(text).toLowerCase();
  },

  toDateValue(date, timeZone) {
    const parts = Time.getZonedParts(date, timeZone);
    return Time.formatDateValue(parts);
  },

  startOfDayFromParts(parts, timeZone) {
    return Time.zonedPartsToDate({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 0,
      minute: 0,
      second: 0
    }, timeZone);
  },

  addDays(date, days, timeZone) {
    const parts = Time.getZonedParts(date, timeZone);
    const normalized = new Date(Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days,
      0,
      0,
      0
    ));

    return Time.zonedPartsToDate({
      year: normalized.getUTCFullYear(),
      month: normalized.getUTCMonth() + 1,
      day: normalized.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0
    }, timeZone);
  },

  getPresetRange(preset, options = {}) {
    const timeZone = options.timeZone || Time.getTimeZone();
    const now = options.now instanceof Date ? options.now : new Date();
    const nowParts = Time.getZonedParts(now, timeZone);
    const todayStart = this.startOfDayFromParts(nowParts, timeZone);
    let startDate = todayStart;
    let endExclusive = this.addDays(todayStart, 1, timeZone);

    if (preset === 'this-week') {
      const weekday = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day)).getUTCDay();
      const diff = (weekday === 0 ? -6 : 1) - weekday;
      startDate = this.startOfDayFromParts({
        year: nowParts.year,
        month: nowParts.month,
        day: nowParts.day + diff
      }, timeZone);
      endExclusive = this.addDays(todayStart, 1, timeZone);
    } else if (preset === 'this-month') {
      startDate = this.startOfDayFromParts({
        year: nowParts.year,
        month: nowParts.month,
        day: 1
      }, timeZone);
      endExclusive = this.addDays(todayStart, 1, timeZone);
    } else if (preset === 'last-month') {
      let year = nowParts.year;
      let month = nowParts.month - 1;
      if (month < 1) {
        month = 12;
        year -= 1;
      }

      startDate = this.startOfDayFromParts({ year, month, day: 1 }, timeZone);
      endExclusive = this.startOfDayFromParts({
        year: nowParts.year,
        month: nowParts.month,
        day: 1
      }, timeZone);
    }

    const endDate = this.addDays(endExclusive, -1, timeZone);

    return {
      preset,
      timeZone,
      startDate,
      endExclusive,
      startValue: this.toDateValue(startDate, timeZone),
      endValue: this.toDateValue(endDate, timeZone)
    };
  },

  parseRange(startValue, endValue, options = {}) {
    const timeZone = options.timeZone || Time.getTimeZone();
    const startParts = Time.parseDateValue(startValue);
    const endParts = Time.parseDateValue(endValue);

    if (!startParts || !endParts) {
      return { ok: false, error: 'Select a valid start and end date.' };
    }

    const startDate = this.startOfDayFromParts(startParts, timeZone);
    const endDate = this.startOfDayFromParts(endParts, timeZone);

    if (endDate < startDate) {
      return { ok: false, error: 'End date must be on or after start date.' };
    }

    const endExclusive = this.addDays(endDate, 1, timeZone);

    return {
      ok: true,
      startDate,
      endExclusive,
      startValue: this.toDateValue(startDate, timeZone),
      endValue: this.toDateValue(endDate, timeZone)
    };
  },

  coerceRecordRange(record, defaultDurationMs) {
    const endAtValue = record && (record.endAt || record.end_at);
    const startAtValue = record && (record.startAt || record.start_at);
    const fallbackDurationMs = Math.max(60 * 1000, Math.floor(Number(defaultDurationMs) || 60 * 60 * 1000));

    let endDate = endAtValue ? new Date(endAtValue) : null;
    let startDate = startAtValue ? new Date(startAtValue) : null;

    if (startDate && Number.isNaN(startDate.getTime())) startDate = null;
    if (endDate && Number.isNaN(endDate.getTime())) endDate = null;

    let durationMs = Number(record && record.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      durationMs = fallbackDurationMs;
    } else {
      durationMs = Math.max(60 * 1000, Math.floor(durationMs));
    }

    if (!startDate && endDate) {
      startDate = new Date(endDate.getTime() - durationMs);
    }

    if (!endDate && startDate) {
      endDate = new Date(startDate.getTime() + durationMs);
    }

    if (!startDate || !endDate) {
      return null;
    }

    if (endDate <= startDate) {
      return null;
    }

    return { startDate, endDate };
  },

  preparePreview({ logs, userLogin, rangeStart, rangeEndExclusive, defaultDurationMs }) {
    const safeLogs = Array.isArray(logs) ? logs : [];
    const grouped = new Map();
    const rawEntries = [];
    const rangeStartMs = rangeStart.getTime();
    const rangeEndMs = rangeEndExclusive.getTime();
    const wantedLogin = String(userLogin || '').trim().toLowerCase();
    let totalDurationMs = 0;

    for (const record of safeLogs) {
      const recordLogin = String(record && (record.userLogin || record.user_login) || '').trim().toLowerCase();
      if (wantedLogin && recordLogin && recordLogin !== wantedLogin) {
        continue;
      }

      const coerced = this.coerceRecordRange(record, defaultDurationMs);
      if (!coerced) continue;

      const overlapStartMs = Math.max(rangeStartMs, coerced.startDate.getTime());
      const overlapEndMs = Math.min(rangeEndMs, coerced.endDate.getTime());
      const overlapMs = overlapEndMs - overlapStartMs;
      if (overlapMs <= 0) continue;

      totalDurationMs += overlapMs;

      const rawText = String(record && record.text || '');
      const description = this.normalizeDescription(rawText);
      const key = this.normalizeDescriptionKey(description);

      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          description,
          totalDurationMs: 0,
          entriesCount: 0
        });
      }

      const item = grouped.get(key);
      item.totalDurationMs += overlapMs;
      item.entriesCount += 1;

      rawEntries.push({
        path: String(record && record.path || ''),
        description,
        text: rawText,
        startAt: new Date(overlapStartMs),
        endAt: new Date(overlapEndMs),
        durationMs: overlapMs
      });
    }

    rawEntries.sort((a, b) => a.endAt - b.endAt);

    const groupedLines = Array.from(grouped.values())
      .map(item => ({
        ...item,
        totalHours: item.totalDurationMs / (60 * 60 * 1000)
      }))
      .sort((a, b) => {
        if (b.totalDurationMs !== a.totalDurationMs) {
          return b.totalDurationMs - a.totalDurationMs;
        }
        return a.description.localeCompare(b.description);
      });

    return {
      rawEntries,
      groupedLines,
      totalDurationMs,
      totalHours: totalDurationMs / (60 * 60 * 1000)
    };
  },

  formatHours(durationMs) {
    return (Math.max(0, Number(durationMs) || 0) / (60 * 60 * 1000)).toFixed(2);
  },

  formatMoney(amount, currency) {
    const value = Number(amount) || 0;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency || 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(value);
    } catch (err) {
      return `${value.toFixed(2)} ${currency || 'USD'}`;
    }
  },

  escapeYaml(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  },

  generateNumber(userLogin, issueDate, timeZone) {
    const date = this.toDateValue(issueDate, timeZone);
    const safeUser = String(userLogin || '').trim().toLowerCase() || 'unknown';
    return `${date}-${safeUser}`;
  },

  generateFilename({ userLogin, rangeStart, rangeEnd, timeZone }) {
    const safeUser = String(userLogin || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-') || 'unknown';
    const from = this.toDateValue(rangeStart, timeZone);
    const to = this.toDateValue(rangeEnd, timeZone);
    return `${from}_${to}.${safeUser}.invoice.yaml`;
  },

  buildYaml({
    userLogin,
    timeZone,
    rangeStart,
    rangeEnd,
    settings,
    groupedLines,
    totalDurationMs
  }) {
    const now = new Date();
    const dueDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const currency = settings.currency || 'USD';
    const hourlyRate = Number(settings.hourlyRate || 0);
    const totalHours = Math.max(0, Number(totalDurationMs) || 0) / (60 * 60 * 1000);
    const totalAmount = totalHours * hourlyRate;

    const lines = Array.isArray(groupedLines) ? groupedLines : [];
    const lineBlocks = lines.length > 0
      ? lines.map((line) => {
        const lineHours = Number(line.totalHours || 0);
        const lineAmount = lineHours * hourlyRate;
        return [
          '    - description: "' + this.escapeYaml(line.description) + '"',
          '      hours: ' + lineHours.toFixed(2),
          '      entries: ' + Math.max(0, Number(line.entriesCount || 0)),
          '      amount: ' + lineAmount.toFixed(2)
        ].join('\n');
      }).join('\n')
      : '    []';

    const bankInfoLines = String(settings.bankInfo || '')
      .split(/\r?\n/)
      .map(line => `    ${line}`)
      .join('\n');

    const taxIdLine = settings.contractorId
      ? `  tax_id: "${this.escapeYaml(settings.contractorId)}"\n`
      : '';

    return `# Invoice\n# Generated by Worklog\n\ninvoice:\n  number: "${this.escapeYaml(this.generateNumber(userLogin, now, timeZone))}"\n  issue_date: "${this.toDateValue(now, timeZone)}"\n  due_date: "${this.toDateValue(dueDate, timeZone)}"\n  period_start: "${this.toDateValue(rangeStart, timeZone)}"\n  period_end: "${this.toDateValue(rangeEnd, timeZone)}"\n  timezone: "${this.escapeYaml(timeZone)}"\n  currency: "${this.escapeYaml(currency)}"\n\ncontractor:\n  company: "${this.escapeYaml(settings.contractorCompany)}"\n${taxIdLine}service:\n  items:\n${lineBlocks}\n  total_hours: ${totalHours.toFixed(2)}\n  hourly_rate: ${hourlyRate.toFixed(2)}\n  total_amount: ${totalAmount.toFixed(2)}\n\npayment:\n  method: "${this.escapeYaml(settings.paymentMethod)}"\n  bank_info: |\n${bankInfoLines}\n  status: "pending"\n`;
  },

  downloadYaml(filename, content) {
    const blob = new Blob([String(content || '')], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
};
