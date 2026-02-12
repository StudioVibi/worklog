class GitHubApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = options.status || 500;
    this.body = options.body;
    this.retryAfterMs = options.retryAfterMs || 0;
    this.rateLimitRemaining = options.rateLimitRemaining;
    this.rateLimitResetMs = options.rateLimitResetMs || 0;
    this.isThrottle = options.isThrottle === true;
  }
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseRetryAfterMs(headerValue) {
  const asNumber = Number(headerValue);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return asNumber * 1000;
  }
  return 0;
}

function parseRateInfo(headers) {
  const remaining = toNumber(headers.get('x-ratelimit-remaining'));
  const resetEpoch = toNumber(headers.get('x-ratelimit-reset'));
  const resetMs = resetEpoch ? Math.max(0, resetEpoch * 1000 - Date.now()) : 0;
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after'));

  return {
    remaining,
    resetMs,
    retryAfterMs
  };
}

class GitHubClient {
  constructor(options) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.pat = options.pat;

    this.repoInfoCache = null;
    this.repoInfoCachedAt = 0;
  }

  isEnabled() {
    return !!this.pat;
  }

  get repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async request(method, path, { json, headers = {} } = {}) {
    if (!this.pat) {
      throw new Error('GITHUB_PAT is not configured');
    }

    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.pat}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'worklog-backend',
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: json ? JSON.stringify(json) : undefined
    });

    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    let payload = null;

    if (response.status !== 204) {
      if (isJson) {
        payload = await response.json().catch(() => null);
      } else {
        payload = await response.text().catch(() => null);
      }
    }

    const rateInfo = parseRateInfo(response.headers);

    if (!response.ok) {
      const rawMessage = payload && typeof payload === 'object' ? payload.message : null;
      const message = rawMessage || `${method} ${path} failed with ${response.status}`;
      const lower = String(message).toLowerCase();
      const isThrottle =
        response.status === 429 ||
        lower.includes('secondary rate limit') ||
        lower.includes('abuse detection') ||
        (response.status === 403 && lower.includes('rate limit')) ||
        (response.status === 403 && rateInfo.remaining === 0);

      throw new GitHubApiError(message, {
        status: response.status,
        body: payload,
        retryAfterMs: rateInfo.retryAfterMs,
        rateLimitRemaining: rateInfo.remaining,
        rateLimitResetMs: rateInfo.resetMs,
        isThrottle
      });
    }

    return {
      data: payload,
      rateInfo
    };
  }

  async getRateLimit() {
    const { data, rateInfo } = await this.request('GET', '/rate_limit');
    const core = data && data.resources && data.resources.core ? data.resources.core : {};

    return {
      remaining: Number(core.remaining ?? rateInfo.remaining ?? 0),
      limit: Number(core.limit ?? 0),
      resetMs: Number(core.reset ? Math.max(0, core.reset * 1000 - Date.now()) : rateInfo.resetMs)
    };
  }

  async getRepoInfo() {
    const now = Date.now();
    if (this.repoInfoCache && now - this.repoInfoCachedAt < 60_000) {
      return this.repoInfoCache;
    }

    const { data } = await this.request('GET', this.repoPath);
    this.repoInfoCache = data;
    this.repoInfoCachedAt = now;
    return data;
  }

  async getDefaultBranch() {
    const repo = await this.getRepoInfo();
    return repo.default_branch || 'main';
  }

  async getHeadCommit(branchOverride = null) {
    const branch = branchOverride || await this.getDefaultBranch();
    const encodedBranch = encodeURIComponent(branch);
    const { data } = await this.request('GET', `${this.repoPath}/commits/${encodedBranch}`);

    return {
      branch,
      commitSha: data.sha,
      treeSha: data && data.commit && data.commit.tree ? data.commit.tree.sha : null
    };
  }

  async createBlob(content) {
    const { data } = await this.request('POST', `${this.repoPath}/git/blobs`, {
      json: {
        content: String(content || ''),
        encoding: 'utf-8'
      }
    });
    return data;
  }

  async createTree(baseTreeSha, entries) {
    const payload = {
      tree: entries
    };
    if (baseTreeSha) {
      payload.base_tree = baseTreeSha;
    }

    const { data } = await this.request('POST', `${this.repoPath}/git/trees`, {
      json: payload
    });

    return data;
  }

  async createCommit(message, treeSha, parentSha) {
    const { data } = await this.request('POST', `${this.repoPath}/git/commits`, {
      json: {
        message,
        tree: treeSha,
        parents: parentSha ? [parentSha] : []
      }
    });

    return data;
  }

  async updateBranchRef(branch, commitSha) {
    const encodedBranch = encodeURIComponent(branch);
    const { data } = await this.request('PATCH', `${this.repoPath}/git/refs/heads/${encodedBranch}`, {
      json: {
        sha: commitSha,
        force: false
      }
    });

    return data;
  }

  async commitFiles(files, { message }) {
    if (!Array.isArray(files) || files.length === 0) {
      return null;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const head = await this.getHeadCommit();
      const blobShasByPath = new Map();
      const treeEntries = [];

      for (const file of files) {
        const blob = await this.createBlob(file.content);
        blobShasByPath.set(file.path, blob.sha);
        treeEntries.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha
        });
      }

      const tree = await this.createTree(head.treeSha, treeEntries);
      const commit = await this.createCommit(message, tree.sha, head.commitSha);

      try {
        await this.updateBranchRef(head.branch, commit.sha);
        return {
          branch: head.branch,
          commitSha: commit.sha,
          blobShasByPath
        };
      } catch (err) {
        if (err instanceof GitHubApiError && err.status === 422 && attempt === 0) {
          continue;
        }
        throw err;
      }
    }

    throw new Error('Failed to update GitHub branch ref');
  }

  async compareCommits(base, head) {
    const ref = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const { data } = await this.request('GET', `${this.repoPath}/compare/${ref}`);
    return data;
  }

  async listLogsTree(branchOverride = null) {
    const branch = branchOverride || await this.getDefaultBranch();
    const encoded = encodeURIComponent(branch);
    const { data } = await this.request('GET', `${this.repoPath}/git/trees/${encoded}?recursive=1`);

    if (!data || !Array.isArray(data.tree)) return [];
    return data.tree.filter(entry => entry.type === 'blob' && entry.path && entry.path.startsWith('logs/'));
  }

  async getBlobContent(sha) {
    const { data } = await this.request('GET', `${this.repoPath}/git/blobs/${encodeURIComponent(sha)}`);
    const content = data && data.content ? String(data.content).replace(/\n/g, '') : '';
    if (!content) return '';
    return Buffer.from(content, 'base64').toString('utf8');
  }
}

module.exports = {
  GitHubClient,
  GitHubApiError
};
