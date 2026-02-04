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
    interval: 'worklog_interval_minutes'
  },
  lastSeenSha: null,
  intervalMs: 60 * 60 * 1000,

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

    this.elements.logText.addEventListener('input', () => {
      localStorage.setItem('worklog_draft', this.elements.logText.value);
    });

    this.elements.logText.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.submitLog();
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
    this.startPolling();
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
    const durationMatch = durationRaw ? durationRaw.match(/(\d{2})m(\d{2})s/) : null;
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
