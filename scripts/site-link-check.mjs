const PAGES_ORIGIN = 'https://kygoyuan2004.github.io';
const PAGES_BASE = '/Second-Mind/';
const REPOSITORY_ORIGIN = 'https://github.com';
const REPOSITORIES = new Map([
  ['/kygoyuan2004/Second-Mind', '1351979511'],
  ['/kygoyuan2004/Second_Mind_PIAGENT_OPTIMIZE', '1471358957'],
]);

function safeLocation(url) {
  return `${url.origin}${url.pathname}`;
}

function repositoryPath(pathname) {
  return [...REPOSITORIES.keys()].some(base => pathname === base || pathname.startsWith(base + '/'));
}

export function classifyExternalLink(reference) {
  let url;
  try {
    url = new URL(reference);
  } catch {
    return { kind: 'invalid', message: 'external link is not an absolute URL' };
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search) {
    return {
      kind: 'invalid',
      message: `external link must use query-free HTTPS without credentials or a custom port: ${safeLocation(url)}`,
    };
  }

  if (url.origin === PAGES_ORIGIN) {
    if (url.pathname !== PAGES_BASE.slice(0, -1) && !url.pathname.startsWith(PAGES_BASE)) {
      return { kind: 'invalid', message: `Pages link escapes ${PAGES_BASE}: ${safeLocation(url)}` };
    }
    const pathname = url.pathname === PAGES_BASE.slice(0, -1) ? PAGES_BASE : url.pathname;
    return { kind: 'site', reference: `${pathname}${url.hash}` };
  }

  if (url.origin !== REPOSITORY_ORIGIN || !repositoryPath(url.pathname)) {
    return {
      kind: 'invalid',
      message: `external link host or path is not allowlisted: ${safeLocation(url)}`,
    };
  }

  return {
    kind: 'network',
    url: url.href,
    display: safeLocation(url),
  };
}

function releaseAssetRedirect(source, destination) {
  const original = new URL(source);
  const final = new URL(destination, original);
  if (final.origin !== 'https://release-assets.githubusercontent.com' || final.username || final.password || final.port) return false;
  for (const [repo, id] of REPOSITORIES) {
    if (original.pathname.startsWith(repo + '/releases/download/') &&
        /^v\d+\.\d+\.\d+\/[\w.-]+$/.test(original.pathname.slice((repo + '/releases/download/').length)) &&
        final.pathname.startsWith('/github-production-release-asset/' + id + '/')) return true;
  }
  return false;
}

function successfulStatus(status) {
  return status >= 200 && status < 300;
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // A response status is sufficient; body cleanup is best effort.
  }
}

async function request(fetchImpl, url, method, timeoutMs) {
  const headers = {
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
    'user-agent': 'Second-Mind-site-check/1',
  };
  if (method === 'GET') headers.range = 'bytes=0-0';
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hops = 0; hops < 5; hops++) {
    const response = await fetchImpl(current, { method, headers, redirect: 'manual', signal });
    const location = response.headers?.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response;
    const next = new URL(location, current).href;
    await cancelBody(response);
    if (classifyExternalLink(next).kind !== 'network' && !releaseAssetRedirect(url, next)) {
      return { status: 400, url: next };
    }
    current = next;
  }
  throw new Error('Too many redirects');
}

async function validateOneLink(target, options) {
  const {
    fetchImpl,
    timeoutMs,
    maxAttempts,
    retryDelayMs,
    sleep,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      let response = await request(fetchImpl, target.url, 'HEAD', timeoutMs);
      if ([403, 405, 501].includes(response.status)) {
        await cancelBody(response);
        response = await request(fetchImpl, target.url, 'GET', timeoutMs);
      }

      const status = response.status;
      const finalReference = response.url || target.url;
      const finalTarget = classifyExternalLink(finalReference);
      await cancelBody(response);
      if (finalTarget.kind !== 'network' && !releaseAssetRedirect(target.url, finalReference)) {
        return `${target.display}: redirect target is outside the public repository allowlist`;
      }
      if (successfulStatus(status)) return null;
      if (!retryableStatus(status) || attempt === maxAttempts) {
        return `${target.display}: returned HTTP ${status}`;
      }
    } catch {
      if (attempt === maxAttempts) return `${target.display}: could not be reached within the bounded link check`;
    }
    await sleep(retryDelayMs);
  }
  return `${target.display}: could not be validated`;
}

export async function validateExternalLinks(references, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  maxAttempts = 2,
  retryDelayMs = 250,
  concurrency = 3,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer.');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer.');

  const targets = [...new Set(references)].map(classifyExternalLink);
  const issues = [];
  const networkTargets = [];
  for (const target of targets) {
    if (target.kind === 'network') networkTargets.push(target);
    else if (target.kind === 'invalid') issues.push(target.message);
  }
  networkTargets.sort((left, right) => left.url.localeCompare(right.url));

  let cursor = 0;
  async function worker() {
    while (cursor < networkTargets.length) {
      const target = networkTargets[cursor];
      cursor += 1;
      const issue = await validateOneLink(target, {
        fetchImpl,
        timeoutMs,
        maxAttempts,
        retryDelayMs,
        sleep,
      });
      if (issue) issues.push(issue);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, networkTargets.length) },
    () => worker(),
  ));
  return issues.sort();
}
