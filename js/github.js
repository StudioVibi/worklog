// GitHub API helpers for Worklog
const GitHub = {
  owner: 'StudioVibi',
  repo: 'worklogs',

  token: null,
  tokenKey: null,
  user: null,

  init() {
    const keys = ['worklog_github_token', 'github_token'];
    for (const key of keys) {
      const saved = localStorage.getItem(key);
      if (saved) {
        this.token = saved;
        this.tokenKey = key;
        return true;
      }
    }
    return false;
  },

  setToken(token) {
    this.token = token;
    this.tokenKey = 'worklog_github_token';
    localStorage.setItem('worklog_github_token', token);
  },

  logout() {
    if (this.tokenKey === 'worklog_github_token') {
      localStorage.removeItem('worklog_github_token');
    }
    this.token = null;
    this.tokenKey = null;
    this.user = null;
  },

  async api(endpoint, options = {}) {
    const url = endpoint.startsWith('https://')
      ? endpoint
      : `https://api.github.com${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
        ...options.headers
      }
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `API error: ${response.status}`);
    }

    return await response.json();
  },

  async validateToken(token) {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!response.ok) {
      throw new Error('Invalid token');
    }

    return await response.json();
  },

  async getUser() {
    if (this.user) return this.user;
    this.user = await this.api('/user');
    return this.user;
  },

  async createLogFile(path, content) {
    const encoded = btoa(unescape(encodeURIComponent(content)));
    return await this.api(`/repos/${this.owner}/${this.repo}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `worklog: ${path}`,
        content: encoded
      })
    });
  },

  async listLogTree() {
    const tree = await this.api(`/repos/${this.owner}/${this.repo}/git/trees/main?recursive=1`);
    if (!tree.tree) return [];
    return tree.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith('logs/'));
  },

  async getHeadCommitSha() {
    const commit = await this.api(`/repos/${this.owner}/${this.repo}/commits/main`);
    return commit.sha;
  },

  async compareCommits(base, head) {
    const ref = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    return await this.api(`/repos/${this.owner}/${this.repo}/compare/${ref}`);
  },

  async getBlobContent(sha) {
    const blob = await this.api(`/repos/${this.owner}/${this.repo}/git/blobs/${sha}`);
    if (!blob.content) return '';
    const cleaned = blob.content.replace(/\n/g, '');
    return decodeURIComponent(escape(atob(cleaned)));
  }
};
