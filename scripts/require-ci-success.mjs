#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CI_GATE_DEFAULTS = Object.freeze({
  timeoutMs: 55 * 60_000,
  pollIntervalMs: 10_000,
  requestTimeoutMs: 15_000,
});

export class CiGateError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'CiGateError';
    this.retryable = retryable;
  }
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new CiGateError(`The ${name} environment variable is required.`);
  }
  return value.trim();
}

export function ciGateConfiguration(environment = process.env) {
  const token = requiredEnvironmentValue(environment, 'GITHUB_TOKEN');
  const repository = requiredEnvironmentValue(environment, 'GITHUB_REPOSITORY');
  const sha = requiredEnvironmentValue(environment, 'GITHUB_SHA').toLowerCase();
  const apiUrl = requiredEnvironmentValue(environment, 'GITHUB_API_URL');

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new CiGateError('GITHUB_REPOSITORY is invalid.');
  }
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) {
    throw new CiGateError('GITHUB_SHA is invalid.');
  }

  let parsedApiUrl;
  try {
    parsedApiUrl = new URL(apiUrl);
  } catch {
    throw new CiGateError('GITHUB_API_URL is invalid.');
  }
  if (parsedApiUrl.protocol !== 'https:'
      || parsedApiUrl.username
      || parsedApiUrl.password
      || parsedApiUrl.search
      || parsedApiUrl.hash) {
    throw new CiGateError('GITHUB_API_URL is invalid.');
  }

  return Object.freeze({
    token,
    repository,
    sha,
    apiUrl: parsedApiUrl.href.replace(/\/$/u, ''),
  });
}

export function workflowRunsUrl(configuration) {
  const [owner, repository] = configuration.repository.split('/');
  const url = new URL(
    `${configuration.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
      + '/actions/workflows/ci.yml/runs',
  );
  url.searchParams.set('event', 'push');
  url.searchParams.set('head_sha', configuration.sha);
  url.searchParams.set('per_page', '100');
  return url;
}

function newestMatchingRun(workflowRuns, configuration) {
  const matching = workflowRuns.filter((run) => (
    run && typeof run === 'object'
    && run.head_sha === configuration.sha
    && run.event === 'push'
    && run.head_branch === 'main'
  ));
  matching.sort((left, right) => (
    Number(right.run_number || 0) - Number(left.run_number || 0)
    || Number(right.run_attempt || 0) - Number(left.run_attempt || 0)
  ));
  return matching[0] ?? null;
}

async function readWorkflowRuns(configuration, fetchImpl, signalFactory, requestTimeoutMs) {
  let response;
  try {
    response = await fetchImpl(workflowRunsUrl(configuration), {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${configuration.token}`,
        'user-agent': 'second-mind-pages-ci-gate',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'error',
      signal: signalFactory(requestTimeoutMs),
    });
  } catch {
    throw new CiGateError('The GitHub Actions API request failed.', { retryable: true });
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? ` with status ${response.status}` : '';
    const retryable = response?.status === 408
      || response?.status === 429
      || (response?.status >= 500 && response?.status <= 599);
    throw new CiGateError(`The GitHub Actions API request failed${status}.`, { retryable });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CiGateError('The GitHub Actions API returned an invalid response.');
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.workflow_runs)) {
    throw new CiGateError('The GitHub Actions API returned an invalid response.');
  }
  return payload.workflow_runs;
}

export async function requireCiSuccess(configuration, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  signalFactory = (milliseconds) => AbortSignal.timeout(milliseconds),
  timeoutMs = CI_GATE_DEFAULTS.timeoutMs,
  pollIntervalMs = CI_GATE_DEFAULTS.pollIntervalMs,
  requestTimeoutMs = CI_GATE_DEFAULTS.requestTimeoutMs,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new CiGateError('A Fetch implementation is required.');
  if (![timeoutMs, pollIntervalMs, requestTimeoutMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new CiGateError('CI gate timing is invalid.');
  }

  const deadline = now() + timeoutMs;
  let firstAttempt = true;
  while (true) {
    if (!firstAttempt && now() >= deadline) {
      throw new CiGateError('Timed out waiting for the same-commit CI workflow.');
    }
    firstAttempt = false;
    let workflowRuns;
    try {
      const requestBudget = Math.max(1, Math.min(requestTimeoutMs, deadline - now()));
      workflowRuns = await readWorkflowRuns(
        configuration,
        fetchImpl,
        signalFactory,
        requestBudget,
      );
    } catch (error) {
      if (!(error instanceof CiGateError) || !error.retryable) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new CiGateError('Timed out waiting for the same-commit CI workflow.');
      }
      await sleep(Math.min(pollIntervalMs, remaining));
      continue;
    }
    const run = newestMatchingRun(workflowRuns, configuration);

    if (run) {
      if (typeof run.status !== 'string') {
        throw new CiGateError('The GitHub Actions API returned an invalid response.');
      }
      if (run.status === 'completed') {
        if (run.conclusion === 'success') return;
        throw new CiGateError('The same-commit CI workflow completed without success.');
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new CiGateError('Timed out waiting for the same-commit CI workflow.');
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

async function main() {
  const configuration = ciGateConfiguration();
  await requireCiSuccess(configuration);
  process.stdout.write(`Same-commit CI gate passed for ${configuration.sha.slice(0, 12)}.\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && pathToFileURL(invokedPath).href === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  main().catch((error) => {
    const message = error instanceof CiGateError
      ? error.message
      : 'The same-commit CI gate failed unexpectedly.';
    process.stderr.write(`CI release gate failed: ${message}\n`);
    process.exitCode = 1;
  });
}
