// Main Worklog app
const App = {
  elements: {},
  logsByPath: new Map(),
  isLoadingLogs: false,

  isPaused: false,
  isAwaitingLog: false,
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
  storage: {
    elapsed: 'worklog_elapsed_ms',
    pending: 'worklog_pending_ms',
    paused: 'worklog_paused',
    awaiting: 'worklog_awaiting',
    lastSeen: 'worklog_last_seen_sha',
    interval: 'worklog_interval_minutes',
    pendingLogs: 'worklog_pending_logs'
  },
  lastSeenSha: null,
  intervalMs: 60 * 60 * 1000,
  timeline: {
    scale: 'daily',
    periodCount: 120,
    periodWidth: { daily: 140, weekly: 200, monthly: 220 },
    anchorStart: null,
    initialized: false,
    adjusting: false
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
      viewTitle: document.getElementById('view-title'),
      tabLogs: document.getElementById('tab-logs'),
      tabTimeline: document.getElementById('tab-timeline'),
      logsView: document.getElementById('logs-view'),
      timelineView: document.getElementById('timeline-view'),
      timelineRange: document.getElementById('timeline-range'),
      timelineScroll: document.getElementById('timeline-scroll'),
      timelineCanvas: document.getElementById('timeline-canvas'),
      timelineGrid: document.getElementById('timeline-grid'),
      timelineRows: document.getElementById('timeline-rows'),
      timelineTooltip: document.getElementById('timeline-tooltip'),
      logModal: document.getElementById('log-modal'),
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
    localStorage.setItem(this.storage.elapsed, String(Math.floor(this.elapsedMs)));
    localStorage.setItem(this.storage.pending, String(Math.floor(this.pendingMs)));
    localStorage.setItem(this.storage.paused, this.isPaused ? 'true' : 'false');
    localStorage.setItem(this.storage.awaiting, this.isAwaitingLog ? 'true' : 'false');
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

      this.logsByPath.set(path, {
        path,
        ...parsed,
        text: entry.text
      });
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
    this.elements.viewTitle.textContent = 'Logs';
    this.elements.logsView.classList.remove('hidden');
    this.elements.timelineView.classList.add('hidden');
    this.elements.tabLogs.classList.add('active');
    this.elements.tabTimeline.classList.remove('active');
  },

  showTimelineTab() {
    this.elements.viewTitle.textContent = 'Timeline';
    this.elements.logsView.classList.add('hidden');
    this.elements.timelineView.classList.remove('hidden');
    this.elements.tabLogs.classList.remove('active');
    this.elements.tabTimeline.classList.add('active');
    this.renderTimeline();
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
    this.elements.counter.textContent = `Worked: ${this.formatDuration(displayMs)}`;
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
    const ok = window.confirm('Erase this hour? These minutes will NOT be logged, NOT counted as work hours, and NOT billable. If you actually worked, please fill the note and click Send.');
    if (!ok) return;

    this.resetAfterLog();
    this.hideModal(this.elements.logModal);
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

    this.elements.registerLog.disabled = true;
    this.elements.registerLog.textContent = 'Saving...';

    try {
      const now = new Date();
      const filename = this.buildFilename(now, this.user.login, this.pendingMs);
      const path = `logs/${filename}`;

      await GitHub.createLogFile(path, text);
      this.addPendingLog(path, text);
      this.addLogLocal(path, text);
      this.toast('Log sent', 'success');

      this.resetAfterLog();
      this.hideModal(this.elements.logModal);
      this.clearAttention();
    } catch (err) {
      console.error(err);
      this.toast(`Failed to send: ${err.message}`, 'error');
    } finally {
      this.elements.registerLog.disabled = false;
      this.elements.registerLog.textContent = 'Send';
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
    const minutes = Math.min(60, Math.floor(totalSeconds / 60));
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
  },

  buildFilename(date, username, durationMs) {
    const pad = (num) => String(num).padStart(2, '0');
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());
    const second = pad(date.getSeconds());
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
    const durationMatch = durationRaw ? durationRaw.match(/(\d{2,3})m(\d{2})s/) : null;
    const duration = durationMatch ? durationRaw : null;

    return { date, time, duration, username };
  },

  addLogLocal(path, text) {
    const parsed = this.parseLogPath(path);
    if (!parsed) return;

    this.logsByPath.set(path, {
      path,
      ...parsed,
      text
    });

    this.renderLogs();
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
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize);
      const contents = await Promise.all(batch.map(item => GitHub.getBlobContent(item.sha)));

      batch.forEach((entry, index) => {
        const parsed = this.parseLogPath(entry.path);
        if (!parsed) return;
        this.logsByPath.set(entry.path, {
          path: entry.path,
          ...parsed,
          text: contents[index]
        });
      });
    }
  },

  initTimeline() {
    if (this.timeline.initialized) return;
    this.timeline.initialized = true;

    const now = new Date();
    const half = Math.floor(this.timeline.periodCount / 2);
    this.timeline.anchorStart = this.startOfPeriod(
      this.addPeriods(now, -half, this.timeline.scale),
      this.timeline.scale
    );

    this.updateTimelineCanvas();

    requestAnimationFrame(() => {
      this.centerTimeline();
      this.renderTimeline();
    });
  },

  updateTimelineCanvas() {
    const width = this.timeline.periodCount * this.timeline.periodWidth[this.timeline.scale];
    this.elements.timelineCanvas.style.width = `${width}px`;
  },

  centerTimeline() {
    const totalWidth = this.timeline.periodCount * this.timeline.periodWidth[this.timeline.scale];
    const viewWidth = this.elements.timelineScroll.clientWidth;
    const target = Math.max(0, (totalWidth - viewWidth) / 2);
    this.elements.timelineScroll.scrollLeft = target;
  },

  setTimelineScale(scale) {
    if (!scale || scale === this.timeline.scale) return;

    const centerDate = this.dateFromX(
      this.elements.timelineScroll.scrollLeft + this.elements.timelineScroll.clientWidth / 2
    );

    this.timeline.scale = scale;
    document.querySelectorAll('.scale-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.scale === scale);
    });

    const half = Math.floor(this.timeline.periodCount / 2);
    this.timeline.anchorStart = this.startOfPeriod(
      this.addPeriods(centerDate, -half, this.timeline.scale),
      this.timeline.scale
    );

    this.updateTimelineCanvas();
    this.centerTimeline();
    this.renderTimeline();
  },

  handleTimelineScroll() {
    if (this.timeline.adjusting) return;
    const totalWidth = this.timeline.periodCount * this.timeline.periodWidth[this.timeline.scale];
    const scrollLeft = this.elements.timelineScroll.scrollLeft;
    const threshold = totalWidth * 0.2;
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

    this.updateTimelineRange();
  },

  updateTimelineRange() {
    const start = this.dateFromX(this.elements.timelineScroll.scrollLeft);
    const end = this.dateFromX(this.elements.timelineScroll.scrollLeft + this.elements.timelineScroll.clientWidth);
    this.elements.timelineRange.textContent = `${this.formatRangeDate(start)} — ${this.formatRangeDate(end)}`;
  },

  formatRangeDate(date) {
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
  },

  renderTimeline() {
    if (!this.timeline.initialized) return;
    this.updateTimelineCanvas();
    this.renderTimelineGrid();
    this.renderTimelineRows();
    this.updateTimelineRange();
  },

  renderTimelineGrid() {
    const grid = this.elements.timelineGrid;
    grid.innerHTML = '';

    const scale = this.timeline.scale;
    const periodWidth = this.timeline.periodWidth[scale];
    const periods = this.timeline.periodCount;

    for (let i = 0; i <= periods; i += 1) {
      const x = i * periodWidth;
      const line = document.createElement('div');
      line.className = 'timeline-line';
      line.style.left = `${x}px`;
      grid.appendChild(line);

      if (i < periods) {
        const label = document.createElement('div');
        label.className = 'timeline-label';
        const date = this.addPeriods(this.timeline.anchorStart, i, scale);
        label.textContent = this.formatPeriodLabel(date, scale);
        label.style.left = `${x + 4}px`;
        grid.appendChild(label);
      }
    }
  },

  formatPeriodLabel(date, scale) {
    if (scale === 'daily') {
      return date.toLocaleDateString(undefined, { month: 'short', day: '2-digit' });
    }
    if (scale === 'weekly') {
      return `Wk ${date.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })}`;
    }
    return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  },

  renderTimelineRows() {
    const rows = this.elements.timelineRows;
    rows.innerHTML = '';

    const width = this.timeline.periodCount * this.timeline.periodWidth[this.timeline.scale];
    const rangeStart = this.timeline.anchorStart;
    const rangeEnd = this.addPeriods(rangeStart, this.timeline.periodCount, this.timeline.scale);
    const users = this.collectUsers();

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
        if (log.dateObj < rangeStart || log.dateObj > rangeEnd) return;
        const x = this.timeToX(log.dateObj);
        const durationMs = this.parseDuration(log.duration) || this.intervalMs;
        const barWidth = Math.max(4, this.durationToWidth(log.dateObj, durationMs));

        const bar = document.createElement('div');
        bar.className = 'timeline-bar';
        bar.style.left = `${x}px`;
        bar.style.width = `${barWidth}px`;

        bar.addEventListener('mouseenter', (event) => this.showTimelineTooltip(event, log));
        bar.addEventListener('mouseleave', () => this.hideTimelineTooltip());

        track.appendChild(bar);
      });

      row.appendChild(userCell);
      row.appendChild(track);
      rows.appendChild(row);
    });
  },

  collectUsers() {
    const byUser = new Map();

    for (const log of this.logsByPath.values()) {
      if (!log.username) continue;
      const dateObj = this.buildDate(log.date, log.time);
      if (!dateObj) continue;
      const entry = byUser.get(log.username) || [];
      entry.push({ ...log, dateObj });
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
    const [hour, minute, second] = timeStr.split(':').map(Number);
    if (!year || !month || !day) return null;
    return new Date(year, month - 1, day, hour || 0, minute || 0, second || 0);
  },

  parseDuration(duration) {
    if (!duration) return 0;
    const match = duration.match(/(\d{2,3})m(\d{2})s/);
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
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);

    if (scale === 'weekly') {
      const day = d.getDay();
      const diff = (day === 0 ? -6 : 1) - day;
      d.setDate(d.getDate() + diff);
    }

    if (scale === 'monthly') {
      d.setDate(1);
    }

    return d;
  },

  addPeriods(date, count, scale) {
    if (scale === 'daily') return this.addDays(date, count);
    if (scale === 'weekly') return this.addDays(date, count * 7);
    return this.addMonths(date, count);
  },

  addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  },

  addMonths(date, months) {
    const d = new Date(date);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const max = this.daysInMonth(d);
    d.setDate(Math.min(day, max));
    return d;
  },

  daysInMonth(date) {
    const d = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return d.getDate();
  },

  monthDiff(start, end) {
    return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  },

  showTimelineTooltip(event, log) {
    const tooltip = this.elements.timelineTooltip;
    const duration = log.duration || this.formatDuration(this.parseDuration(log.duration) || this.intervalMs);
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
    this.elements.logList.innerHTML = '';

    for (const path of paths) {
      const log = this.logsByPath.get(path);
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
      this.elements.logList.appendChild(item);
    }

    this.updateLogUI();
    this.scrollToBottom();
    this.renderTimeline();
  },

  updateLogUI() {
    const hasLogs = this.logsByPath.size > 0;
    this.elements.logLoading.classList.add('hidden');
    this.elements.logEmpty.classList.toggle('hidden', hasLogs);
  },

  scrollToBottom() {
    this.elements.logContainer.scrollTop = this.elements.logContainer.scrollHeight;
  },

  startPolling() {
    this.pollInterval = setInterval(() => this.loadLogs(), 20000);
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
