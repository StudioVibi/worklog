// Main Worklog app
const App = {
  elements: {},
  logsByPath: new Map(),
  isLoadingLogs: false,

  isPaused: false,
  isAwaitingLog: false,
  elapsedMs: 0,
  lastTick: null,
  timerInterval: null,
  pollInterval: null,

  user: null,
  audioCtx: null,

  init() {
    this.cacheElements();
    this.bindEvents();
    this.restoreDraft();
    this.setupAudioUnlock();

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
      sessionStatus: document.getElementById('session-status'),
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
    this.elements.registerLog.addEventListener('click', () => this.submitLog());
    this.elements.cancelLog.addEventListener('click', () => this.cancelLog());

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
    this.elapsedMs = 0;
    this.lastTick = Date.now();
    this.isPaused = false;
    this.isAwaitingLog = false;
    this.updateStatus();
    this.updateCounter();

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

    if (this.elapsedMs >= 60 * 60 * 1000 && !this.isAwaitingLog) {
      this.elapsedMs = 60 * 60 * 1000;
      this.promptLog();
    }

    this.updateCounter();
  },

  updateCounter() {
    if (this.isPaused) {
      this.elements.counter.textContent = 'Unregistered: paused';
      this.updateStatus();
      return;
    }

    if (this.isAwaitingLog) {
      this.elements.counter.textContent = 'Unregistered: 60m';
      this.updateStatus();
      return;
    }

    const minutes = Math.min(60, Math.floor(this.elapsedMs / 60000));
    this.elements.counter.textContent = `Unregistered: ${minutes}m`;
    this.updateStatus();
  },

  updateStatus() {
    if (this.isPaused) {
      this.elements.sessionStatus.textContent = 'Paused';
      return;
    }

    if (this.isAwaitingLog) {
      this.elements.sessionStatus.textContent = 'Awaiting log';
      return;
    }

    this.elements.sessionStatus.textContent = 'In session';
  },

  togglePause() {
    if (this.isAwaitingLog) return;
    this.isPaused = !this.isPaused;
    this.elements.pauseBtn.textContent = this.isPaused ? 'Resume' : 'Pause';
    this.lastTick = Date.now();
    this.updateCounter();
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

  promptLog() {
    this.isAwaitingLog = true;
    this.updateStatus();
    this.showModal(this.elements.logModal);
    this.playBeep();
    setTimeout(() => this.elements.logText.focus(), 100);
  },

  cancelLog() {
    const ok = window.confirm('Cancel this hour? It will not be logged.');
    if (!ok) return;

    this.resetAfterLog();
    this.hideModal(this.elements.logModal);
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
      const filename = this.buildFilename(now, this.user.login);
      const path = `logs/${filename}`;

      await GitHub.createLogFile(path, text);
      this.addLogLocal(path, text);
      this.toast('Log registered', 'success');

      this.resetAfterLog();
      this.hideModal(this.elements.logModal);
    } catch (err) {
      console.error(err);
      this.toast(`Failed to register: ${err.message}`, 'error');
    } finally {
      this.elements.registerLog.disabled = false;
      this.elements.registerLog.textContent = 'Register';
    }
  },

  resetAfterLog() {
    this.isAwaitingLog = false;
    this.elapsedMs = 0;
    this.lastTick = Date.now();
    this.updateCounter();
  },

  buildFilename(date, username) {
    const pad = (num) => String(num).padStart(2, '0');
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());
    const second = pad(date.getSeconds());

    return `${year}-${month}-${day}.${hour}h${minute}m${second}s.${username}.txt`;
  },

  parseLogPath(path) {
    const filename = path.split('/').pop();
    const parts = filename.split('.');

    if (parts.length < 4) return null;

    const date = parts[0];
    const timeRaw = parts[1];
    const username = parts[2];
    const match = timeRaw.match(/(\d{2})h(\d{2})m(\d{2})s/);
    const time = match ? `${match[1]}:${match[2]}:${match[3]}` : timeRaw;

    return { date, time, username };
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

  async loadLogs() {
    if (this.isLoadingLogs) return;
    this.isLoadingLogs = true;

    try {
      if (this.logsByPath.size === 0) {
        this.elements.logLoading.classList.remove('hidden');
      }
      const entries = await GitHub.listLogTree();
      const newEntries = entries.filter(entry => !this.logsByPath.has(entry.path));

      if (newEntries.length === 0) {
        this.updateLogUI();
        return;
      }

      const batchSize = 10;
      for (let i = 0; i < newEntries.length; i += batchSize) {
        const batch = newEntries.slice(i, i + batchSize);
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

      this.renderLogs();
    } catch (err) {
      console.error(err);
      this.toast(`Failed to load logs: ${err.message}`, 'error');
      this.updateLogUI();
    } finally {
      this.isLoadingLogs = false;
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
      meta.textContent = `${log.date} ${log.time} • @${log.username}`;

      const text = document.createElement('div');
      text.className = 'log-text';
      text.textContent = log.text;

      item.appendChild(meta);
      item.appendChild(text);
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

    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.value = 0.15;

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.25);
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
