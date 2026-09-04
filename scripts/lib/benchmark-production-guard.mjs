import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const DEFAULT_SERVICES = Object.freeze([
  Object.freeze({ id: 'home', name: 'yuantianen-home.service', user: true }),
  Object.freeze({ id: 'agent', name: 'yuantianen-agent.service', user: false }),
]);

const DEFAULT_ENDPOINTS = Object.freeze([
  Object.freeze({ id: 'home', url: 'http://127.0.0.1:8787/' }),
  Object.freeze({ id: 'knowledge', url: 'http://127.0.0.1:8787/knowledge.html' }),
]);

function guardError(message, code = 'PRODUCTION_GUARD_FAILED', details = []) {
  const error = new Error(message);
  error.name = 'BenchmarkProductionGuardError';
  error.code = code;
  error.details = details;
  return error;
}

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (!value || typeof value !== 'object') return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, immutable(child)]),
  ));
}

export function parseSystemctlShow(output, serviceName = 'service') {
  const fields = {};
  for (const line of String(output || '').split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw guardError(`Invalid systemctl show output for ${serviceName}.`, 'INVALID_SERVICE_STATE');
    }
    fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const mainPid = Number(fields.MainPID);
  const restarts = Number(fields.NRestarts);
  if (
    !fields.ActiveState || !fields.SubState || !fields.ExecMainStartTimestamp ||
    !Number.isInteger(mainPid) || mainPid <= 0 ||
    !Number.isInteger(restarts) || restarts < 0
  ) {
    throw guardError(`Incomplete systemctl state for ${serviceName}.`, 'INVALID_SERVICE_STATE');
  }
  return immutable({
    activeState: fields.ActiveState,
    subState: fields.SubState,
    mainPid,
    execMainStartTimestamp: fields.ExecMainStartTimestamp,
    restarts,
  });
}

async function defaultReadService(definition) {
  const args = [
    ...(definition.user ? ['--user'] : []),
    'show',
    definition.name,
    '--property=ActiveState',
    '--property=SubState',
    '--property=MainPID',
    '--property=ExecMainStartTimestamp',
    '--property=NRestarts',
  ];
  const { stdout } = await execFile('systemctl', args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  return parseSystemctlShow(stdout, definition.name);
}

function assertLoopbackEndpoint(endpoint) {
  let parsed;
  try {
    parsed = new URL(endpoint.url);
  } catch {
    throw guardError('Production health endpoint is invalid.', 'INVALID_HEALTH_ENDPOINT');
  }
  if (
    parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
    parsed.username || parsed.password || parsed.hash
  ) {
    throw guardError(
      'Production health probes are restricted to IPv4 loopback HTTP URLs.',
      'INVALID_HEALTH_ENDPOINT',
    );
  }
  return parsed;
}

async function defaultProbeEndpoint(endpoint) {
  const parsed = assertLoopbackEndpoint(endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(parsed, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    await response.body?.cancel();
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

export async function captureProductionState(options = {}) {
  const services = options.services || DEFAULT_SERVICES;
  const endpoints = options.endpoints || DEFAULT_ENDPOINTS;
  const readService = options.readService || defaultReadService;
  const probeEndpoint = options.probeEndpoint || defaultProbeEndpoint;
  const serviceState = {};
  for (const definition of services) {
    if (!definition?.id || !definition?.name) {
      throw guardError('Every service definition needs id and name.', 'INVALID_GUARD_CONFIGURATION');
    }
    serviceState[definition.id] = await readService(definition);
  }
  const endpointState = {};
  for (const endpoint of endpoints) {
    if (!endpoint?.id || !endpoint?.url) {
      throw guardError('Every endpoint definition needs id and url.', 'INVALID_GUARD_CONFIGURATION');
    }
    assertLoopbackEndpoint(endpoint);
    endpointState[endpoint.id] = Number(await probeEndpoint(endpoint));
  }
  const state = immutable({
    capturedAt: new Date().toISOString(),
    services: serviceState,
    endpoints: endpointState,
  });
  assertProductionHealthy(state);
  return state;
}

export function assertProductionHealthy(state) {
  const problems = [];
  for (const [id, service] of Object.entries(state?.services || {})) {
    if (service.activeState !== 'active' || service.subState !== 'running') {
      problems.push(`service ${id} is ${service.activeState}/${service.subState}`);
    }
  }
  for (const [id, status] of Object.entries(state?.endpoints || {})) {
    if (status !== 200) problems.push(`endpoint ${id} returned HTTP ${status}`);
  }
  if (problems.length) {
    throw guardError('Production baseline is not healthy.', 'PRODUCTION_UNHEALTHY', problems);
  }
  return state;
}

export function compareProductionState(before, after) {
  assertProductionHealthy(before);
  assertProductionHealthy(after);
  const problems = [];
  for (const [id, initial] of Object.entries(before.services || {})) {
    const final = after.services?.[id];
    if (!final) {
      problems.push(`service ${id} is absent from the final state`);
      continue;
    }
    if (final.mainPid !== initial.mainPid) problems.push(`service ${id} MainPID changed`);
    if (final.execMainStartTimestamp !== initial.execMainStartTimestamp) {
      problems.push(`service ${id} start timestamp changed`);
    }
    if (final.restarts !== initial.restarts) problems.push(`service ${id} restart count changed`);
  }
  if (problems.length) {
    throw guardError(
      'A production service restarted or changed during the benchmark.',
      'PRODUCTION_STATE_CHANGED',
      problems,
    );
  }
  return immutable({ healthy: true, unchanged: true });
}

export const PRODUCTION_GUARD_DEFAULTS = Object.freeze({
  services: DEFAULT_SERVICES,
  endpoints: DEFAULT_ENDPOINTS,
});
