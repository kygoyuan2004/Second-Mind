import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SCREENSHOT_PATHS = Object.freeze([
  'docs/assets/second-mind-hero.png',
  'docs/assets/second-mind-qa.png',
  'docs/assets/second-mind-execution.png',
  'docs/assets/second-mind-provider-config.png',
  'docs/assets/second-mind-diary.png',
  'docs/assets/second-mind-plan.png',
  'docs/assets/second-mind-mobile.png',
]);

const credentialPatterns = Object.freeze([
  Object.freeze({
    category: 'GitHub access token',
    regex: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/iu,
  }),
  Object.freeze({
    category: 'OpenAI-style secret',
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/iu,
  }),
  Object.freeze({
    category: 'AWS access key',
    regex: /\bAKIA[0-9A-Z]{16}\b/u,
  }),
  Object.freeze({
    category: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{30,}\b/u,
  }),
  Object.freeze({
    category: 'Slack token',
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/iu,
  }),
  Object.freeze({
    category: 'Stripe live secret',
    regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/iu,
  }),
  Object.freeze({
    category: 'bearer token',
    regex: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}\b/iu,
  }),
  Object.freeze({
    category: 'visible credential value',
    regex: /\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret)\b\s*(?:=|:|is)\s*["']?[A-Za-z0-9._~+/=-]{12,}/iu,
  }),
]);

const privatePathPatterns = Object.freeze([
  /(?:^|[^A-Za-z0-9])\/(?:home|Users)\/[A-Za-z0-9._-]+(?:\/[^\s]*)?/iu,
  /(?:^|[^A-Za-z0-9])\/root(?:\/[^\s]*)?/iu,
  /\b[A-Za-z]:\\Users\\[^\s\\]+(?:\\[^\s]*)?/iu,
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parsePrivateTerms(value = process.env.SECOND_MIND_PRIVATE_SCAN_TERMS) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function containsIpv4(text) {
  const candidates = String(text).matchAll(/(?:^|[^0-9])((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?![0-9])/gu);
  for (const candidate of candidates) {
    if (candidate[1].split('.').every((octet) => Number(octet) <= 255)) return true;
  }
  return false;
}

function containsIpv6(text) {
  return /(?:^|[^0-9A-Fa-f:])::1(?:$|[^0-9A-Fa-f:])/u.test(text)
    || /\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b/u.test(text);
}

export function findOcrCategories(text, privateTerms = parsePrivateTerms()) {
  const source = String(text || '');
  const categories = new Set();

  for (const pattern of credentialPatterns) {
    if (pattern.regex.test(source)) categories.add(pattern.category);
  }
  if (privatePathPatterns.some((regex) => regex.test(source))) categories.add('private filesystem path');
  if (/\blocalhost\b/iu.test(source)) categories.add('localhost address');
  if (containsIpv4(source) || containsIpv6(source)) categories.add('IP address');

  if (privateTerms.length) {
    const privatePattern = new RegExp(privateTerms.map(escapeRegExp).join('|'), 'iu');
    if (privatePattern.test(source)) categories.add('operator-supplied private term');
  }
  return [...categories];
}

async function recognizeScreenshot(relative, tesseract) {
  const filename = path.join(projectRoot, relative);
  try {
    const { stdout } = await execFileAsync(tesseract, [
      filename,
      'stdout',
      '--dpi',
      '144',
      '-l',
      'eng+chi_sim',
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const reason = error?.code === 'ENOENT'
      ? 'Tesseract is not installed or is not on PATH.'
      : 'Tesseract could not read the screenshot.';
    throw new Error(`${relative}: ${reason}`);
  }
}

export async function runOcrScan({
  tesseract = process.env.TESSERACT_BINARY || 'tesseract',
  privateTerms = parsePrivateTerms(),
} = {}) {
  const findings = [];
  for (const relative of SCREENSHOT_PATHS) {
    const text = await recognizeScreenshot(relative, tesseract);
    for (const category of findOcrCategories(text, privateTerms)) {
      findings.push({ relative, category });
    }
  }
  return findings;
}

export function formatFindings(findings) {
  return [
    'Potential screenshot OCR publication blockers:',
    ...findings.map(({ relative, category }) => `- ${relative}: ${category}`),
  ].join('\n');
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  try {
    const findings = await runOcrScan();
    if (findings.length) {
      console.error(formatFindings(findings));
      process.exitCode = 1;
    } else {
      console.log(`Screenshot OCR scan passed (${SCREENSHOT_PATHS.length} canonical images).`);
    }
  } catch (error) {
    console.error(`Screenshot OCR scan failed: ${error.message}`);
    process.exitCode = 1;
  }
}
