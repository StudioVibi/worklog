// GitHub API helpers for Worklog
const GitHub = {
  owner: 'StudioVibi',
  repo: 'worklogs',

  token: null,
  tokenKey: null,
  user: null,
  repoInfo: null,

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
    this.repoInfo = null;
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
      const err = new Error(error.message || `API error: ${response.status}`);
      err.status = response.status;
      throw err;
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

  async getRepoInfo() {
    if (this.repoInfo) return this.repoInfo;
    this.repoInfo = await this.api(`/repos/${this.owner}/${this.repo}`);
    return this.repoInfo;
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
    try {
      const repoInfo = await this.getRepoInfo();
      const branch = repoInfo.default_branch || 'main';
      const tree = await this.api(`/repos/${this.owner}/${this.repo}/git/trees/${branch}?recursive=1`);
      if (!tree.tree) return [];
      return tree.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith('logs/'));
    } catch (err) {
      if (err.status === 404) {
        return [];
      }
      if (String(err.message).toLowerCase().includes('not found')) {
        return [];
      }
      throw err;
    }
  },

  async getHeadCommitSha() {
    try {
      const repoInfo = await this.getRepoInfo();
      const branch = repoInfo.default_branch || 'main';
      const commit = await this.api(`/repos/${this.owner}/${this.repo}/commits/${branch}`);
      return commit.sha;
    } catch (err) {
      if (err.status === 404) {
        return null;
      }
      throw err;
    }
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
