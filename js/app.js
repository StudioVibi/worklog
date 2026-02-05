// Main Worklog app
const App = {
  elements: {},
  logsByPath: new Map(),
  isLoadingLogs: false,
  renderedPaths: [],
  renderedPathSet: new Set(),
  logsVersion: 0,
  lastSavedTimer: null,
  lastCounterText: '',

  isPaused: false,
  isAwaitingLog: false,
  isSavingLog: false,
  elapsedMs: 0,
  pendingMs: 0,
  lastTick: null,
  timerInterval: null,
  pollInterval: null,

  user: null,
  audioCtx: null,
  originalTitle: '',
  icons: {
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" fill="currentColor"></rect><rect x="14" y="5" width="4" height="14" fill="currentColor"></rect></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l10 7-10 7z" fill="currentColor"></path></svg>'
  },
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  storage: {
    elapsed: 'worklog_elapsed_ms',
    pending: 'worklog_pending_ms',
    paused: 'worklog_paused',
    awaiting: 'worklog_awaiting',
    timerState: 'worklog_timer_state',
    lastSeen: 'worklog_last_seen_sha',
    interval: 'worklog_interval_minutes',
    pendingLogs: 'worklog_pending_logs'
  },
  lastSeenSha: null,
  intervalMs: 60 * 60 * 1000,
  timeline: {
    scale: 'daily',
    periodCount: 0,
    periodWidth: { daily: 420, weekly: 240, monthly: 240 },
    bufferScreens: 4,
    anchorStart: null,
    initialized: false,
    adjusting: false,
    gridDirty: true,
    rowsDirty: true,
    renderScheduled: false
  },

  init() {
    this.cacheElements();
    this.bindEvents();
    this.restoreDraft();
    this.loadTimerState();
    this.loadLastSeen();
    this.loadInterval();
    this.setupAudioUnlock();
    this.originalTitle = document.title;

    if (GitHub.init()) {
      this.showMainScreen().catch(err => {
        console.error('Token invalid:', err);
        GitHub.logout();
        this.showLoginScreen();
      });
    } else {
      this.showLoginScreen();
    }
  },

  cacheElements() {
    this.elements = {
      loginScreen: document.getElementById('login-screen'),
      mainScreen: document.getElementById('main-screen'),
      loginBtn: document.getElementById('login-btn'),
      patInput: document.getElementById('pat-input'),
      logoutBtn: document.getElementById('logout-btn'),
      pauseBtn: document.getElementById('pause-btn'),
      helpBtn: document.getElementById('help-btn'),
      counter: document.getElementById('counter'),
      intervalInput: document.getElementById('interval-input'),
      userPill: document.getElementById('user-pill'),
      userAvatar: document.getElementById('user-avatar'),
      userName: document.getElementById('user-name'),
      logContainer: document.getElementById('log-container'),
      logList: document.getElementById('log-list'),
      logLoading: document.getElementById('log-loading'),
      logEmpty: document.getElementById('log-empty'),
      tabLogs: document.getElementById('tab-logs'),
      tabTimeline: document.getElementById('tab-timeline'),
      logsView: document.getElementById('logs-view'),
      timelineView: document.getElementById('timeline-view'),
      timelineScroll: document.getElementById('timeline-scroll'),
      timelineCanvas: document.getElementById('timeline-canvas'),
      timelineGrid: document.getElementById('timeline-grid'),
      timelineLabels: document.getElementById('timeline-labels'),
      timelineRows: document.getElementById('timeline-rows'),
      timelineTooltip: document.getElementById('timeline-tooltip'),
      logModal: document.getElementById('log-modal'),
      logDate: document.getElementById('log-date'),
      logTime: document.getElementById('log-time'),
      logHours: document.getElementById('log-hours'),
      logMinutes: document.getElementById('log-minutes'),
      logError: document.getElementById('log-error'),
      logText: document.getElementById('log-text'),
      registerLog: document.getElementById('register-log'),
      cancelLog: document.getElementById('cancel-log'),
      helpModal: document.getElementById('help-modal'),
      toastContainer: document.getElementById('toast-container')
    };
  },

  bindEvents() {
    this.elements.loginBtn.addEventListener('click', () => this.login());
    this.elements.logoutBtn.addEventListener('click', () => this.logout());
    this.elements.pauseBtn.addEventListener('click', () => this.togglePause());
    this.elements.helpBtn.addEventListener('click', () => this.showHelp());
    this.elements.counter.addEventListener('click', () => this.triggerManualLog());
    this.elements.userPill.addEventListener('click', () => this.openProfile());
    this.elements.registerLog.addEventListener('click', () => this.submitLog());
    this.elements.cancelLog.addEventListener('click', () => this.cancelLog());
    this.elements.intervalInput.addEventListener('change', () => this.updateInterval());
    this.elements.tabLogs.addEventListener('click', () => this.showLogsTab());
    this.elements.tabTimeline.addEventListener('click', () => this.showTimelineTab());

    document.querySelectorAll('.scale-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setTimelineScale(btn.dataset.scale));
    });

    this.elements.timelineScroll.addEventListener('scroll', () => this.handleTimelineScroll());

    this.elements.logText.addEventListener('input', () => {
      localStorage.setItem('worklog_draft', this.elements.logText.value);
    });

    [this.elements.logDate, this.elements.logTime, this.elements.logHours, this.elements.logMinutes].forEach(input => {
      if (!input) return;
      input.addEventListener('input', () => this.validateLogTimespan({ updatePending: true }));
      input.addEventListener('change', () => this.validateLogTimespan({ updatePending: true }));
    });

    this.elements.logText.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.submitLog();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === '?' && !this.isTyping(event)) {
        event.preventDefault();
        this.toggleIntervalVisibility();
      }
    });

    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => this.hideModal(this.elements.helpModal));
    });

    [this.elements.helpModal, this.elements.logModal].forEach(modal => {
      modal.addEventListener('click', (event) => {
        if (event.target === modal && modal === this.elements.helpModal) {
          this.hideModal(modal);
        }
      });
    });

    window.addEventListener('beforeunload', () => this.saveTimerState());
    window.addEventListener('resize', () => {
      if (this.isTimelineVisible()) {
        this.scheduleTimelineRender({ grid: true, rows: true });
      }
    });

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  },

  isTyping(event) {
    const target = event.target;
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
  },

  setupAudioUnlock() {
    const unlock = () => {
      if (!this.audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          this.audioCtx = new AudioContext();
        }
      }

      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };

    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  },

  restoreDraft() {
    const draft = localStorage.getItem('worklog_draft');
    if (draft) {
      this.elements.logText.value = draft;
    }
  },

  loadTimerState() {
    const packed = localStorage.getItem(this.storage.timerState);
    if (packed) {
      try {
        const data = JSON.parse(packed);
        if (data && typeof data === 'object') {
          if (typeof data.elapsed === 'number' && data.elapsed >= 0) {
            this.elapsedMs = data.elapsed;
          }
          if (typeof data.pending === 'number' && data.pending >= 0) {
            this.pendingMs = data.pending;
          }
          this.isPaused = data.paused === true;
          this.isAwaitingLog = data.awaiting === true && this.pendingMs > 0;
          this.lastSavedTimer = { ...data };
          return;
        }
      } catch (err) {
        // fall back to legacy keys
      }
    }

    const elapsed = Number(localStorage.getItem(this.storage.elapsed));
    const pending = Number(localStorage.getItem(this.storage.pending));
    const paused = localStorage.getItem(this.storage.paused);
    const awaiting = localStorage.getItem(this.storage.awaiting);

    if (!Number.isNaN(elapsed) && elapsed >= 0) {
      this.elapsedMs = elapsed;
    }

    if (!Number.isNaN(pending) && pending >= 0) {
      this.pendingMs = pending;
    }

    this.isPaused = paused === 'true';
    this.isAwaitingLog = awaiting === 'true' && this.pendingMs > 0;
  },

  loadInterval() {
    const stored = Number(localStorage.getItem(this.storage.interval));
    if (!Number.isNaN(stored) && stored >= 1 && stored <= 120) {
      this.intervalMs = stored * 60 * 1000;
    }
    this.elements.intervalInput.value = Math.round(this.intervalMs / 60000);
  },

  loadLastSeen() {
    const stored = localStorage.getItem(this.storage.lastSeen);
    if (stored) {
      this.lastSeenSha = stored;
    }
  },

  saveTimerState() {
    const data = {
      elapsed: Math.floor(this.elapsedMs),
      pending: Math.floor(this.pendingMs),
      paused: this.isPaused,
      awaiting: this.isAwaitingLog
    };

    const last = this.lastSavedTimer;
    if (
      last &&
      last.elapsed === data.elapsed &&
      last.pending === data.pending &&
      last.paused === data.paused &&
      last.awaiting === data.awaiting
    ) {
      return;
    }

    this.lastSavedTimer = { ...data };
    localStorage.setItem(this.storage.timerState, JSON.stringify(data));
  },

  saveLastSeen(sha) {
    if (!sha) return;
    this.lastSeenSha = sha;
    localStorage.setItem(this.storage.lastSeen, sha);
  },

  loadPendingLogs() {
    const raw = localStorage.getItem(this.storage.pendingLogs);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  },

  savePendingLogs(pending) {
    localStorage.setItem(this.storage.pendingLogs, JSON.stringify(pending));
  },

  addPendingLog(path, text) {
    const pending = this.loadPendingLogs();
    pending[path] = { text, ts: Date.now() };
    this.savePendingLogs(pending);
  },

  mergePendingLogs() {
    const pending = this.loadPendingLogs();
    let changed = false;
    const now = Date.now();
    const expiryMs = 2 * 60 * 60 * 1000;

    for (const [path, entry] of Object.entries(pending)) {
      if (this.logsByPath.has(path)) {
        delete pending[path];
        changed = true;
        continue;
      }

      if (!entry || !entry.text || !entry.ts || now - entry.ts > expiryMs) {
        delete pending[path];
        changed = true;
        continue;
      }

      const parsed = this.parseLogPath(path);
      if (!parsed) {
        delete pending[path];
        changed = true;
        continue;
      }

      this.logsByPath.set(path, this.buildLogEntry(path, parsed, entry.text));
      this.logsVersion += 1;
    }

    if (changed) {
      this.savePendingLogs(pending);
    }
  },

  updateInterval() {
    const raw = Number(this.elements.intervalInput.value);
    const minutes = Math.min(120, Math.max(1, Number.isNaN(raw) ? 60 : raw));
    this.intervalMs = minutes * 60 * 1000;
    this.elements.intervalInput.value = minutes;
    localStorage.setItem(this.storage.interval, String(minutes));

    if (!this.isAwaitingLog && !this.isPaused && this.elapsedMs >= this.intervalMs) {
      this.elapsedMs = this.intervalMs;
      this.promptLog(this.intervalMs);
    } else {
      this.updateCounter();
    }
  },

  toggleIntervalVisibility() {
    const control = this.elements.intervalInput?.closest('.interval-control');
    if (!control) return;
    control.classList.toggle('hidden');
  },

  showLoginScreen() {
    this.elements.loginScreen.classList.remove('hidden');
    this.elements.mainScreen.classList.add('hidden');
  },

  async showMainScreen() {
    this.user = await GitHub.getUser();
    this.elements.userAvatar.src = this.user.avatar_url;
    this.elements.userName.textContent = `@${this.user.login}`;

    this.elements.loginScreen.classList.add('hidden');
    this.elements.mainScreen.classList.remove('hidden');

    this.startTimer();
    await this.loadLogs();
    this.initTimeline();
    this.startPolling();
  },

  showLogsTab() {
    this.elements.logsView.classList.remove('hidden');
    this.elements.timelineView.classList.add('hidden');
    this.elements.tabLogs.classList.add('active');
    this.elements.tabTimeline.classList.remove('active');
  },

  showTimelineTab() {
    this.elements.logsView.classList.add('hidden');
    this.elements.timelineView.classList.remove('hidden');
    this.elements.tabLogs.classList.remove('active');
    this.elements.tabTimeline.classList.add('active');
    requestAnimationFrame(() => {
      const today = new Date();
      const periodStart = this.startOfPeriod(today, this.timeline.scale);
      this.ensureTimelineSized(periodStart, 'left');
      this.positionTimelineOnDate(periodStart, 'left');
      this.scheduleTimelineRender({ grid: true, rows: true });
    });
  },

  isTimelineVisible() {
    return !this.elements.timelineView.classList.contains('hidden');
  },

  openProfile() {
    if (!this.user) return;
    window.open(`https://github.com/${this.user.login}`, '_blank');
  },

  async login() {
    const token = this.elements.patInput.value.trim();

    if (!token) {
      this.toast('Paste your token above', 'error');
      return;
    }

    try {
      this.elements.loginBtn.disabled = true;
      this.elements.loginBtn.textContent = 'Validating...';

      await GitHub.validateToken(token);
      GitHub.setToken(token);

      this.toast('Signed in!', 'success');
      await this.showMainScreen();
    } catch (err) {
      console.error(err);
      this.toast('Token invalid or missing permissions', 'error');
    } finally {
      this.elements.loginBtn.disabled = false;
      this.elements.loginBtn.textContent = 'Sign in';
    }
  },

  logout() {
    this.stopTimers();
    GitHub.logout();
    this.logsByPath.clear();
    this.elements.logList.innerHTML = '';
    this.renderedPaths = [];
    this.renderedPathSet = new Set();
    this.logsVersion = 0;
    this.showLoginScreen();
  },

  startTimer() {
    this.stopTimers();
    this.lastTick = Date.now();
    this.setPauseButton(this.isPaused);
    this.updateCounter();

    if (this.isAwaitingLog && this.pendingMs > 0) {
      this.promptLog(this.pendingMs);
    } else if (!this.isPaused && this.elapsedMs >= this.intervalMs) {
      this.elapsedMs = this.intervalMs;
      this.promptLog(this.intervalMs);
    }

    this.timerInterval = setInterval(() => this.tick(), 1000);
  },

  stopTimers() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.timerInterval = null;
    this.pollInterval = null;
  },

  tick() {
    const now = Date.now();
    const delta = now - this.lastTick;
    this.lastTick = now;

    if (!this.isPaused && !this.isAwaitingLog) {
      this.elapsedMs += delta;
    }

    if (this.elapsedMs >= this.intervalMs && !this.isAwaitingLog) {
      this.elapsedMs = this.intervalMs;
      this.promptLog(this.intervalMs);
    }

    this.updateCounter();
    this.saveTimerState();
  },

  updateCounter() {
    const displayMs = this.isAwaitingLog ? this.pendingMs : this.elapsedMs;
    const text = `Worked: ${this.formatDuration(displayMs)}`;
    if (text !== this.lastCounterText) {
      this.elements.counter.textContent = text;
      this.lastCounterText = text;
    }
  },

  togglePause() {
    if (this.isAwaitingLog) return;
    this.isPaused = !this.isPaused;
    this.setPauseButton(this.isPaused);
    this.lastTick = Date.now();
    this.updateCounter();
    this.saveTimerState();
  },

  setPauseButton(isPaused) {
    this.elements.pauseBtn.innerHTML = isPaused ? this.icons.play : this.icons.pause;
    this.elements.pauseBtn.title = isPaused ? 'Resume' : 'Pause';
    this.elements.pauseBtn.setAttribute('aria-label', isPaused ? 'Resume' : 'Pause');
  },

  showHelp() {
    this.showModal(this.elements.helpModal);
  },

  showModal(modal) {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  },

  hideModal(modal) {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  },

  promptLog(durationMs) {
    this.pendingMs = durationMs;
    this.isAwaitingLog = true;
    this.showModal(this.elements.logModal);
    this.populateLogTimespan(durationMs);
    this.validateLogTimespan({ updatePending: true });
    this.playBeep();
    this.triggerAttention();
    this.saveTimerState();
    setTimeout(() => this.elements.logText.focus(), 100);
  },

  triggerManualLog() {
    if (this.isAwaitingLog) return;
    this.promptLog(this.elapsedMs);
    this.updateCounter();
  },

  cancelLog() {
    const ok = window.confirm('Erase this log? This time will NOT be logged, NOT counted as work hours, and NOT billable. If you actually worked, please fill the note and click Send.');
    if (!ok) return;

    this.resetAfterLog();
    this.hideModal(this.elements.logModal);
    this.clearLogError();
    this.clearAttention();
  },

  async submitLog() {
    if (!this.isAwaitingLog) return;

    const text = this.elements.logText.value.trim();
    if (!text) {
      this.toast('Please enter a short description', 'error');
      this.elements.logText.focus();
      return;
    }

    const timespan = this.validateLogTimespan({ updatePending: false });
    if (!timespan) {
      return;
    }

    this.isSavingLog = true;
    this.elements.registerLog.disabled = true;
    this.elements.registerLog.textContent = 'Saving...';

    try {
      const filename = this.buildFilename(timespan.endDate, this.user.login, timespan.durationMs);
      const path = `logs/${filename}`;

      await GitHub.createLogFile(path, text);
      this.addPendingLog(path, text);
      this.toast('Log sent', 'success');
      this.addLogLocal(path, text);

      this.resetAfterLog();
      this.hideModal(this.elements.logModal);
      this.clearLogError();
      this.clearAttention();
    } catch (err) {
      console.error(err);
      this.toast(`Failed to send: ${err.message}`, 'error');
    } finally {
      this.isSavingLog = false;
      this.elements.registerLog.textContent = 'Send';
      if (this.isAwaitingLog) {
        this.validateLogTimespan({ updatePending: false });
      } else {
        this.elements.registerLog.disabled = false;
      }
    }
  },

  resetAfterLog() {
    this.isAwaitingLog = false;
    this.elapsedMs = 0;
    this.pendingMs = 0;
    this.lastTick = Date.now();
    this.updateCounter();
    this.saveTimerState();
  },

  triggerAttention() {
    this.flashScreen();
    this.updateFavicon(true);
    this.sendNotification();
    this.vibrateDevice();
    this.setTitleAlert(true);
  },

  clearAttention() {
    this.updateFavicon(false);
    this.setTitleAlert(false);
  },

  flashScreen() {
    document.body.classList.remove('attention-flash');
    void document.body.offsetHeight;
    document.body.classList.add('attention-flash');
    setTimeout(() => document.body.classList.remove('attention-flash'), 1000);
  },

  setTitleAlert(active) {
    document.title = active ? 'Worklog — Action Needed' : this.originalTitle;
  },

  updateFavicon(active) {
    const favicon = document.getElementById('favicon');
    if (!favicon) return;
    const svg = active
      ? "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23b42318'/%3E%3Ctext x='50' y='62' font-size='58' text-anchor='middle' fill='%23ffffff' font-family='Arial'%3E!%3C/text%3E%3C/svg%3E"
      : "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23111111'/%3E%3Ctext x='50' y='62' font-size='58' text-anchor='middle' fill='%23ffffff' font-family='Arial'%3EW%3C/text%3E%3C/svg%3E";
    favicon.href = `data:image/svg+xml,${svg}`;
  },

  sendNotification() {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      new Notification('Worklog', {
        body: 'Time to send your work log.',
        silent: true
      });
    } catch (err) {
      console.warn('Notification failed', err);
    }
  },

  vibrateDevice() {
    if (navigator && typeof navigator.vibrate === 'function') {
      navigator.vibrate([120, 60, 120]);
    }
  },

  formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.max(0, Math.floor(totalSeconds / 60));
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
  },

  populateLogTimespan(durationMs) {
    const now = new Date();
    const parts = Time.getZonedParts(now);
    const totalMinutes = Math.max(1, Math.round((durationMs || 0) / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (this.elements.logDate) {
      this.elements.logDate.value = Time.formatDateValue(parts);
    }
    if (this.elements.logTime) {
      this.elements.logTime.value = Time.formatTimeValue(parts);
    }
    if (this.elements.logHours) {
      this.elements.logHours.value = String(hours);
    }
    if (this.elements.logMinutes) {
      this.elements.logMinutes.value = String(minutes);
    }
  },

  getTimespanFromInputs() {
    const dateValue = this.elements.logDate?.value;
    const timeValue = this.elements.logTime?.value;
    const hoursValue = this.elements.logHours?.value;
    const minutesValue = this.elements.logMinutes?.value;

    const dateParts = Time.parseDateValue(dateValue);
    if (!dateParts) {
      return { valid: false, error: 'Select a valid date.' };
    }

    const timeParts = Time.parseTimeValue(timeValue);
    if (!timeParts) {
      return { valid: false, error: 'Select a valid end time.' };
    }

    const hours = Number(hoursValue);
    const minutes = Number(minutesValue);
    if (!Number.isInteger(hours) || hours < 0) {
      return { valid: false, error: 'Enter valid hours.' };
    }
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
      return { valid: false, error: 'Minutes must be between 0 and 59.' };
    }

    const totalMinutes = hours * 60 + minutes;
    if (totalMinutes <= 0) {
      return { valid: false, error: 'Duration must be at least 1 minute.' };
    }

    const endDate = Time.zonedPartsToDate({
      year: dateParts.year,
      month: dateParts.month,
      day: dateParts.day,
      hour: timeParts.hour,
      minute: timeParts.minute,
      second: 0
    });

    const durationMs = totalMinutes * 60 * 1000;
    const startDate = new Date(endDate.getTime() - durationMs);

    return {
      valid: true,
      endDate,
      startDate,
      durationMs,
      dateValue: Time.formatDateValue(dateParts),
      timeValue: Time.formatTimeValue(timeParts)
    };
  },

  findOverlap(startDate, endDate) {
    if (!this.user || !this.user.login) return null;
    const username = this.user.login;

    for (const log of this.logsByPath.values()) {
      if (log.username !== username) continue;
      const end = log.dateObj || this.buildDate(log.date, log.time);
      if (!end) continue;
      if (!log.dateObj) log.dateObj = end;
      const duration = log.durationMs || this.intervalMs;
      const start = new Date(end.getTime() - duration);
      if (startDate < end && endDate > start) {
        return log;
      }
    }

    return null;
  },

  setLogError(message) {
    if (!this.elements.logError) return;
    this.elements.logError.textContent = message;
    this.elements.logError.classList.remove('hidden');
  },

  clearLogError() {
    if (!this.elements.logError) return;
    this.elements.logError.textContent = '';
    this.elements.logError.classList.add('hidden');
  },

  validateLogTimespan({ updatePending = false } = {}) {
    const result = this.getTimespanFromInputs();
    if (!result.valid) {
      this.setLogError(result.error);
      if (!this.isSavingLog) {
        this.elements.registerLog.disabled = true;
      }
      return null;
    }

    const overlap = this.findOverlap(result.startDate, result.endDate);
    if (overlap) {
      this.setLogError('This timespan overlaps an existing worklog from you.');
      if (!this.isSavingLog) {
        this.elements.registerLog.disabled = true;
      }
      return null;
    }

    this.clearLogError();
    if (!this.isSavingLog) {
      this.elements.registerLog.disabled = false;
    }
    if (updatePending) {
      this.pendingMs = result.durationMs;
      this.updateCounter();
    }
    return result;
  },

  buildFilename(date, username, durationMs) {
    const pad = (num) => String(num).padStart(2, '0');
    const parts = Time.getZonedParts(date);
    const year = parts.year;
    const month = pad(parts.month);
    const day = pad(parts.day);
    const hour = pad(parts.hour);
    const minute = pad(parts.minute);
    const second = pad(parts.second);
    const duration = this.formatDuration(durationMs || 0);

    return `${year}-${month}-${day}.${hour}h${minute}m${second}s.${duration}.${username}.txt`;
  },

  parseLogPath(path) {
    const filename = path.split('/').pop();
    const parts = filename.split('.');

    if (parts.length < 4) return null;

    const date = parts[0];
    const timeRaw = parts[1];
    const durationRaw = parts.length >= 5 ? parts[2] : null;
    const username = parts.length >= 5 ? parts[3] : parts[2];
    const match = timeRaw.match(/(\d{2})h(\d{2})m(\d{2})s/);
    const time = match ? `${match[1]}:${match[2]}:${match[3]}` : timeRaw;
    const durationMatch = durationRaw ? durationRaw.match(/(\d{2,})m(\d{2})s/) : null;
    const duration = durationMatch ? durationRaw : null;

    return { date, time, duration, username };
  },

  addLogLocal(path, text) {
    const parsed = this.parseLogPath(path);
    if (!parsed) return;

    this.logsByPath.set(path, this.buildLogEntry(path, parsed, text));
    this.logsVersion += 1;

    this.renderLogs();
  },

  buildLogEntry(path, parsed, text) {
    const dateObj = this.buildDate(parsed.date, parsed.time);
    return {
      path,
      ...parsed,
      dateObj,
      durationMs: this.parseDuration(parsed.duration),
      text
    };
  },

  async loadLogs(forceFull = false) {
    if (this.isLoadingLogs) return;
    this.isLoadingLogs = true;

    try {
      if (this.logsByPath.size === 0) {
        this.elements.logLoading.classList.remove('hidden');
      }

      const headSha = await GitHub.getHeadCommitSha();
      if (!headSha) {
        this.logsByPath.clear();
        this.lastSeenSha = null;
        this.updateLogUI();
        return;
      }

      if (forceFull || !this.lastSeenSha || this.logsByPath.size === 0) {
        await this.loadAllLogs(headSha);
        return;
      }

      await this.loadIncrementalLogs(headSha);
    } catch (err) {
      console.error(err);
      this.toast(`Failed to load logs: ${err.message}`, 'error');
      this.updateLogUI();
    } finally {
      this.isLoadingLogs = false;
    }
  },

  async loadAllLogs(headSha) {
    const entries = await GitHub.listLogTree();
    this.logsByPath.clear();
    this.renderedPaths = [];
    this.renderedPathSet = new Set();
    await this.storeEntries(entries, { skipExisting: false });
    this.mergePendingLogs();
    this.saveLastSeen(headSha);
    this.renderLogs();
  },

  async loadIncrementalLogs(headSha) {
    if (headSha === this.lastSeenSha) {
      this.updateLogUI();
      return;
    }

    let compare;
    try {
      compare = await GitHub.compareCommits(this.lastSeenSha, headSha);
    } catch (err) {
      await this.loadAllLogs(headSha);
      return;
    }

    if (!compare || !compare.status) {
      await this.loadAllLogs(headSha);
      return;
    }

    if (compare.status !== 'ahead' && compare.status !== 'identical') {
      await this.loadAllLogs(headSha);
      return;
    }

    const files = (compare.files || [])
      .filter(file => file.filename && file.filename.startsWith('logs/'))
      .filter(file => file.status !== 'removed')
      .map(file => ({ path: file.filename, sha: file.sha }));

    if (files.length >= 300) {
      await this.loadAllLogs(headSha);
      return;
    }

    if (files.length === 0) {
      this.saveLastSeen(headSha);
      this.updateLogUI();
      return;
    }

    await this.storeEntries(files, { skipExisting: true });
    this.mergePendingLogs();
    this.saveLastSeen(headSha);
    this.renderLogs();
  },

  async storeEntries(entries, { skipExisting }) {
    const targets = skipExisting
      ? entries.filter(entry => !this.logsByPath.has(entry.path))
      : entries;

    if (targets.length === 0) {
      return;
    }

    const batchSize = 10;
    let added = 0;
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize);
      const contents = await Promise.all(batch.map(item => GitHub.getBlobContent(item.sha)));

      batch.forEach((entry, index) => {
        const parsed = this.parseLogPath(entry.path);
        if (!parsed) return;
        this.logsByPath.set(entry.path, this.buildLogEntry(entry.path, parsed, contents[index]));
        added += 1;
      });
    }

    if (added > 0) {
      this.logsVersion += added;
    }
  },

  initTimeline() {
    if (this.timeline.initialized) return;
    this.timeline.initialized = true;
    this.timeline.gridDirty = true;
    this.timeline.rowsDirty = true;
  },

  scheduleTimelineRender({ grid = false, rows = false } = {}) {
    if (grid) this.timeline.gridDirty = true;
    if (rows) this.timeline.rowsDirty = true;
    if (!this.isTimelineVisible()) return;
    if (this.timeline.renderScheduled) return;
    this.timeline.renderScheduled = true;
    requestAnimationFrame(() => {
      this.timeline.renderScheduled = false;
      this.renderTimelineNow();
    });
  },

  renderTimelineNow() {
    if (!this.timeline.initialized) return;
    if (!this.isTimelineVisible()) return;
    if (!this.ensureTimelineSized()) return;
    if (this.timeline.gridDirty) {
      this.renderTimelineGrid();
      this.timeline.gridDirty = false;
    }
    if (this.timeline.rowsDirty) {
      this.renderTimelineRows();
      this.timeline.rowsDirty = false;
    }
  },

  ensureTimelineSized(anchorDate = null, align = 'center') {
    const viewWidth = this.elements.timelineScroll.clientWidth;
    if (!viewWidth) return false;

    const periodWidth = this.timeline.periodWidth[this.timeline.scale];
    const canvasWidth = Math.max(viewWidth * this.timeline.bufferScreens, periodWidth * 30);
    const periodCount = Math.ceil(canvasWidth / periodWidth);
    this.timeline.periodCount = periodCount;

    const totalWidth = periodCount * periodWidth;
    this.elements.timelineCanvas.style.width = `${totalWidth}px`;
    this.elements.timelineLabels.style.width = `${totalWidth}px`;

    if (!this.timeline.anchorStart || anchorDate) {
      const base = anchorDate || new Date();
      const offset = align === 'left' ? Math.floor(periodCount / 3) : Math.floor(periodCount / 2);
      this.timeline.anchorStart = this.startOfPeriod(
        this.addPeriods(base, -offset, this.timeline.scale),
        this.timeline.scale
      );
    }

    return true;
  },

  positionTimelineOnDate(date, align = 'center') {
    const viewWidth = this.elements.timelineScroll.clientWidth;
    if (!viewWidth) return;
    const totalWidth = this.timeline.periodCount * this.timeline.periodWidth[this.timeline.scale];
    const x = this.timeToX(date);
    const maxScroll = Math.max(0, totalWidth - viewWidth);
    const offset = align === 'left' ? 0 : viewWidth / 2;
    const target = Math.min(Math.max(0, x - offset), maxScroll);
    this.elements.timelineScroll.scrollLeft = target;
  },

  setTimelineScale(scale) {
    if (!scale || scale === this.timeline.scale) return;
    const today = new Date();

    this.timeline.scale = scale;
    document.querySelectorAll('.scale-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.scale === scale);
    });

    const periodStart = this.startOfPeriod(today, scale);
    this.timeline.anchorStart = null;
    this.ensureTimelineSized(periodStart, 'left');
    this.positionTimelineOnDate(periodStart, 'left');
    this.renderTimeline();
  },

  handleTimelineScroll() {
    if (this.timeline.adjusting) return;
    const scrollLeft = this.elements.timelineScroll.scrollLeft;
    const viewWidth = this.elements.timelineScroll.clientWidth;
    const totalWidth = this.timeline.periodCount * this.timeline.periodWidth[this.timeline.scale];
    const threshold = viewWidth;
    const shiftPeriods = Math.floor(this.timeline.periodCount / 3);
    const shiftWidth = shiftPeriods * this.timeline.periodWidth[this.timeline.scale];

    if (scrollLeft < threshold) {
      this.timeline.adjusting = true;
      this.timeline.anchorStart = this.addPeriods(this.timeline.anchorStart, -shiftPeriods, this.timeline.scale);
      this.elements.timelineScroll.scrollLeft = scrollLeft + shiftWidth;
      this.timeline.adjusting = false;
      this.renderTimeline();
      return;
    }

    if (scrollLeft > totalWidth - threshold) {
      this.timeline.adjusting = true;
      this.timeline.anchorStart = this.addPeriods(this.timeline.anchorStart, shiftPeriods, this.timeline.scale);
      this.elements.timelineScroll.scrollLeft = scrollLeft - shiftWidth;
      this.timeline.adjusting = false;
      this.renderTimeline();
      return;
    }
  },

  renderTimeline() {
    this.scheduleTimelineRender({ grid: true, rows: true });
  },

  renderTimelineGrid() {
    const grid = this.elements.timelineGrid;
    const labels = this.elements.timelineLabels;
    grid.innerHTML = '';
    labels.innerHTML = '';

    const scale = this.timeline.scale;
    const periodWidth = this.timeline.periodWidth[scale];
    const periods = this.timeline.periodCount;
    const gridFragment = document.createDocumentFragment();
    const labelFragment = document.createDocumentFragment();

    for (let i = 0; i <= periods; i += 1) {
      const x = i * periodWidth;
      const line = document.createElement('div');
      line.className = 'timeline-line';
      line.style.left = `${x}px`;
      gridFragment.appendChild(line);

      if (i < periods) {
        const label = document.createElement('div');
        label.className = 'timeline-label';
        const date = this.addPeriods(this.timeline.anchorStart, i, scale);
        label.textContent = this.formatPeriodLabel(date, scale);
        label.style.left = `${x + 4}px`;
        labelFragment.appendChild(label);
      }
    }

    grid.appendChild(gridFragment);
    labels.appendChild(labelFragment);
  },

  formatPeriodLabel(date, scale) {
    const parts = Time.getZonedParts(date);
    const year = parts.year;
    const month = this.months[parts.month - 1];
    const day = String(parts.day).padStart(2, '0');

    if (scale === 'daily') {
      return `${year} ${month} ${day}`;
    }
    if (scale === 'weekly') {
      return `Wk ${year} ${month} ${day}`;
    }
    return `${year} ${month}`;
  },

  renderTimelineRows() {
    const rows = this.elements.timelineRows;
    rows.innerHTML = '';

    const width = this.timeline.periodCount * this.timeline.periodWidth[this.timeline.scale];
    const rangeStart = this.timeline.anchorStart;
    const rangeEnd = this.addPeriods(rangeStart, this.timeline.periodCount, this.timeline.scale);
    const users = this.collectUsers();

    const fragment = document.createDocumentFragment();

    users.forEach(user => {
      const row = document.createElement('div');
      row.className = 'timeline-row';

      const userCell = document.createElement('a');
      userCell.className = 'timeline-user';
      userCell.href = `https://github.com/${user.username}`;
      userCell.target = '_blank';
      userCell.rel = 'noopener';
      userCell.title = user.username;

      const avatar = document.createElement('img');
      avatar.src = `https://github.com/${user.username}.png`;
      avatar.alt = user.username;
      userCell.appendChild(avatar);

      const track = document.createElement('div');
      track.className = 'timeline-track';
      track.style.width = `${width}px`;

      user.logs.forEach(log => {
        if (!log.dateObj) return;
        const durationMs = log.durationMs || this.intervalMs;
        const endTime = log.dateObj;
        const startTime = new Date(endTime.getTime() - durationMs);
        if (endTime < rangeStart || startTime > rangeEnd) return;
        const visibleStart = startTime < rangeStart ? rangeStart : startTime;
        const visibleEnd = endTime > rangeEnd ? rangeEnd : endTime;
        const visibleDuration = Math.max(0, visibleEnd - visibleStart);
        if (visibleDuration <= 0) return;
        const x = this.timeToX(visibleStart);
        let barWidth = this.durationToWidth(visibleStart, visibleDuration);
        const minWidth = 6;
        const isTiny = barWidth < minWidth;
        if (isTiny) barWidth = minWidth;

        const bar = document.createElement('div');
        bar.className = 'timeline-bar';
        bar.style.left = `${x}px`;
        bar.style.width = `${barWidth}px`;
        if (isTiny) {
          bar.classList.add('tiny');
        }

        bar.addEventListener('mouseenter', (event) => this.showTimelineTooltip(event, log));
        bar.addEventListener('mouseleave', () => this.hideTimelineTooltip());

        track.appendChild(bar);
      });

      row.appendChild(userCell);
      row.appendChild(track);
      fragment.appendChild(row);
    });

    rows.appendChild(fragment);
  },

  collectUsers() {
    const byUser = new Map();

    for (const log of this.logsByPath.values()) {
      if (!log.username) continue;
      const dateObj = log.dateObj || this.buildDate(log.date, log.time);
      if (!dateObj) continue;
      const entry = byUser.get(log.username) || [];
      if (!log.dateObj) {
        log.dateObj = dateObj;
      }
      entry.push(log);
      byUser.set(log.username, entry);
    }

    return Array.from(byUser.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([username, logs]) => ({
        username,
        logs: logs.sort((a, b) => a.dateObj - b.dateObj)
      }));
  },

  buildDate(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    const [year, month, day] = dateStr.split('-').map(Number);
    const timeParts = timeStr.split(':');
    const hour = Number(timeParts[0] || 0);
    const minute = Number(timeParts[1] || 0);
    const second = Number(timeParts[2] || 0);
    if (!year || !month || !day) return null;
    return Time.zonedPartsToDate({ year, month, day, hour, minute, second });
  },

  parseDuration(duration) {
    if (!duration) return 0;
    const match = duration.match(/(\d{2,})m(\d{2})s/);
    if (!match) return 0;
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    return (minutes * 60 + seconds) * 1000;
  },

  durationToWidth(startDate, durationMs) {
    const scale = this.timeline.scale;
    const periodWidth = this.timeline.periodWidth[scale];

    if (scale === 'daily') {
      return (durationMs / (24 * 60 * 60 * 1000)) * periodWidth;
    }

    if (scale === 'weekly') {
      return (durationMs / (7 * 24 * 60 * 60 * 1000)) * periodWidth;
    }

    const daysInMonth = this.daysInMonth(startDate);
    return (durationMs / (daysInMonth * 24 * 60 * 60 * 1000)) * periodWidth;
  },

  timeToX(date) {
    const scale = this.timeline.scale;
    const periodWidth = this.timeline.periodWidth[scale];
    const anchor = this.timeline.anchorStart;

    if (scale === 'daily') {
      return ((date - anchor) / (24 * 60 * 60 * 1000)) * periodWidth;
    }

    if (scale === 'weekly') {
      return ((date - anchor) / (7 * 24 * 60 * 60 * 1000)) * periodWidth;
    }

    const monthsDiff = this.monthDiff(anchor, date);
    const baseMonth = this.addMonths(anchor, monthsDiff);
    const daysInMonth = this.daysInMonth(baseMonth);
    const offset = (date - baseMonth) / (daysInMonth * 24 * 60 * 60 * 1000);
    return monthsDiff * periodWidth + offset * periodWidth;
  },

  dateFromX(x) {
    const scale = this.timeline.scale;
    const periodWidth = this.timeline.periodWidth[scale];
    const anchor = this.timeline.anchorStart;

    if (scale === 'daily') {
      const ms = (x / periodWidth) * (24 * 60 * 60 * 1000);
      return new Date(anchor.getTime() + ms);
    }

    if (scale === 'weekly') {
      const ms = (x / periodWidth) * (7 * 24 * 60 * 60 * 1000);
      return new Date(anchor.getTime() + ms);
    }

    const monthsDiff = Math.floor(x / periodWidth);
    const offset = x - monthsDiff * periodWidth;
    const baseMonth = this.addMonths(anchor, monthsDiff);
    const daysInMonth = this.daysInMonth(baseMonth);
    const ms = (offset / periodWidth) * (daysInMonth * 24 * 60 * 60 * 1000);
    return new Date(baseMonth.getTime() + ms);
  },

  startOfPeriod(date, scale) {
    const parts = Time.getZonedParts(date);
    let year = parts.year;
    let month = parts.month;
    let day = parts.day;

    if (scale === 'weekly') {
      const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      const diff = (weekday === 0 ? -6 : 1) - weekday;
      day += diff;
    }

    if (scale === 'monthly') {
      day = 1;
    }

    return Time.zonedPartsToDate({ year, month, day, hour: 0, minute: 0, second: 0 });
  },

  addPeriods(date, count, scale) {
    if (scale === 'daily') return this.addDays(date, count);
    if (scale === 'weekly') return this.addDays(date, count * 7);
    return this.addMonths(date, count);
  },

  addDays(date, days) {
    const parts = Time.getZonedParts(date);
    const normalized = new Date(Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days,
      parts.hour,
      parts.minute,
      parts.second
    ));

    return Time.zonedPartsToDate({
      year: normalized.getUTCFullYear(),
      month: normalized.getUTCMonth() + 1,
      day: normalized.getUTCDate(),
      hour: normalized.getUTCHours(),
      minute: normalized.getUTCMinutes(),
      second: normalized.getUTCSeconds()
    });
  },

  addMonths(date, months) {
    const parts = Time.getZonedParts(date);
    const totalMonths = parts.year * 12 + (parts.month - 1) + months;
    const year = Math.floor(totalMonths / 12);
    const monthIndex = totalMonths - year * 12;
    const month = monthIndex + 1;
    const max = Time.daysInMonthParts(year, month);
    const day = Math.min(parts.day, max);

    return Time.zonedPartsToDate({
      year,
      month,
      day,
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second
    });
  },

  daysInMonth(date) {
    const parts = Time.getZonedParts(date);
    return Time.daysInMonthParts(parts.year, parts.month);
  },

  monthDiff(start, end) {
    const startParts = Time.getZonedParts(start);
    const endParts = Time.getZonedParts(end);
    return (endParts.year - startParts.year) * 12 + (endParts.month - startParts.month);
  },

  showTimelineTooltip(event, log) {
    const tooltip = this.elements.timelineTooltip;
    const duration = log.duration || this.formatDuration(log.durationMs || this.intervalMs);
    tooltip.textContent = `${log.date} ${log.time}\n${duration}\n@${log.username}\n${log.text}`;
    tooltip.classList.remove('hidden');

    const padding = 12;
    const x = Math.min(window.innerWidth - tooltip.offsetWidth - padding, event.clientX + padding);
    const y = Math.min(window.innerHeight - tooltip.offsetHeight - padding, event.clientY + padding);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  },

  hideTimelineTooltip() {
    this.elements.timelineTooltip.classList.add('hidden');
  },

  renderLogs() {
    const paths = Array.from(this.logsByPath.keys()).sort();

    if (paths.length === 0) {
      this.elements.logList.innerHTML = '';
      this.renderedPaths = [];
      this.renderedPathSet = new Set();
      this.updateLogUI();
      this.scheduleTimelineRender({ rows: true });
      return;
    }

    const mustRebuild =
      this.renderedPaths.length === 0 ||
      paths.length < this.renderedPaths.length ||
      !this.renderedPathSet ||
      (this.renderedPaths.length > 0 && paths[0] !== this.renderedPaths[0]);

    if (mustRebuild) {
      const fragment = document.createDocumentFragment();
      for (const path of paths) {
        const log = this.logsByPath.get(path);
        if (!log) continue;
        fragment.appendChild(this.buildLogItem(log));
      }
      this.elements.logList.innerHTML = '';
      this.elements.logList.appendChild(fragment);
      this.renderedPaths = paths;
      this.renderedPathSet = new Set(paths);
      this.updateLogUI();
      this.scrollToBottom();
      this.scheduleTimelineRender({ rows: true });
      return;
    }

    const newPaths = paths.filter(path => !this.renderedPathSet.has(path));
    if (newPaths.length === 0) {
      this.updateLogUI();
      return;
    }

    newPaths.sort();
    const lastRendered = this.renderedPaths[this.renderedPaths.length - 1];
    if (newPaths[0] < lastRendered) {
      this.renderedPaths = [];
      this.renderedPathSet = new Set();
      this.renderLogs();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const path of newPaths) {
      const log = this.logsByPath.get(path);
      if (!log) continue;
      fragment.appendChild(this.buildLogItem(log));
      this.renderedPathSet.add(path);
      this.renderedPaths.push(path);
    }
    this.elements.logList.appendChild(fragment);
    this.updateLogUI();
    this.scrollToBottom();
    this.scheduleTimelineRender({ rows: true });
  },

  buildLogItem(log) {
    const item = document.createElement('div');
    item.className = 'log-item';

    const meta = document.createElement('div');
    meta.className = 'log-meta';
    meta.appendChild(document.createTextNode(`${log.date} ${log.time} `));

    if (log.duration) {
      meta.appendChild(document.createTextNode(`${log.duration} `));
    }

    const userLink = document.createElement('a');
    userLink.href = `https://github.com/${log.username}`;
    userLink.textContent = `@${log.username}`;
    userLink.target = '_blank';
    userLink.rel = 'noopener';
    userLink.className = 'log-user-link';
    meta.appendChild(userLink);

    const message = document.createElement('div');
    message.className = 'log-message';
    message.textContent = log.text;

    item.appendChild(meta);
    item.appendChild(message);
    return item;
  },

  updateLogUI() {
    const hasLogs = this.logsByPath.size > 0;
    this.elements.logLoading.classList.add('hidden');
    this.elements.logEmpty.classList.toggle('hidden', hasLogs);
  },

  scrollToBottom() {
    if (this.elements.logsView.classList.contains('hidden')) return;
    this.elements.logContainer.scrollTop = this.elements.logContainer.scrollHeight;
  },

  startPolling() {
    this.pollInterval = setInterval(() => this.loadLogs(), 5000);
  },

  playBeep() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      this.audioCtx = new AudioContext();
    }

    const ctx = this.audioCtx;
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    gain.connect(ctx.destination);

    const tones = [
      { freq: 440, start: now, duration: 0.18 },
      { freq: 660, start: now + 0.22, duration: 0.14 }
    ];

    tones.forEach(({ freq, start, duration }) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.connect(gain);

      // Soft attack/decay for a gentle chime
      gain.gain.setValueAtTime(0.0, start);
      gain.gain.linearRampToValueAtTime(0.06, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

      osc.start(start);
      osc.stop(start + duration);
    });
  },

  toast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`.trim();
    toast.textContent = message;
    this.elements.toastContainer.appendChild(toast);

    setTimeout(() => toast.remove(), 4000);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
