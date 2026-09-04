#!/usr/bin/env node

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const DEFAULT_PORT = 8787;
const DEFAULT_APPLICATION_IMAGE = 'ghcr.io/kygoyuan2004/second-mind:latest';
const MINIMUM_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_STDIN_BYTES = 16 * 1024;
const STATE_MARKER = '.second-mind-installer-state';
const STATE_MARKER_CONTENT = 'second-mind-installer-state-v1\n';
const INSTANCE_PATTERN = /^second-mind-[a-z0-9][a-z0-9-]{5,48}[a-z0-9]$/u;
const COMMANDS = new Set(['init', 'doctor', 'status', 'logs', 'update', 'backup']);
const INTERNAL_COMMANDS = new Set([
  'internal-preflight',
  'internal-probe-path',
  'internal-probe-vault',
  'internal-copy-tree',
  'internal-finalize-backup',
  'internal-own-tree',
]);
const BOOLEAN_OPTIONS = new Set([
  'admin-password-stdin',
  'json',
  'new-instance',
  'no-follow',
  'non-interactive',
]);
const VALUE_OPTIONS = new Set([
  'backup-root',
  'destination',
  'expected-vault',
  'host-home',
  'host-os',
  'host-repo-root',
  'host-state-root',
  'instance',
  'output-gid',
  'output-uid',
  'operation',
  'port',
  'repo-root',
  'runtime-gid',
  'runtime-uid',
  'source',
  'state-root',
  'tail',
  'vault',
]);
const REQUIRED_SECRET_FILES = Object.freeze([
  'admin_password',
  'session_secret',
  'llm_api_key',
  'embedding_api_key',
  'web_search_api_key',
  'responses_api_key',
]);

export class InstallerError extends Error {
  constructor(message, code = 'INSTALLER_ERROR') {
    super(message);
    this.name = 'InstallerError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new InstallerError(message, code);
}

function optionName(raw) {
  return raw.replace(/^--/u, '');
}

export function parseArguments(argv = []) {
  const input = [...argv];
  const command = input[0] && !input[0].startsWith('-') ? input.shift() : 'init';
  if (!COMMANDS.has(command) && !INTERNAL_COMMANDS.has(command)) {
    fail(`Unsupported installer command: ${command}`, 'UNKNOWN_COMMAND');
  }
  const options = {};
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index];
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`, 'INVALID_ARGUMENT');
    const separator = token.indexOf('=');
    const name = optionName(separator < 0 ? token : token.slice(0, separator));
    if (BOOLEAN_OPTIONS.has(name)) {
      if (separator >= 0) fail(`--${name} does not accept a value.`, 'INVALID_ARGUMENT');
      options[toCamel(name)] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) fail(`Unknown option: --${name}`, 'INVALID_ARGUMENT');
    const value = separator >= 0 ? token.slice(separator + 1) : input[++index];
    if (value === undefined || value.startsWith('--')) {
      fail(`--${name} requires a value.`, 'INVALID_ARGUMENT');
    }
    options[toCamel(name)] = value;
  }
  return { command, options };
}

function toCamel(value) {
  return value.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function assertTextPath(value, label) {
  const text = String(value || '');
  if (!text.trim()) fail(`${label} is required.`, 'PATH_REQUIRED');
  if (/[\0\r\n]/u.test(text)) fail(`${label} contains an unsupported control character.`, 'PATH_INVALID');
  return text.trim();
}

function platformPath(hostOs = process.platform) {
  return String(hostOs).toLowerCase().startsWith('win') ? path.win32 : path.posix;
}

function portableWindowsPath(value) {
  return value.replaceAll('\\', '/');
}

export function normalizeHostPath(value, options = {}) {
  const hostOs = String(options.hostOs || process.platform).toLowerCase();
  const implementation = platformPath(hostOs);
  let input = assertTextPath(value, options.label || 'Path');
  const home = options.hostHome ? assertTextPath(options.hostHome, 'Host home path') : '';
  if (input === '~' || input.startsWith('~/') || input.startsWith('~\\')) {
    if (!home) fail('A host home path is required to expand ~.', 'HOST_HOME_REQUIRED');
    input = input === '~' ? home : implementation.join(home, input.slice(2));
  }
  if (!implementation.isAbsolute(input)) {
    const base = assertTextPath(options.hostRepoRoot || process.cwd(), 'Host repository path');
    input = implementation.resolve(base, input);
  } else {
    input = implementation.normalize(input);
  }
  return hostOs.startsWith('win') ? portableWindowsPath(input) : input;
}

function comparableHostPath(value, hostOs) {
  const normalized = normalizeHostPath(value, { hostOs, hostRepoRoot: value });
  const root = platformPath(hostOs).parse(normalized).root.replaceAll('\\', '/');
  const withoutTrailing = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/u, '')
    : normalized;
  return String(hostOs).toLowerCase().startsWith('win')
    ? withoutTrailing.toLowerCase()
    : withoutTrailing;
}

export function hostPathsOverlap(left, right, hostOs = process.platform) {
  const implementation = platformPath(hostOs);
  const a = comparableHostPath(left, hostOs);
  const b = comparableHostPath(right, hostOs);
  const relativeAB = implementation.relative(a, b).replaceAll('\\', '/');
  const relativeBA = implementation.relative(b, a).replaceAll('\\', '/');
  const contained = (relative) => relative === '' || (!relative.startsWith('../') && relative !== '..' && !implementation.isAbsolute(relative));
  return contained(relativeAB) || contained(relativeBA);
}

export function isHostFilesystemRoot(value, hostOs = process.platform) {
  const implementation = platformPath(hostOs);
  const normalized = normalizeHostPath(value, {
    hostOs,
    hostRepoRoot: value,
    label: 'Host path',
  });
  const filesystemRoot = implementation.parse(normalized).root;
  return Boolean(filesystemRoot)
    && comparableHostPath(normalized, hostOs) === comparableHostPath(filesystemRoot, hostOs);
}

async function resolvePotentialRealpath(value) {
  let cursor = path.resolve(value);
  const missingSegments = [];
  while (true) {
    try {
      const existingAncestor = await fsp.realpath(cursor);
      return path.join(existingAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(value);
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function localPathsOverlap(left, right) {
  const [resolvedLeft, resolvedRight] = await Promise.all([
    resolvePotentialRealpath(left),
    resolvePotentialRealpath(right),
  ]);
  return hostPathsOverlap(resolvedLeft, resolvedRight, process.platform);
}

export function quoteComposeEnv(value) {
  const text = String(value ?? '');
  if (/[\0\r\n]/u.test(text)) fail('Compose environment values cannot contain line breaks.', 'ENV_VALUE_INVALID');
  return `'${text.replaceAll("'", "\\'")}'`;
}

function parsePort(value = DEFAULT_PORT) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    fail('Port must be an integer between 1 and 65535.', 'PORT_INVALID');
  }
  return port;
}

function parseTail(value = 200) {
  const tail = Number(value);
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > 10_000) {
    fail('Log tail must be an integer between 1 and 10000.', 'LOG_TAIL_INVALID');
  }
  return tail;
}

function parseRuntimeId(value = 1000, label = 'Runtime user ID') {
  const identifier = Number(value);
  if (!Number.isSafeInteger(identifier) || identifier < 0 || identifier > 2_147_483_647) {
    fail(`${label} must be a non-negative integer.`, 'RUNTIME_ID_INVALID');
  }
  return identifier;
}

function validatePassword(value) {
  const password = String(value || '');
  if (/[\0\r\n]/u.test(password)
      || password !== password.trim()
      || password.length < MINIMUM_PASSWORD_LENGTH) {
    fail(`Administrator password must contain at least ${MINIMUM_PASSWORD_LENGTH} non-whitespace-edge characters and no line breaks.`, 'PASSWORD_INVALID');
  }
  return password;
}

function validateInstanceId(value) {
  const instanceId = String(value || '').trim().toLowerCase();
  if (!INSTANCE_PATTERN.test(instanceId)) {
    fail('Instance ID must look like second-mind-name and contain only lowercase letters, digits, and hyphens.', 'INSTANCE_ID_INVALID');
  }
  return instanceId;
}

function createInstanceId() {
  return `second-mind-${randomBytes(6).toString('hex')}`;
}

function defaultStateRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Second Mind');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Second Mind');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'second-mind');
}

function instancePaths(stateRoot, instanceId) {
  const root = path.join(stateRoot, instanceId);
  return {
    root,
    env: path.join(root, '.env'),
    overlay: path.join(root, 'compose.instance.yaml'),
    metadata: path.join(root, 'instance.json'),
    secrets: path.join(root, 'secrets'),
    operation: path.join(root, 'operation'),
    backups: path.join(root, 'backups'),
  };
}

async function privateDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700).catch(() => {});
}

async function atomicWrite(filename, contents, mode = 0o600) {
  await privateDirectory(path.dirname(filename));
  const temporary = `${filename}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  await fsp.writeFile(temporary, contents, { encoding: 'utf8', mode, flag: 'wx' });
  await fsp.chmod(temporary, mode).catch(() => {});
  try {
    await fsp.rename(temporary, filename);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await fsp.chmod(filename, mode).catch(() => {});
}

function hostJoin(hostOs, ...parts) {
  const joined = platformPath(hostOs).join(...parts);
  return String(hostOs).toLowerCase().startsWith('win') ? portableWindowsPath(joined) : joined;
}

function envDocument(metadata) {
  const secretRoot = hostJoin(metadata.hostOs, metadata.hostStateRoot, metadata.instanceId, 'secrets');
  const lines = [
    '# Generated by the Second Mind installer. Keep this file private.',
    `COMPOSE_PROJECT_NAME=${metadata.projectName}`,
    `SECOND_MIND_INSTANCE_ID=${metadata.instanceId}`,
    `SECOND_MIND_DATA_VOLUME=${metadata.dataVolume}`,
    `SECOND_MIND_IMAGE=${DEFAULT_APPLICATION_IMAGE}`,
    `VAULTMIND_BIND_IP=127.0.0.1`,
    `VAULTMIND_PORT=${metadata.port}`,
    `VAULTMIND_UID=${metadata.runtimeUid}`,
    `VAULTMIND_GID=${metadata.runtimeGid}`,
    `KNOWLEDGE_BASE_HOST_PATH=${quoteComposeEnv(metadata.knowledgeBaseHostPath)}`,
    `VAULT_HOST_PATH=${quoteComposeEnv(metadata.knowledgeBaseHostPath)}`,
    'RUNTIME_CONFIG_DIR=/app/data/runtime',
    `ADMIN_PASSWORD_SECRET_PATH=${quoteComposeEnv(hostJoin(metadata.hostOs, secretRoot, 'admin_password'))}`,
    `SESSION_SECRET_SECRET_PATH=${quoteComposeEnv(hostJoin(metadata.hostOs, secretRoot, 'session_secret'))}`,
    `LLM_API_KEY_SECRET_PATH=${quoteComposeEnv(hostJoin(metadata.hostOs, secretRoot, 'llm_api_key'))}`,
    `EMBEDDING_API_KEY_SECRET_PATH=${quoteComposeEnv(hostJoin(metadata.hostOs, secretRoot, 'embedding_api_key'))}`,
    `WEB_SEARCH_API_KEY_SECRET_PATH=${quoteComposeEnv(hostJoin(metadata.hostOs, secretRoot, 'web_search_api_key'))}`,
    `BAILIAN_RESPONSES_FALLBACK_API_KEY_SECRET_PATH=${quoteComposeEnv(hostJoin(metadata.hostOs, secretRoot, 'responses_api_key'))}`,
    `RESPONSES_API_KEY_SECRET_PATH=${quoteComposeEnv(hostJoin(metadata.hostOs, secretRoot, 'responses_api_key'))}`,
    '',
  ];
  return lines.join('\n');
}

function overlayDocument(metadata) {
  return [
    '# Generated by the Second Mind installer. Do not share this file.',
    'services:',
    '  app:',
    '    labels:',
    `      io.second-mind.instance: ${JSON.stringify(metadata.instanceId)}`,
    'volumes:',
    '  vaultmind-data:',
    `    name: ${JSON.stringify(metadata.dataVolume)}`,
    '',
  ].join('\n');
}

async function writeSecret(filename, value) {
  await fsp.writeFile(filename, String(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fsp.chmod(filename, 0o600).catch(() => {});
}

async function createSecrets(paths, adminPassword) {
  await privateDirectory(paths.secrets);
  await writeSecret(path.join(paths.secrets, 'admin_password'), validatePassword(adminPassword));
  await writeSecret(path.join(paths.secrets, 'session_secret'), randomBytes(48).toString('base64url'));
  for (const name of REQUIRED_SECRET_FILES.slice(2)) await writeSecret(path.join(paths.secrets, name), '');
}

async function readJson(filename) {
  try {
    return JSON.parse(await fsp.readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`Could not read installer state: ${path.basename(filename)}.`, 'STATE_INVALID');
  }
}

async function writeOperation(paths, metadata, command, options = {}) {
  await privateDirectory(paths.operation);
  const values = {
    command,
    project: metadata.projectName,
    volume: metadata.dataVolume,
    port: String(metadata.port),
    runtimeUid: String(metadata.runtimeUid),
    runtimeGid: String(metadata.runtimeGid),
    vault: metadata.knowledgeBaseHostPath,
    hostRepo: metadata.hostRepoRoot,
    hostState: metadata.hostStateRoot,
    tail: String(options.tail || 200),
    follow: options.follow === false ? 'false' : 'true',
    backup: options.backupHostPath || '',
    backupName: options.backupName || '',
  };
  for (const [name, value] of Object.entries(values)) {
    await atomicWrite(path.join(paths.operation, name), `${value}\n`);
  }
}

function publicMetadata(metadata) {
  return {
    instanceId: metadata.instanceId,
    projectName: metadata.projectName,
    dataVolume: metadata.dataVolume,
    port: metadata.port,
    configDirectory: metadata.hostInstanceRoot,
    knowledgeBasePath: metadata.knowledgeBaseHostPath,
  };
}

function resolveRoots(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const stateRoot = path.resolve(options.stateRoot || defaultStateRoot());
  const hostOs = String(options.hostOs || process.platform).toLowerCase();
  const hostRepoRoot = normalizeHostPath(options.hostRepoRoot || repoRoot, {
    hostOs,
    hostRepoRoot: options.hostRepoRoot || repoRoot,
    label: 'Host repository path',
  });
  const hostStateRoot = normalizeHostPath(options.hostStateRoot || stateRoot, {
    hostOs,
    hostRepoRoot,
    label: 'Host installer state path',
  });
  if (hostPathsOverlap(hostRepoRoot, hostStateRoot, hostOs)) {
    fail('Installer state must be outside the Git repository.', 'STATE_INSIDE_REPOSITORY');
  }
  return { repoRoot, stateRoot, hostOs, hostRepoRoot, hostStateRoot };
}

async function ensureStateRoot(roots, options = {}) {
  let inspection = await inspectStateRoot(roots, options);
  if (!inspection.exists) {
    await fsp.mkdir(roots.stateRoot, { recursive: true, mode: 0o700 });
    inspection = await inspectStateRoot(roots, options);
  }
  await privateDirectory(roots.stateRoot);
  if (inspection.markerValue === null) {
    await atomicWrite(path.join(roots.stateRoot, STATE_MARKER), STATE_MARKER_CONTENT);
  }
}

async function inspectStateRoot(roots, options = {}) {
  if (isHostFilesystemRoot(roots.hostStateRoot, roots.hostOs)
      || (options.hostHome
        && comparableHostPath(roots.hostStateRoot, roots.hostOs)
          === comparableHostPath(options.hostHome, roots.hostOs))) {
    fail('Installer state must use a dedicated directory, not a filesystem or home root.', 'STATE_ROOT_UNSAFE');
  }
  const stat = await fsp.stat(roots.stateRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !stat.isDirectory()) fail('Installer state path must be a directory.', 'STATE_ROOT_INVALID');
  if (!stat) return { exists: false, markerValue: null };
  const marker = path.join(roots.stateRoot, STATE_MARKER);
  const markerValue = await fsp.readFile(marker, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (markerValue === null) {
    const entries = await fsp.readdir(roots.stateRoot);
    if (entries.length !== 0) {
      fail('Installer state must be an empty dedicated directory or an existing Second Mind state directory.', 'STATE_ROOT_NOT_DEDICATED');
    }
  } else if (markerValue !== STATE_MARKER_CONTENT) {
    fail('Installer state marker is invalid.', 'STATE_ROOT_INVALID');
  }
  return { exists: true, markerValue };
}

async function promptLine(message, fallback = '') {
  if (!process.stdin.isTTY) fail('Interactive input requires a terminal; use --non-interactive.', 'TERMINAL_REQUIRED');
  process.stdout.write(message);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes('\u0003')) {
        cleanup();
        reject(new InstallerError('Installation cancelled.', 'CANCELLED'));
        return;
      }
      value += text;
      if (!/[\r\n]/u.test(value)) return;
      cleanup();
      const line = value.split(/\r?\n/u, 1)[0].trim();
      resolve(line || fallback);
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}

async function promptPassword(message) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    fail('A hidden password prompt requires a terminal; use the host wrapper automation input with --non-interactive.', 'TERMINAL_REQUIRED');
  }
  process.stdout.write(message);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cleanup();
          reject(new InstallerError('Installation cancelled.', 'CANCELLED'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (character >= ' ') {
          value += character;
          process.stdout.write('*');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function readPasswordFromStdin(input = process.stdin) {
  if (input.isTTY) {
    fail('--admin-password-stdin requires redirected standard input.', 'PASSWORD_STDIN_REQUIRED');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_PASSWORD_STDIN_BYTES) {
      fail('Administrator password input is too large.', 'PASSWORD_STDIN_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  let password = Buffer.concat(chunks).toString('utf8');
  if (password.endsWith('\r\n')) password = password.slice(0, -2);
  else if (password.endsWith('\n') || password.endsWith('\r')) password = password.slice(0, -1);
  return password;
}

async function initializationAnswers(options, roots) {
  if (options.nonInteractive) {
    const password = options.adminPassword;
    if (!options.vault || !password) {
      fail('--non-interactive requires --vault and password input from the host wrapper.', 'NON_INTERACTIVE_VALUES_REQUIRED');
    }
    return { vault: options.vault, password, port: options.port || DEFAULT_PORT };
  }
  const vault = options.vault || await promptLine('Vault or knowledge-base parent path: ');
  const password = options.adminPassword || await promptPassword('Administrator password (12+ characters): ');
  const port = options.port || await promptLine(`Port [${DEFAULT_PORT}]: `, String(DEFAULT_PORT));
  return { vault, password, port, roots };
}

async function currentInstanceId(stateRoot) {
  const value = await fsp.readFile(path.join(stateRoot, 'current'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return String(value || '').trim();
}

function validateStoredMetadata(metadata, roots, instanceId) {
  if (!metadata
      || metadata.schemaVersion !== SCHEMA_VERSION
      || metadata.instanceId !== instanceId
      || metadata.projectName !== instanceId
      || metadata.dataVolume !== `${instanceId}-data`) {
    fail(`Installer state for ${instanceId} is missing or invalid.`, 'INSTANCE_STATE_INVALID');
  }
  parsePort(metadata.port);
  parseRuntimeId(metadata.runtimeUid, 'Runtime UID');
  parseRuntimeId(metadata.runtimeGid, 'Runtime GID');
  if (isHostFilesystemRoot(metadata.knowledgeBaseHostPath, roots.hostOs)) {
    fail('A filesystem root cannot be used as the knowledge-base path.', 'KNOWLEDGE_BASE_ROOT_FORBIDDEN');
  }
  if (metadata.hostOs !== roots.hostOs
      || comparableHostPath(metadata.hostStateRoot, roots.hostOs)
        !== comparableHostPath(roots.hostStateRoot, roots.hostOs)
      || comparableHostPath(metadata.hostInstanceRoot, roots.hostOs)
        !== comparableHostPath(hostJoin(roots.hostOs, roots.hostStateRoot, instanceId), roots.hostOs)) {
    fail(`Installer state for ${instanceId} belongs to a different host configuration root.`, 'INSTANCE_HOST_MISMATCH');
  }
  normalizeHostPath(metadata.knowledgeBaseHostPath, {
    hostOs: roots.hostOs,
    hostRepoRoot: roots.hostRepoRoot,
    label: 'Stored knowledge-base path',
  });
}

async function loadInstanceById(roots, instanceInput) {
  const instanceId = validateInstanceId(instanceInput);
  const paths = instancePaths(roots.stateRoot, instanceId);
  const metadata = await readJson(paths.metadata);
  validateStoredMetadata(metadata, roots, instanceId);
  return { metadata, paths };
}

function normalizeKnowledgeBaseHostPath(value, roots, options = {}) {
  const knowledgeBaseHostPath = normalizeHostPath(value, {
    hostOs: roots.hostOs,
    hostRepoRoot: roots.hostRepoRoot,
    hostHome: options.hostHome,
    label: options.label || 'Vault or knowledge-base path',
  });
  if (isHostFilesystemRoot(knowledgeBaseHostPath, roots.hostOs)) {
    fail('A filesystem root cannot be used as the knowledge-base path.', 'KNOWLEDGE_BASE_ROOT_FORBIDDEN');
  }
  return knowledgeBaseHostPath;
}

function assertExpectedKnowledgeBase(expected, actual, roots, options = {}) {
  if (expected === undefined) return;
  const expectedPath = normalizeKnowledgeBaseHostPath(expected, roots, options);
  if (comparableHostPath(expectedPath, roots.hostOs)
      !== comparableHostPath(actual, roots.hostOs)) {
    fail('Installer state changed after the read-only preflight.', 'INSTALLER_PREFLIGHT_CHANGED');
  }
}

async function assertKnowledgeBaseSeparation(knowledgeBaseHostPath, roots) {
  if (hostPathsOverlap(knowledgeBaseHostPath, roots.hostStateRoot, roots.hostOs)) {
    fail('The installer state directory and knowledge-base path must not contain one another.', 'STATE_VAULT_OVERLAP');
  }
  if (await localPathsOverlap(knowledgeBaseHostPath, roots.stateRoot)) {
    fail('The resolved installer state and knowledge-base paths must not contain one another.', 'STATE_VAULT_OVERLAP');
  }
}

export async function preflightInstaller(options = {}) {
  const operation = String(options.operation || 'init').trim();
  if (!COMMANDS.has(operation)) fail(`Unsupported installer operation: ${operation}`, 'INVALID_OPERATION');
  const roots = resolveRoots(options);
  await inspectStateRoot(roots, options);
  const selected = operation === 'init' && options.newInstance
    ? ''
    : options.instance || await currentInstanceId(roots.stateRoot);
  if (selected) {
    const existing = await loadInstanceById(roots, selected);
    if (operation === 'init' && options.vault) {
      const requestedVault = normalizeKnowledgeBaseHostPath(options.vault, roots, options);
      if (comparableHostPath(requestedVault, roots.hostOs)
          !== comparableHostPath(existing.metadata.knowledgeBaseHostPath, roots.hostOs)) {
        fail('An existing instance cannot replace its Vault; use --new-instance.', 'INSTANCE_RECONFIGURE_REFUSED');
      }
    }
    await assertKnowledgeBaseSeparation(existing.metadata.knowledgeBaseHostPath, roots);
    return { requiresVault: false, knowledgeBasePath: existing.metadata.knowledgeBaseHostPath };
  }
  if (operation !== 'init') {
    fail('No Second Mind instance is initialized.', 'INSTANCE_NOT_INITIALIZED');
  }
  if (!options.vault) return { requiresVault: true, knowledgeBasePath: '' };
  const knowledgeBaseHostPath = normalizeKnowledgeBaseHostPath(options.vault, roots, options);
  await assertKnowledgeBaseSeparation(knowledgeBaseHostPath, roots);
  return { requiresVault: false, knowledgeBasePath: knowledgeBaseHostPath };
}

export async function loadSelectedInstance(options = {}) {
  const roots = resolveRoots(options);
  await inspectStateRoot(roots, options);
  const selected = options.instance || await currentInstanceId(roots.stateRoot);
  if (!selected) fail('No Second Mind instance is initialized.', 'INSTANCE_NOT_INITIALIZED');
  const instance = await loadInstanceById(roots, selected);
  assertExpectedKnowledgeBase(options.expectedVault, instance.metadata.knowledgeBaseHostPath, roots, options);
  await assertKnowledgeBaseSeparation(instance.metadata.knowledgeBaseHostPath, roots);
  await ensureStateRoot(roots, options);
  await atomicWrite(path.join(roots.stateRoot, 'current'), `${instance.metadata.instanceId}\n`);
  return { ...instance, roots };
}

function secretValuesEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function rewriteInstanceSettings(instance, options) {
  const next = {
    ...instance.metadata,
    port: options.port === undefined ? instance.metadata.port : parsePort(options.port),
    runtimeUid: options.runtimeUid === undefined
      ? instance.metadata.runtimeUid
      : parseRuntimeId(options.runtimeUid, 'Runtime UID'),
    runtimeGid: options.runtimeGid === undefined
      ? instance.metadata.runtimeGid
      : parseRuntimeId(options.runtimeGid, 'Runtime GID'),
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(instance.paths.metadata, `${JSON.stringify(next, null, 2)}\n`);
  await atomicWrite(instance.paths.env, envDocument(next));
  instance.metadata = next;
  return instance;
}

export async function initializeInstance(options = {}) {
  const roots = resolveRoots(options);
  await inspectStateRoot(roots, options);
  const selected = options.newInstance
    ? ''
    : options.instance || await currentInstanceId(roots.stateRoot);
  if (selected) {
    const existing = await loadInstanceById(roots, selected);
    assertExpectedKnowledgeBase(options.expectedVault, existing.metadata.knowledgeBaseHostPath, roots, options);
    await verifyInstanceFiles(existing.paths);
    if (options.vault) {
      const requestedVault = normalizeKnowledgeBaseHostPath(options.vault, roots, options);
      if (comparableHostPath(requestedVault, roots.hostOs)
          !== comparableHostPath(existing.metadata.knowledgeBaseHostPath, roots.hostOs)) {
        fail('An existing instance cannot replace its Vault; use --new-instance.', 'INSTANCE_RECONFIGURE_REFUSED');
      }
    }
    await assertKnowledgeBaseSeparation(existing.metadata.knowledgeBaseHostPath, roots);
    await ensureStateRoot(roots, options);
    const suppliedPassword = options.adminPassword;
    if (suppliedPassword !== undefined) {
      validatePassword(suppliedPassword);
      const storedPassword = await fsp.readFile(path.join(existing.paths.secrets, 'admin_password'), 'utf8');
      if (!secretValuesEqual(suppliedPassword, storedPassword)) {
        fail('An existing instance cannot replace its administrator secret; use --new-instance.', 'INSTANCE_RECONFIGURE_REFUSED');
      }
    }
    if (options.port !== undefined || options.runtimeUid !== undefined || options.runtimeGid !== undefined) {
      await rewriteInstanceSettings(existing, options);
    }
    await atomicWrite(path.join(roots.stateRoot, 'current'), `${existing.metadata.instanceId}\n`);
    await writeOperation(existing.paths, existing.metadata, 'init');
    return { ...publicMetadata(existing.metadata), reused: true };
  }

  const answers = await initializationAnswers(options, roots);
  const instanceId = options.instance ? validateInstanceId(options.instance) : createInstanceId();
  const paths = instancePaths(roots.stateRoot, instanceId);
  if (await fsp.lstat(paths.root).then(() => true, () => false)) {
    fail(`Instance ${instanceId} already exists.`, 'INSTANCE_ALREADY_EXISTS');
  }
  const knowledgeBaseHostPath = normalizeKnowledgeBaseHostPath(answers.vault, roots, options);
  assertExpectedKnowledgeBase(options.expectedVault, knowledgeBaseHostPath, roots, options);
  await assertKnowledgeBaseSeparation(knowledgeBaseHostPath, roots);
  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    instanceId,
    projectName: instanceId,
    dataVolume: `${instanceId}-data`,
    port: parsePort(answers.port),
    runtimeUid: parseRuntimeId(options.runtimeUid, 'Runtime UID'),
    runtimeGid: parseRuntimeId(options.runtimeGid, 'Runtime GID'),
    knowledgeBaseHostPath,
    hostOs: roots.hostOs,
    hostRepoRoot: roots.hostRepoRoot,
    hostStateRoot: roots.hostStateRoot,
    hostInstanceRoot: hostJoin(roots.hostOs, roots.hostStateRoot, instanceId),
    createdAt: new Date().toISOString(),
  };

  await ensureStateRoot(roots, options);
  await privateDirectory(paths.root);
  try {
    await createSecrets(paths, answers.password);
    await atomicWrite(paths.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
    await atomicWrite(paths.env, envDocument(metadata));
    await atomicWrite(paths.overlay, overlayDocument(metadata));
    await atomicWrite(path.join(roots.stateRoot, 'current'), `${instanceId}\n`);
    await writeOperation(paths, metadata, 'init');
  } catch (error) {
    await fsp.rm(paths.root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { ...publicMetadata(metadata), reused: false };
}

export async function prepareOperation(command, options = {}) {
  if (!COMMANDS.has(command) || command === 'init' || command === 'backup') {
    fail(`Cannot prepare operation ${command}.`, 'INVALID_OPERATION');
  }
  const instance = await loadSelectedInstance(options);
  const operationOptions = command === 'logs'
    ? { tail: parseTail(options.tail), follow: options.noFollow !== true }
    : {};
  await verifyInstanceFiles(instance.paths);
  await writeOperation(instance.paths, instance.metadata, command, operationOptions);
  return { ...publicMetadata(instance.metadata), command, ...operationOptions };
}

async function verifyInstanceFiles(paths) {
  for (const filename of [paths.env, paths.overlay, paths.metadata]) {
    const stat = await fsp.stat(filename).catch(() => null);
    if (!stat?.isFile()) fail(`Required installer file is missing: ${path.basename(filename)}`, 'INSTANCE_FILE_MISSING');
  }
  for (const name of REQUIRED_SECRET_FILES) {
    const stat = await fsp.stat(path.join(paths.secrets, name)).catch(() => null);
    if (!stat?.isFile()) fail(`Required secret file is missing: ${name}`, 'INSTANCE_SECRET_MISSING');
  }
  const admin = await fsp.readFile(path.join(paths.secrets, 'admin_password'), 'utf8');
  const session = await fsp.readFile(path.join(paths.secrets, 'session_secret'), 'utf8');
  validatePassword(admin);
  if (session.trim().length < 32) fail('Session secret is missing or too short.', 'SESSION_SECRET_INVALID');
}

function backupName(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/gu, '-')}-${randomBytes(3).toString('hex')}`;
}

async function copyConfigurationSnapshot(paths, destination) {
  await privateDirectory(destination);
  for (const source of [paths.env, paths.overlay, paths.metadata]) {
    await fsp.copyFile(source, path.join(destination, path.basename(source)), fsConstants.COPYFILE_EXCL);
  }
  const secretDestination = path.join(destination, 'secrets');
  await privateDirectory(secretDestination);
  for (const name of REQUIRED_SECRET_FILES) {
    const target = path.join(secretDestination, name);
    await fsp.copyFile(path.join(paths.secrets, name), target, fsConstants.COPYFILE_EXCL);
    await fsp.chmod(target, 0o600).catch(() => {});
  }
}

export async function prepareBackup(options = {}) {
  const instance = await loadSelectedInstance(options);
  await verifyInstanceFiles(instance.paths);
  const name = backupName(options.now);
  const root = path.join(instance.paths.backups, name);
  await privateDirectory(root);
  await copyConfigurationSnapshot(instance.paths, path.join(root, 'configuration'));
  const hostBackupPath = hostJoin(
    instance.metadata.hostOs,
    instance.metadata.hostInstanceRoot,
    'backups',
    name,
  );
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    status: 'incomplete',
    createdAt: new Date().toISOString(),
    instanceId: instance.metadata.instanceId,
    projectName: instance.metadata.projectName,
    dataVolume: instance.metadata.dataVolume,
    knowledgeBaseHostPath: instance.metadata.knowledgeBaseHostPath,
    consistency: 'live-copy; stop application and external sync first when a point-in-time snapshot is required',
  };
  await atomicWrite(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeOperation(instance.paths, instance.metadata, 'backup', {
    backupHostPath: hostBackupPath,
    backupName: name,
  });
  return { ...publicMetadata(instance.metadata), command: 'backup', backupPath: hostBackupPath, backupName: name };
}

function relativeArchivePath(value) {
  return value.split(path.sep).join('/');
}

async function applyOutputOwnership(filename, options, symbolicLink = false) {
  if (options.outputUid === undefined && options.outputGid === undefined) return;
  const uid = Number(options.outputUid);
  const gid = Number(options.outputGid);
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    fail('Output UID and GID must both be non-negative integers.', 'OUTPUT_ID_INVALID');
  }
  const ownership = symbolicLink && typeof fsp.lchown === 'function'
    ? fsp.lchown(filename, uid, gid)
    : fsp.chown(filename, uid, gid);
  await ownership.catch((error) => {
    if (!['ENOSYS', 'ENOTSUP', 'EPERM', 'EINVAL'].includes(error.code)) throw error;
  });
}

async function copyRegularFile(source, destination, stat, options) {
  const digest = createHash('sha256');
  const tap = new Transform({
    transform(chunk, encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(source),
    tap,
    createWriteStream(destination, { flags: 'wx', mode: stat.mode & 0o777 }),
  );
  await fsp.chmod(destination, stat.mode & 0o777).catch(() => {});
  await fsp.utimes(destination, stat.atime, stat.mtime).catch(() => {});
  await applyOutputOwnership(destination, options);
  return digest.digest('hex');
}

async function copyTreeEntry(source, destination, relative, records, options) {
  const stat = await fsp.lstat(source);
  const recordPath = relativeArchivePath(relative || '.');
  if (stat.isDirectory()) {
    await fsp.mkdir(destination, { mode: stat.mode & 0o777, recursive: false });
    await applyOutputOwnership(destination, options);
    records.push({ path: recordPath, type: 'directory', mode: stat.mode & 0o777 });
    const entries = await fsp.readdir(source);
    for (const entry of entries.sort((a, b) => a.localeCompare(b, 'en'))) {
      await copyTreeEntry(
        path.join(source, entry),
        path.join(destination, entry),
        relative ? path.join(relative, entry) : entry,
        records,
        options,
      );
    }
    await fsp.chmod(destination, stat.mode & 0o777).catch(() => {});
    await fsp.utimes(destination, stat.atime, stat.mtime).catch(() => {});
    return;
  }
  if (stat.isFile()) {
    const sha256 = await copyRegularFile(source, destination, stat, options);
    records.push({ path: recordPath, type: 'file', bytes: stat.size, sha256, mode: stat.mode & 0o777 });
    return;
  }
  if (stat.isSymbolicLink()) {
    const target = await fsp.readlink(source);
    await fsp.symlink(target, destination);
    await applyOutputOwnership(destination, options, true);
    records.push({ path: recordPath, type: 'symlink', target });
    return;
  }
  fail(`Backup source contains an unsupported special file: ${recordPath}`, 'BACKUP_SPECIAL_FILE');
}

export async function copyTreeForBackup(sourceInput, destinationInput, options = {}) {
  const source = path.resolve(assertTextPath(sourceInput, 'Backup source'));
  const destination = path.resolve(assertTextPath(destinationInput, 'Backup destination'));
  const sourceStat = await fsp.stat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) fail('Backup source must be a directory.', 'BACKUP_SOURCE_INVALID');
  const destinationParent = path.dirname(destination);
  const destinationParentStat = await fsp.stat(destinationParent).catch(() => null);
  if (!destinationParentStat?.isDirectory()) {
    fail('Backup destination parent must be an existing directory.', 'BACKUP_DESTINATION_INVALID');
  }
  if (await localPathsOverlap(source, destinationParent)) {
    fail('Resolved backup source and destination must not contain one another.', 'BACKUP_RECURSION');
  }
  await privateDirectory(destinationParent);
  const destinationExists = await fsp.lstat(destination).then(() => true, () => false);
  if (destinationExists) fail('Backup destination already exists.', 'BACKUP_DESTINATION_EXISTS');
  const relative = path.relative(source, destination);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    fail('Backup destination must not be inside its source.', 'BACKUP_RECURSION');
  }
  const records = [];
  try {
    await copyTreeEntry(source, destination, '', records, options);
    const inventory = {
      schemaVersion: SCHEMA_VERSION,
      completedAt: new Date().toISOString(),
      files: records.filter((entry) => entry.type === 'file').length,
      directories: records.filter((entry) => entry.type === 'directory').length,
      symlinks: records.filter((entry) => entry.type === 'symlink').length,
      bytes: records.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
      entries: records,
    };
    await atomicWrite(`${destination}.inventory.json`, `${JSON.stringify(inventory, null, 2)}\n`);
    await applyOutputOwnership(`${destination}.inventory.json`, options);
    return inventory;
  } catch (error) {
    await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(`${destination}.inventory.json`, { force: true }).catch(() => {});
    throw error;
  }
}

export async function probeWritablePath(targetInput) {
  const target = path.resolve(assertTextPath(targetInput, 'Probe path'));
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat?.isDirectory()) fail('Probe path does not exist or is not a directory.', 'PROBE_PATH_INVALID');
  if (await fsp.stat(path.join(target, STATE_MARKER)).then((entry) => entry.isFile(), () => false)) {
    fail('The knowledge-base path resolves to installer state.', 'STATE_VAULT_OVERLAP');
  }
  await fsp.access(target, fsConstants.R_OK | fsConstants.W_OK);
  const probe = path.join(target, `.second-mind-write-probe-${randomUUID()}`);
  try {
    await fsp.writeFile(probe, 'Second Mind installer write probe.\n', { flag: 'wx', mode: 0o600 });
  } finally {
    await fsp.rm(probe, { force: true }).catch(() => {});
  }
  const filesystem = await fsp.statfs(target).catch(() => null);
  const freeBytes = filesystem ? Number(filesystem.bavail) * Number(filesystem.bsize) : null;
  return { readable: true, writable: true, freeBytes };
}

async function hasObsidianMarker(directory) {
  const stat = await fsp.lstat(path.join(directory, '.obsidian')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return Boolean(stat?.isDirectory());
}

export async function probeKnowledgeBasePath(targetInput) {
  const target = path.resolve(assertTextPath(targetInput, 'Knowledge-base probe path'));
  const access = await probeWritablePath(target);
  let hasVault = await hasObsidianMarker(target);
  if (!hasVault) {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await hasObsidianMarker(path.join(target, entry.name))) {
        hasVault = true;
        break;
      }
    }
  }
  if (!hasVault) {
    fail(
      'Knowledge-base path must be an Obsidian Vault or a parent containing an immediate Obsidian Vault directory.',
      'KNOWLEDGE_BASE_LAYOUT_INVALID',
    );
  }
  return { ...access, obsidianVault: true };
}

async function ownTreeEntry(filename, uid, gid) {
  const stat = await fsp.lstat(filename);
  if (stat.isDirectory()) {
    for (const entry of await fsp.readdir(filename)) {
      await ownTreeEntry(path.join(filename, entry), uid, gid);
    }
  }
  if (stat.isSymbolicLink() && typeof fsp.lchown === 'function') await fsp.lchown(filename, uid, gid);
  else await fsp.chown(filename, uid, gid);
}

export async function ownRuntimeTree(targetInput, options = {}) {
  const target = path.resolve(assertTextPath(targetInput, 'Runtime data path'));
  const uid = parseRuntimeId(options.outputUid, 'Runtime UID');
  const gid = parseRuntimeId(options.outputGid, 'Runtime GID');
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat?.isDirectory()) fail('Runtime data path must be a directory.', 'RUNTIME_PATH_INVALID');
  await ownTreeEntry(target, uid, gid);
  return { path: target, uid, gid };
}

export async function finalizeBackup(rootInput) {
  const root = path.resolve(assertTextPath(rootInput, 'Backup root'));
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = await readJson(manifestFile);
  if (!manifest || manifest.status !== 'incomplete') fail('Backup manifest is missing or not pending.', 'BACKUP_MANIFEST_INVALID');
  for (const name of ['configuration', 'data', 'vault']) {
    const stat = await fsp.stat(path.join(root, name)).catch(() => null);
    if (!stat?.isDirectory()) fail(`Backup component is missing: ${name}`, 'BACKUP_COMPONENT_MISSING');
  }
  for (const name of ['data.inventory.json', 'vault.inventory.json']) {
    const stat = await fsp.stat(path.join(root, name)).catch(() => null);
    if (!stat?.isFile()) fail(`Backup inventory is missing: ${name}`, 'BACKUP_INVENTORY_MISSING');
  }
  const complete = { ...manifest, status: 'complete', completedAt: new Date().toISOString() };
  await atomicWrite(manifestFile, `${JSON.stringify(complete, null, 2)}\n`);
  return complete;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function printResult(result, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.command === 'backup') {
    process.stdout.write(`Backup prepared for ${result.instanceId}: ${result.backupPath}\n`);
    return;
  }
  if (result.command) {
    process.stdout.write(`Prepared ${result.command} for ${result.instanceId}.\n`);
    return;
  }
  process.stdout.write(`${result.reused ? 'Using' : 'Initialized'} ${result.instanceId}\n`);
  process.stdout.write(`Configuration: ${result.configDirectory}\n`);
  process.stdout.write(`Knowledge bases: ${result.knowledgeBasePath}\n`);
  process.stdout.write(`Local URL: http://127.0.0.1:${result.port}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (options.adminPasswordStdin) {
    if (command !== 'init' && command !== 'internal-preflight') {
      fail('--admin-password-stdin is only valid with init.', 'INVALID_ARGUMENT');
    }
    if (command === 'init') options.adminPassword = await readPasswordFromStdin();
  }
  let result;
  if (command === 'init') result = await initializeInstance(options);
  else if (command === 'backup') result = await prepareBackup(options);
  else if (command === 'internal-preflight') {
    result = await preflightInstaller(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (result.requiresVault) process.stdout.write('VAULT_REQUIRED\n');
    else process.stdout.write(`VAULT_PATH=${result.knowledgeBasePath}\n`);
    return result;
  }
  else if (command === 'internal-probe-path') {
    result = await probeWritablePath(options.source);
    if (!options.json) {
      process.stdout.write(`Path is readable and writable; free space: ${formatBytes(result.freeBytes)}.\n`);
    }
  } else if (command === 'internal-probe-vault') {
    result = await probeKnowledgeBasePath(options.source);
    if (!options.json) {
      process.stdout.write(`Obsidian knowledge base is readable and writable; free space: ${formatBytes(result.freeBytes)}.\n`);
    }
  } else if (command === 'internal-copy-tree') {
    result = await copyTreeForBackup(options.source, options.destination, {
      outputUid: options.outputUid,
      outputGid: options.outputGid,
    });
  } else if (command === 'internal-finalize-backup') {
    result = await finalizeBackup(options.backupRoot);
  } else if (command === 'internal-own-tree') {
    result = await ownRuntimeTree(options.source, {
      outputUid: options.outputUid,
      outputGid: options.outputGid,
    });
  } else {
    result = await prepareOperation(command, options);
  }
  if (INTERNAL_COMMANDS.has(command) && !options.json) return result;
  printResult(result, options.json);
  return result;
}

const launchedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (launchedDirectly) {
  main().catch((error) => {
    const code = error instanceof InstallerError ? error.code : 'INSTALLER_FAILED';
    process.stderr.write(`Second Mind installer error [${code}]: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const installerInternals = Object.freeze({
  envDocument,
  overlayDocument,
  parsePort,
  parseRuntimeId,
  validatePassword,
  validateInstanceId,
});
