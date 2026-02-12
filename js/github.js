// Backend auth + API helpers for Worklog
const GitHub = {
  owner: 'StudioVibi',
  repo: 'worklogs',

  user: null,
  apiBase: null,

  init() {
    // Always attempt session restore through /v1/auth/me.
    return true;
  },

  getApiBase() {
    if (this.apiBase !== null) {
      return this.apiBase;
    }

    const fromWindow = typeof window !== 'undefined' ? window.WORKLOG_API_BASE : '';
    const fromMeta = typeof document !== 'undefined'
      ? (document.querySelector('meta[name="worklog-api-base"]')?.getAttribute('content') || '')
      : '';
    const fromStorage = localStorage.getItem('worklog_api_base') || '';

    const picked = String(fromWindow || fromMeta || fromStorage || '').trim();
    this.apiBase = picked.replace(/\/$/, '');
    return this.apiBase;
  },

  buildApiUrl(endpoint) {
    const base = this.getApiBase();
    if (!base) return endpoint;
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
    return `${base}${endpoint}`;
  },

  beginLogin() {
    window.location.href = this.buildApiUrl('/v1/auth/login');
  },

  async logout() {
    try {
      await this.backend('/v1/auth/logout', {
        method: 'POST'
      });
    } catch (err) {
      // best-effort logout
    }

    this.user = null;
  },

  async backend(endpoint, options = {}) {
    const headers = {
      ...(options.headers || {})
    };

    const hasBody = options.body !== undefined && options.body !== null;
    if (hasBody && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(this.buildApiUrl(endpoint), {
      ...options,
      headers,
      credentials: 'include'
    });

    let payload = null;
    const contentType = response.headers.get('content-type') || '';
    if (response.status !== 204) {
      if (contentType.includes('application/json')) {
        payload = await response.json().catch(() => null);
      } else {
        const text = await response.text().catch(() => '');
        payload = text ? { error: text } : null;
      }
    }

    if (!response.ok) {
      const err = new Error(payload?.error || payload?.message || `API error: ${response.status}`);
      err.status = response.status;

      const retryAfter = Number(response.headers.get('Retry-After'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        err.retryAfterMs = retryAfter * 1000;
      }

      const remaining = Number(response.headers.get('X-RateLimit-Remaining'));
      if (Number.isFinite(remaining)) {
        err.rateLimitRemaining = remaining;
      }

      const resetEpoch = Number(response.headers.get('X-RateLimit-Reset'));
      if (Number.isFinite(resetEpoch) && resetEpoch > 0) {
        err.rateLimitResetMs = Math.max(0, resetEpoch * 1000 - Date.now());
      }

      const message = String(err.message || '').toLowerCase();
      err.isThrottle =
        err.status === 429 ||
        message.includes('throttle') ||
        message.includes('rate limit') ||
        message.includes('abuse detection') ||
        (err.status === 403 && err.rateLimitRemaining === 0);

      throw err;
    }

    return payload;
  },

  async getUser() {
    if (this.user) return this.user;
    this.user = await this.backend('/v1/auth/me');
    return this.user;
  },

  async listLogs(params = {}) {
    const search = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value === null || value === undefined || value === '') return;
      search.set(key, String(value));
    });

    const suffix = search.toString() ? `?${search.toString()}` : '';
    return await this.backend(`/v1/logs${suffix}`);
  },

  async createLog({ idempotencyKey, ...payload }) {
    const headers = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return await this.backend('/v1/logs', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
  },

  async getSyncStatus() {
    return await this.backend('/v1/sync/status');
  },

  // Legacy compatibility helpers
  async createLogFile(path, content) {
    return await this.createLog({
      path,
      text: content,
      timezone: 'America/Sao_Paulo'
    });
  },

  async getHeadCommitSha() {
    const status = await this.getSyncStatus();
    const outbound = status?.syncState?.github_outbound?.lastSeenCommitSha;
    const inbound = status?.syncState?.github_inbound?.lastSeenCommitSha;
    return outbound || inbound || null;
  },

  async listLogTree() {
    const response = await this.listLogs({ limit: 10000 });
    const logs = Array.isArray(response?.logs) ? response.logs : [];
    return logs.map(log => ({
      path: log.path,
      sha: log.path
    }));
  },

  async compareCommits(base, head) {
    if (!base || !head) {
      return { status: 'ahead', files: [] };
    }
    return { status: base === head ? 'identical' : 'ahead', files: [] };
  },

  async getBlobContent() {
    return '';
  }
};
