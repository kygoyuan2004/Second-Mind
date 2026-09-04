import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CiGateError,
  ciGateConfiguration,
  requireCiSuccess,
  workflowRunsUrl,
} from '../scripts/require-ci-success.mjs';

const token = 'synthetic-actions-token';
const sha = 'a'.repeat(40);

function configuration() {
  return ciGateConfiguration({
    GITHUB_TOKEN: token,
    GITHUB_REPOSITORY: 'example/second-mind',
    GITHUB_SHA: sha,
    GITHUB_API_URL: 'https://api.github.test',
  });
}

function response(workflowRuns) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { workflow_runs: workflowRuns };
    },
  };
}

function run(overrides = {}) {
  return {
    id: 123,
    run_number: 17,
    run_attempt: 1,
    event: 'push',
    head_branch: 'main',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

test('Pages workflow separates metadata reads from deployment authority', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const buildStart = workflow.indexOf('  build:');
  const deployStart = workflow.indexOf('  deploy:');
  assert.ok(buildStart >= 0 && deployStart > buildStart);
  const build = workflow.slice(buildStart, deployStart);
  const deploy = workflow.slice(deployStart);

  assert.match(build, /permissions:\n\s+actions: read\n\s+contents: read\n\s+pages: read/u);
  assert.doesNotMatch(build, /pages: write/u);
  assert.match(deploy, /permissions:\n\s+pages: write\n\s+id-token: write/u);
  assert.ok(build.indexOf('Require successful CI for this commit') < build.indexOf('Install locked dependencies'));
  assert.match(build, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
});

test('configuration and request URL are exact and contain no credential', () => {
  const config = configuration();
  const url = workflowRunsUrl(config);

  assert.equal(url.origin, 'https://api.github.test');
  assert.equal(url.pathname, '/repos/example/second-mind/actions/workflows/ci.yml/runs');
  assert.equal(url.searchParams.get('event'), 'push');
  assert.equal(url.searchParams.get('head_sha'), sha);
  assert.equal(url.searchParams.get('per_page'), '100');
  assert.equal(url.href.includes(token), false);
});

test('gate polls until the newest same-commit push CI run succeeds', async () => {
  const replies = [
    response([]),
    response([
      run({ run_number: 19, status: 'in_progress', conclusion: null }),
      run({ run_number: 18 }),
      run({ run_number: 20, event: 'pull_request' }),
      run({ run_number: 23, event: 'workflow_dispatch' }),
      run({ run_number: 22, head_branch: 'v0.1.0' }),
      run({ run_number: 21, head_sha: 'b'.repeat(40) }),
    ]),
    response([run({ run_number: 19 })]),
  ];
  const requests = [];
  let clock = 0;

  await requireCiSuccess(configuration(), {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return replies.shift();
    },
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    signalFactory: () => undefined,
    timeoutMs: 100,
    pollIntervalMs: 10,
    requestTimeoutMs: 5,
  });

  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.headers.authorization, `Bearer ${token}`);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(clock, 20);
});

test('tag and manually dispatched runs cannot override the main push verdict', async () => {
  await assert.rejects(
    requireCiSuccess(configuration(), {
      fetchImpl: async () => response([
        run({ run_number: 24, head_branch: 'v0.1.0', conclusion: 'success' }),
        run({ run_number: 23, head_branch: 'feature', event: 'workflow_dispatch' }),
        run({ run_number: 22, conclusion: 'failure' }),
      ]),
      signalFactory: () => undefined,
      timeoutMs: 100,
      pollIntervalMs: 10,
      requestTimeoutMs: 5,
    }),
    (error) => error instanceof CiGateError
      && error.message === 'The same-commit CI workflow completed without success.',
  );
});

test('a completed latest same-commit run fails closed', async () => {
  await assert.rejects(
    requireCiSuccess(configuration(), {
      fetchImpl: async () => response([
        run({ run_number: 21, conclusion: 'failure' }),
        run({ run_number: 20 }),
      ]),
      signalFactory: () => undefined,
      timeoutMs: 100,
      pollIntervalMs: 10,
      requestTimeoutMs: 5,
    }),
    (error) => error instanceof CiGateError
      && error.message === 'The same-commit CI workflow completed without success.',
  );
});

test('gate has a deterministic bounded timeout when no matching run appears', async () => {
  let clock = 1_000;
  let requests = 0;

  await assert.rejects(
    requireCiSuccess(configuration(), {
      fetchImpl: async () => {
        requests += 1;
        return response([
          run({ event: 'workflow_dispatch' }),
          run({ head_branch: 'v0.1.0' }),
          run({ event: 'pull_request', head_branch: 'feature' }),
        ]);
      },
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      signalFactory: () => undefined,
      timeoutMs: 25,
      pollIntervalMs: 10,
      requestTimeoutMs: 5,
    }),
    (error) => error instanceof CiGateError
      && error.message === 'Timed out waiting for the same-commit CI workflow.',
  );

  assert.equal(requests, 3);
  assert.equal(clock, 1_025);
});

test('non-retryable API failures never read or expose response bodies or credentials', async () => {
  const privateBody = `private diagnostic ${token}`;
  let bodyRead = false;

  await assert.rejects(
    requireCiSuccess(configuration(), {
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        async json() {
          bodyRead = true;
          return { message: privateBody };
        },
      }),
      signalFactory: () => undefined,
      timeoutMs: 100,
      pollIntervalMs: 10,
      requestTimeoutMs: 5,
    }),
    (error) => error instanceof CiGateError
      && error.message === 'The GitHub Actions API request failed with status 401.'
      && !error.message.includes(token)
      && !error.message.includes(privateBody),
  );

  assert.equal(bodyRead, false);
});

test('transient network and server failures retry within the overall deadline', async () => {
  const replies = [
    new Error(`network detail ${token}`),
    {
      ok: false,
      status: 503,
      async json() {
        throw new Error(`response body ${token}`);
      },
    },
    response([run()]),
  ];
  let clock = 0;
  const requestBudgets = [];

  await requireCiSuccess(configuration(), {
    fetchImpl: async () => {
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    signalFactory: (milliseconds) => {
      requestBudgets.push(milliseconds);
      return undefined;
    },
    timeoutMs: 25,
    pollIntervalMs: 10,
    requestTimeoutMs: 15,
  });

  assert.equal(clock, 20);
  assert.deepEqual(requestBudgets, [15, 15, 5]);
});

test('persistent transient failures stop at the deadline with sanitized output', async () => {
  let clock = 0;
  let requests = 0;

  await assert.rejects(
    requireCiSuccess(configuration(), {
      fetchImpl: async () => {
        requests += 1;
        throw new Error(`private network detail ${token}`);
      },
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      signalFactory: () => undefined,
      timeoutMs: 25,
      pollIntervalMs: 10,
      requestTimeoutMs: 15,
    }),
    (error) => error instanceof CiGateError
      && error.message === 'Timed out waiting for the same-commit CI workflow.'
      && !error.message.includes(token),
  );

  assert.equal(requests, 3);
  assert.equal(clock, 25);
});

test('configuration rejects unsafe API URLs without reflecting their values', () => {
  const unsafe = `http://user:${token}@api.github.test/private?body=${token}`;
  assert.throws(
    () => ciGateConfiguration({
      GITHUB_TOKEN: token,
      GITHUB_REPOSITORY: 'example/second-mind',
      GITHUB_SHA: sha,
      GITHUB_API_URL: unsafe,
    }),
    (error) => error instanceof CiGateError
      && error.message === 'GITHUB_API_URL is invalid.'
      && !error.message.includes(token),
  );
});
