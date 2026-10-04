import { execFileSync } from 'node:child_process';
import process from 'node:process';

export class GitHubApiError extends Error {
  constructor(message, { status, response } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.response = response;
  }
}

export function repositoryFromRemote(remote) {
  const https = remote.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u);
  if (https) return https[1] + '/' + https[2];
  const ssh = remote.match(/^(?:git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/u);
  if (ssh) return ssh[1] + '/' + ssh[2];
  throw new Error('origin must be a GitHub repository URL');
}

export function githubToken({ env = process.env, exec = execFileSync } = {}) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (token) return token.trim();
  try {
    const fromCli = exec('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (fromCli) return fromCli;
  } catch {
    // Keep authentication diagnostics free of token material and account details.
  }
  throw new Error('Set GH_TOKEN/GITHUB_TOKEN or authenticate gh for github.com');
}

export function createGitHubClient({
  repositoryFullName, token = githubToken(), apiBaseUrl = process.env.GITHUB_API_URL || 'https://api.github.com/',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!/^[^/]+\/[^/]+$/u.test(repositoryFullName || '')) throw new Error('repositoryFullName must be owner/name');
  if (!token) throw new Error('GitHub token is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const repoPath = repositoryFullName.split('/').map(encodeURIComponent).join('/');
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : apiBaseUrl + '/';

  async function request(method, route, body) {
    const response = await fetchImpl(new URL(route, base), {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!response.ok) {
      const message = data && typeof data === 'object' && data.message ? data.message : response.statusText;
      throw new GitHubApiError('GitHub API ' + method + ' ' + route + ' failed (' + response.status + '): ' + message, {
        status: response.status, response: data,
      });
    }
    return { data, headers: response.headers };
  }

  async function allPages(route) {
    const items = [];
    let next = new URL(route, base);
    while (next) {
      const response = await request('GET', next.toString());
      if (!Array.isArray(response.data)) throw new Error('GitHub API returned a non-list for ' + route);
      items.push(...response.data);
      const link = response.headers.get('link') || '';
      const match = link.match(/<([^>]+)>;\s*rel="next"/u);
      next = match ? new URL(match[1]) : null;
    }
    return items;
  }

  return {
    repositoryFullName,
    async getBranchHead(branch) {
      const result = await request('GET', 'repos/' + repoPath + '/branches/' + encodeURIComponent(branch));
      return result.data.commit.sha;
    },
    async listClaimRefs() {
      return allPages('repos/' + repoPath + '/git/matching-refs/heads/stage2-claims/');
    },
    async listStage3ClaimRefs() {
      return allPages('repos/' + repoPath + '/git/matching-refs/heads/stage3-claims/');
    },
    async createClaimRef(batchId, sha) {
      const ref = 'refs/heads/stage2-claims/' + batchId;
      try {
        await request('POST', 'repos/' + repoPath + '/git/refs', { ref, sha });
        return true;
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 422
          && error.response?.message === 'Reference already exists') return false;
        throw error;
      }
    },
    async deleteClaimRef(batchId) {
      await request('DELETE', 'repos/' + repoPath + '/git/refs/heads/stage2-claims/' + encodeURIComponent(batchId));
    },
    async createStage3ClaimRef(batchId, attempt, sha) {
      const ref = 'refs/heads/stage3-claims/' + batchId + '-a' + attempt;
      try {
        await request('POST', 'repos/' + repoPath + '/git/refs', { ref, sha });
        return true;
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 422
          && error.response?.message === 'Reference already exists') return false;
        throw error;
      }
    },
    async deleteStage3ClaimRef(batchId, attempt) {
      await request('DELETE', 'repos/' + repoPath + '/git/refs/heads/stage3-claims/' + encodeURIComponent(batchId + '-a' + attempt));
    },
    async deleteBranch(branchName) {
      await request('DELETE', 'repos/' + repoPath + '/git/refs/heads/' + branchName.split('/').map(encodeURIComponent).join('/'));
    },
    async findIssuesForClaim(claimRef) {
      const issues = await allPages('repos/' + repoPath + '/issues?state=all&per_page=100');
      return issues.filter((issue) => !issue.pull_request && typeof issue.body === 'string' && issue.body.includes(claimRef));
    },
    async createIssue(issue) {
      const result = await request('POST', 'repos/' + repoPath + '/issues', issue);
      return result.data;
    },
    async updateIssue(issueNumber, update) {
      const result = await request('PATCH', 'repos/' + repoPath + '/issues/' + issueNumber, update);
      return result.data;
    },
    async addIssueComment(issueNumber, comment) {
      const result = await request('POST', 'repos/' + repoPath + '/issues/' + issueNumber + '/comments', { body: comment });
      return result.data;
    },
    async getPullRequest(prNumber) {
      const result = await request('GET', 'repos/' + repoPath + '/pulls/' + prNumber);
      return result.data;
    },
    async listPullRequests(state = 'open') {
      if (!['open', 'closed', 'all'].includes(state)) throw new Error('pull request state must be open, closed, or all');
      return allPages('repos/' + repoPath + '/pulls?state=' + state + '&per_page=100');
    },
    async createPullRequest({ title, body, head, base = 'master', draft = false }) {
      const result = await request('POST', 'repos/' + repoPath + '/pulls', { title, body, head, base, draft });
      return result.data;
    },
    async closePullRequest(prNumber) {
      const result = await request('PATCH', 'repos/' + repoPath + '/pulls/' + prNumber, { state: 'closed' });
      return result.data;
    },
    async updatePullRequestBody(prNumber, body) {
      const result = await request('PATCH', 'repos/' + repoPath + '/pulls/' + prNumber, { body });
      return result.data;
    },
    async markPullRequestReady(prNumber) {
      const pull = await request('GET', 'repos/' + repoPath + '/pulls/' + prNumber);
      const nodeId = pull.data.node_id;
      if (!nodeId) throw new Error('GitHub pull request has no GraphQL node id');
      const result = await request('POST', 'graphql', {
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }',
        variables: { id: nodeId },
      });
      if (result.data?.errors?.length || result.data?.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
        throw new Error('GitHub did not mark pull request #' + prNumber + ' ready for review');
      }
      return result.data.data.markPullRequestReadyForReview.pullRequest;
    },
    async getPullRequestSnapshot(prNumber) {
      const pullResult = await request('GET', 'repos/' + repoPath + '/pulls/' + prNumber);
      const pullRequest = pullResult.data;
      const commitPath = 'repos/' + repoPath + '/commits/' + encodeURIComponent(pullRequest.head.sha);
      const [reviews, inlineComments, conversationComments, combinedStatus, checks] = await Promise.all([
        allPages('repos/' + repoPath + '/pulls/' + prNumber + '/reviews?per_page=100'),
        allPages('repos/' + repoPath + '/pulls/' + prNumber + '/comments?per_page=100'),
        allPages('repos/' + repoPath + '/issues/' + prNumber + '/comments?per_page=100'),
        request('GET', commitPath + '/status'),
        request('GET', commitPath + '/check-runs?per_page=100'),
      ]);
      return {
        pullRequest,
        reviews,
        inlineComments,
        conversationComments,
        combinedStatus: combinedStatus.data,
        checkRuns: checks.data.check_runs || [],
      };
    },
  };
}
