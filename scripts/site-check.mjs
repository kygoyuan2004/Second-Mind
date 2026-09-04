import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HtmlValidate } from 'html-validate';
import {
  REQUIRED_SCREENSHOTS,
  REPOSITORY_ROOT,
  SITE_BASE,
  SITE_OUTPUT,
  SITE_SOURCE,
  buildSite,
} from './site-build.mjs';
import {
  classifyExternalLink,
  validateExternalLinks,
} from './site-link-check.mjs';

const allowMissingScreenshots = process.argv.includes('--allow-missing-screenshots');
const failures = [];
const warnings = [];
const htmlValidator = new HtmlValidate({
  root: true,
  extends: ['html-validate:recommended'],
});
const SCREENSHOT_DIMENSIONS = new Map([
  ['second-mind-qa.png', [1440, 1050]],
  ['second-mind-execution.png', [1440, 1050]],
  ['second-mind-provider-config.png', [1440, 1050]],
  ['second-mind-diary.png', [1280, 960]],
  ['second-mind-plan.png', [1280, 960]],
  ['second-mind-mobile.png', [360, 800]],
]);

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function codePointSort(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function isFile(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function walkFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => codePointSort(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(child.split(path.sep).join('/'));
    else fail(`Generated site contains unsupported entry: ${child}`);
  }
  return files;
}

async function treeDigest(root) {
  const digest = createHash('sha256');
  for (const relative of await walkFiles(root)) {
    digest.update(relative);
    digest.update('\0');
    digest.update(await readFile(path.join(root, relative)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function tags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => match[0]);
}

function attribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\s${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? match[2] : null;
}

function metaContent(html, attributeName, value) {
  const tag = tags(html, 'meta').find((candidate) => attribute(candidate, attributeName) === value);
  return tag ? attribute(tag, 'content') : null;
}

function linkTagsByRel(html, relation) {
  return tags(html, 'link').filter((tag) => {
    const rel = attribute(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    return rel.includes(relation);
  });
}

function idsIn(html) {
  return tags(html, '[a-z][a-z0-9-]*')
    .map((tag) => attribute(tag, 'id'))
    .filter(Boolean);
}

function isExternalReference(reference) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference);
}

function withoutQueryOrHash(reference) {
  return reference.split(/[?#]/, 1)[0];
}

function outputPathForReference(reference, htmlRelative) {
  const cleanReference = withoutQueryOrHash(reference);
  if (cleanReference.startsWith('/')) {
    if (!cleanReference.startsWith(SITE_BASE)) return null;
    let relative = decodeURIComponent(cleanReference.slice(SITE_BASE.length));
    if (relative === '' || relative.endsWith('/')) relative += 'index.html';
    return path.resolve(SITE_OUTPUT, relative);
  }
  const htmlDirectory = path.dirname(path.join(SITE_OUTPUT, htmlRelative));
  let resolved = path.resolve(htmlDirectory, decodeURIComponent(cleanReference));
  if (cleanReference.endsWith('/')) resolved = path.join(resolved, 'index.html');
  return resolved;
}

function expectedScreenshotReference(reference) {
  const filename = path.posix.basename(withoutQueryOrHash(reference));
  return REQUIRED_SCREENSHOTS.includes(filename);
}

async function validateReference(reference, htmlRelative, htmlByPath, description) {
  if (!reference || reference.startsWith('#') || isExternalReference(reference)) return;
  if (reference.startsWith('/') && !reference.startsWith(SITE_BASE)) {
    fail(`${htmlRelative}: ${description} escapes the ${SITE_BASE} base path: ${reference}`);
    return;
  }
  if (!reference.startsWith('/')) {
    fail(`${htmlRelative}: internal ${description} must use the ${SITE_BASE} base path: ${reference}`);
  }

  const target = outputPathForReference(reference, htmlRelative);
  if (!target || (!target.startsWith(`${SITE_OUTPUT}${path.sep}`) && target !== SITE_OUTPUT)) {
    fail(`${htmlRelative}: ${description} resolves outside dist: ${reference}`);
    return;
  }
  if (!(await isFile(target))) {
    // Required screenshot sources are reported once by the release-asset check.
    // Avoid turning one absent source file into a failure for every HTML use.
    if (expectedScreenshotReference(reference)) return;
    fail(`${htmlRelative}: broken ${description}: ${reference}`);
    return;
  }

  const hashIndex = reference.indexOf('#');
  if (hashIndex !== -1 && reference.slice(hashIndex + 1)) {
    const fragment = decodeURIComponent(reference.slice(hashIndex + 1));
    const targetRelative = path.relative(SITE_OUTPUT, target).split(path.sep).join('/');
    const targetHtml = htmlByPath.get(targetRelative) ?? await readFile(target, 'utf8');
    if (!new Set(idsIn(targetHtml)).has(fragment)) {
      fail(`${htmlRelative}: missing fragment #${fragment} in ${targetRelative}`);
    }
  }
}

function validateFragment(reference, html, htmlRelative) {
  if (!reference?.startsWith('#') || reference === '#') return;
  const fragment = decodeURIComponent(reference.slice(1));
  if (!new Set(idsIn(html)).has(fragment)) {
    fail(`${htmlRelative}: missing same-page fragment ${reference}`);
  }
}

function validateMetadata(html, htmlRelative, locale) {
  const expected = locale === 'zh-CN'
    ? {
        canonical: 'https://kygoyuan2004.github.io/Second-Mind/',
        alternate: 'https://kygoyuan2004.github.io/Second-Mind/en/',
      }
    : {
        canonical: 'https://kygoyuan2004.github.io/Second-Mind/en/',
        alternate: 'https://kygoyuan2004.github.io/Second-Mind/',
      };

  const htmlTag = tags(html, 'html')[0];
  if (attribute(htmlTag ?? '', 'lang') !== locale) fail(`${htmlRelative}: expected html lang=${locale}`);

  const titleMatches = [...html.matchAll(/<title>([^<]+)<\/title>/gi)];
  if (titleMatches.length !== 1 || titleMatches[0][1].trim().length < 20) {
    fail(`${htmlRelative}: needs one descriptive title`);
  }
  const description = metaContent(html, 'name', 'description');
  if (!description || description.length < 60) fail(`${htmlRelative}: needs a descriptive meta description`);
  if (metaContent(html, 'name', 'viewport') !== 'width=device-width, initial-scale=1') {
    fail(`${htmlRelative}: viewport metadata is missing or unexpected`);
  }

  const canonical = linkTagsByRel(html, 'canonical');
  if (canonical.length !== 1 || attribute(canonical[0], 'href') !== expected.canonical) {
    fail(`${htmlRelative}: canonical URL is missing or incorrect`);
  }

  const alternates = linkTagsByRel(html, 'alternate');
  const languages = new Map(alternates.map((tag) => [attribute(tag, 'hreflang'), attribute(tag, 'href')]));
  if (languages.get('zh-CN') !== 'https://kygoyuan2004.github.io/Second-Mind/') {
    fail(`${htmlRelative}: zh-CN hreflang is missing or incorrect`);
  }
  if (languages.get('en') !== 'https://kygoyuan2004.github.io/Second-Mind/en/') {
    fail(`${htmlRelative}: English hreflang is missing or incorrect`);
  }
  if (languages.get('x-default') !== 'https://kygoyuan2004.github.io/Second-Mind/') {
    fail(`${htmlRelative}: x-default hreflang is missing or incorrect`);
  }
  if (!languages.has(locale === 'zh-CN' ? 'en' : 'zh-CN') || ![...languages.values()].includes(expected.alternate)) {
    fail(`${htmlRelative}: reciprocal language alternate is missing`);
  }

  const requiredOpenGraph = ['og:type', 'og:site_name', 'og:locale', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt'];
  for (const property of requiredOpenGraph) {
    if (!metaContent(html, 'property', property)) fail(`${htmlRelative}: missing ${property} metadata`);
  }
  if (metaContent(html, 'property', 'og:url') !== expected.canonical) {
    fail(`${htmlRelative}: og:url does not match the canonical URL`);
  }
  if (metaContent(html, 'property', 'og:image') !== 'https://kygoyuan2004.github.io/Second-Mind/assets/second-mind-qa.png') {
    fail(`${htmlRelative}: og:image does not use the Pages base path`);
  }
}

function validateAccessibility(html, htmlRelative) {
  const ids = idsIn(html);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicateIds)) fail(`${htmlRelative}: duplicate id ${id}`);

  if (!/<a\b[^>]*class=["'][^"']*skip-link[^"']*["'][^>]*href=["']#main["']/i.test(html)) {
    fail(`${htmlRelative}: skip link to #main is missing`);
  }
  if (!/<main\b[^>]*id=["']main["']/i.test(html)) fail(`${htmlRelative}: main landmark is missing`);
  if (!tags(html, 'nav').every((tag) => attribute(tag, 'aria-label'))) {
    fail(`${htmlRelative}: every nav needs an accessible label`);
  }

  const headings = [...html.matchAll(/<h([1-6])\b/gi)].map((match) => Number(match[1]));
  if (headings.filter((level) => level === 1).length !== 1) fail(`${htmlRelative}: expected exactly one h1`);
  for (let index = 1; index < headings.length; index += 1) {
    if (headings[index] > headings[index - 1] + 1) {
      fail(`${htmlRelative}: heading level jumps from h${headings[index - 1]} to h${headings[index]}`);
    }
  }

  for (const imageTag of tags(html, 'img')) {
    const source = attribute(imageTag, 'src');
    if (!source) fail(`${htmlRelative}: image is missing src`);
    const alt = attribute(imageTag, 'alt');
    if (!alt?.trim()) fail(`${htmlRelative}: image needs meaningful alt text`);
    if (!/^\d+$/.test(attribute(imageTag, 'width') ?? '') || !/^\d+$/.test(attribute(imageTag, 'height') ?? '')) {
      fail(`${htmlRelative}: image needs numeric width and height attributes`);
    }
    const expected = SCREENSHOT_DIMENSIONS.get(path.posix.basename(withoutQueryOrHash(source || '')));
    if (expected && (
      Number(attribute(imageTag, 'width')) !== expected[0]
      || Number(attribute(imageTag, 'height')) !== expected[1]
    )) {
      fail(`${htmlRelative}: screenshot dimensions do not match the canonical image: ${source}`);
    }
  }
  for (const buttonTag of tags(html, 'button')) {
    if (attribute(buttonTag, 'type') !== 'button') fail(`${htmlRelative}: every button needs type=button`);
  }

  const idSet = new Set(ids);
  for (const tab of tags(html, '[a-z][a-z0-9-]*').filter((tag) => attribute(tag, 'role') === 'tab')) {
    const controls = attribute(tab, 'aria-controls');
    if (!controls || !idSet.has(controls)) fail(`${htmlRelative}: tab has invalid aria-controls`);
    if (!['true', 'false'].includes(attribute(tab, 'aria-selected'))) fail(`${htmlRelative}: tab needs aria-selected`);
    if (!['0', '-1'].includes(attribute(tab, 'tabindex'))) fail(`${htmlRelative}: tab needs managed tabindex`);
  }
  for (const panel of tags(html, '[a-z][a-z0-9-]*').filter((tag) => attribute(tag, 'role') === 'tabpanel')) {
    const labelledBy = attribute(panel, 'aria-labelledby');
    if (!labelledBy || !idSet.has(labelledBy)) fail(`${htmlRelative}: tabpanel has invalid aria-labelledby`);
  }
  const toggle = tags(html, 'button').find((tag) => attribute(tag, 'class')?.split(/\s+/).includes('nav-toggle'));
  if (!toggle || attribute(toggle, 'aria-expanded') !== 'false' || !idSet.has(attribute(toggle, 'aria-controls'))) {
    fail(`${htmlRelative}: navigation toggle state or relationship is invalid`);
  }
  for (const visual of tags(html, '[a-z][a-z0-9-]*').filter((tag) => attribute(tag, 'role') === 'img')) {
    if (!attribute(visual, 'aria-label')) fail(`${htmlRelative}: code-native visual needs an accessible label`);
  }
}

function validateClaims(html, htmlRelative, locale) {
  const requiredSectionIds = ['capabilities', 'knowledge-bases', 'privacy', 'architecture', 'screenshots', 'quickstart', 'limits'];
  const idSet = new Set(idsIn(html));
  for (const id of requiredSectionIds) {
    if (!idSet.has(id)) fail(`${htmlRelative}: missing #${id} section`);
  }

  const requiredPatterns = locale === 'zh-CN'
    ? [
        [/自托管/, 'self-hosted positioning'],
        [/单管理员/, 'single-admin boundary'],
        [/多知识库/, 'multiple knowledge bases'],
        [/BYOK/, 'BYOK'],
        [/隐私/, 'privacy'],
        [/架构/, 'architecture'],
        [/真实产品截图/, 'real screenshots'],
        [/跨库联合检索/, 'no cross-base search limit'],
      ]
    : [
        [/self-hosted/i, 'self-hosted positioning'],
        [/single-admin|single admin/i, 'single-admin boundary'],
        [/multiple knowledge bases/i, 'multiple knowledge bases'],
        [/BYOK/, 'BYOK'],
        [/privacy/i, 'privacy'],
        [/architecture/i, 'architecture'],
        [/real product screenshots/i, 'real screenshots'],
        [/cross-base federated search/i, 'no cross-base search limit'],
      ];
  for (const [pattern, description] of requiredPatterns) {
    if (!pattern.test(html)) fail(`${htmlRelative}: missing ${description} claim`);
  }
  for (const platform of ['Linux', 'macOS', 'Windows']) {
    if (!html.includes(platform)) fail(`${htmlRelative}: quick start is missing ${platform}`);
  }
  if (!/href=["']https:\/\/github\.com\/kygoyuan2004\/Second-Mind["']/i.test(html)) {
    fail(`${htmlRelative}: primary GitHub link is missing`);
  }
  if (!/href=["']https:\/\/github\.com\/kygoyuan2004\/Second-Mind\/(?:tree|blob)\/main\/docs/i.test(html)) {
    fail(`${htmlRelative}: documentation link is missing`);
  }
  for (const screenshot of REQUIRED_SCREENSHOTS) {
    if (!html.includes(`${SITE_BASE}assets/${screenshot}`)) {
      fail(`${htmlRelative}: does not reference ${screenshot}`);
    }
  }
}

async function validateHtmlSyntax(html, htmlRelative) {
  const report = await htmlValidator.validateString(html, `dist/${htmlRelative}`);
  for (const result of report.results) {
    for (const message of result.messages) {
      const detail = message.message.replace(/\s+/g, ' ').trim();
      fail(`${htmlRelative}:${message.line}:${message.column} [${message.ruleId}] ${detail}`);
    }
  }
}

function sectionSyncKeys(html) {
  return tags(html, 'section')
    .map((tag) => attribute(tag, 'data-sync-key'))
    .filter(Boolean)
    .sort(codePointSort);
}

function parseHex(hex) {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) throw new Error(`Unsupported color ${hex}`);
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255);
}

function relativeLuminance(hex) {
  const channels = parseHex(hex).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(left, right) {
  const first = relativeLuminance(left);
  const second = relativeLuminance(right);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function cssVariables(block) {
  return new Map([...block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)]
    .map((match) => [match[1], match[2]]));
}

function validateCss(css) {
  const requiredPatterns = [
    [/@media\s*\(max-width:\s*768px\)/, '768px responsive breakpoint'],
    [/@media\s*\(max-width:\s*420px\)/, 'small-screen responsive breakpoint'],
    [/@media\s*\(prefers-color-scheme:\s*dark\)/, 'automatic dark mode'],
    [/@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'reduced-motion handling'],
    [/:focus-visible/, 'keyboard focus styles'],
  ];
  for (const [pattern, description] of requiredPatterns) {
    if (!pattern.test(css)) fail(`styles.css: missing ${description}`);
  }
  if (/@import\b/i.test(css) || /url\(\s*["']?https?:/i.test(css)) {
    fail('styles.css: remote CSS or font resources are not allowed');
  }

  const lightRoot = css.match(/:root\s*\{([^}]+)\}/)?.[1] ?? '';
  const darkRoot = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*?:root\s*\{([^}]+)\}/)?.[1] ?? '';
  const light = cssVariables(lightRoot);
  const dark = cssVariables(darkRoot);
  const pairs = [
    ['light body text', light.get('ink'), light.get('bg')],
    ['light secondary text', light.get('ink-soft'), light.get('bg')],
    ['light faint text on page', light.get('ink-faint'), light.get('bg')],
    ['light faint text on surface', light.get('ink-faint'), light.get('surface')],
    ['light link text', light.get('accent'), light.get('bg')],
    ['light button text', '#ffffff', light.get('accent')],
    ['deep body text', light.get('deep-ink'), light.get('deep')],
    ['deep secondary text', light.get('deep-muted'), light.get('deep')],
    ['dark body text', dark.get('ink'), dark.get('bg')],
    ['dark secondary text', dark.get('ink-soft'), dark.get('bg')],
    ['dark faint text on page', dark.get('ink-faint'), dark.get('bg')],
    ['dark faint text on surface', dark.get('ink-faint'), dark.get('surface')],
    ['dark link text', dark.get('accent'), dark.get('bg')],
  ];
  for (const [label, foreground, background] of pairs) {
    if (!foreground || !background) {
      fail(`styles.css: cannot resolve ${label} colors`);
    } else if (contrastRatio(foreground, background) < 4.5) {
      fail(`styles.css: ${label} contrast is below 4.5:1`);
    }
  }
}

function validatePrivacy(files) {
  const combined = [...files.values()].join('\n');
  const privatePathPatterns = [
    /\/(?:home|Users)\/[A-Za-z0-9._-]+\//,
    /[A-Za-z]:\\Users\\[^\\\s]+\\/,
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)/i,
  ];
  for (const pattern of privatePathPatterns) {
    if (pattern.test(combined)) fail(`site source contains a private host path or backend URL matching ${pattern}`);
  }
  const secretPatterns = [
    /\bsk-[A-Za-z0-9_-]{12,}\b/,
    /\bghp_[A-Za-z0-9]{20,}\b/,
    /\bAIza[A-Za-z0-9_-]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/,
  ];
  for (const pattern of secretPatterns) {
    if (pattern.test(combined)) fail(`site source contains a credential-like value matching ${pattern}`);
  }
  if (/(?:googletagmanager|google-analytics|plausible\.io|segment\.com|hotjar|mixpanel|matomo)/i.test(combined)) {
    fail('site source includes a tracking or analytics endpoint');
  }
  const javascript = files.get('site.js') ?? '';
  if (/(?:document\.cookie|localStorage|sessionStorage|sendBeacon|XMLHttpRequest|\bfetch\s*\()/i.test(javascript)) {
    fail('site.js performs storage, cookie, or network operations');
  }
  if (/[—–]/u.test(combined)) fail('site source contains a visible em dash or en dash character');
}

async function validatePng(filename) {
  const fullPath = path.join(SITE_OUTPUT, 'assets', filename);
  if (!(await isFile(fullPath))) return null;
  const bytes = await readFile(fullPath);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)) {
    fail(`assets/${filename}: expected a valid PNG file`);
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (bytes.length < 1024 || width < 320 || height < 240) {
    fail(`assets/${filename}: screenshot is unexpectedly small (${width}x${height}, ${bytes.length} bytes)`);
  }
  const expected = SCREENSHOT_DIMENSIONS.get(filename);
  if (expected && (width !== expected[0] || height !== expected[1])) {
    fail(`assets/${filename}: expected ${expected[0]}x${expected[1]}, found ${width}x${height}`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

async function main() {
  const firstBuild = await buildSite({ log: false });
  const firstDigest = await treeDigest(SITE_OUTPUT);
  await writeFile(path.join(SITE_OUTPUT, '.site-check-stale'), 'stale\n', 'utf8');
  const secondBuild = await buildSite({ log: false });
  const secondDigest = await treeDigest(SITE_OUTPUT);
  if (firstDigest !== secondDigest) fail('site build output is not deterministic or does not clean dist');

  const missingScreenshots = [...new Set([
    ...firstBuild.missingScreenshots,
    ...secondBuild.missingScreenshots,
  ])].sort(codePointSort);
  for (const filename of missingScreenshots) {
    const message = `docs/assets/${filename}: required release screenshot is missing`;
    if (allowMissingScreenshots) warn(message);
    else fail(message);
  }

  const expectedFiles = ['.nojekyll', 'index.html', 'en/index.html', 'styles.css', 'site.js'];
  for (const relative of expectedFiles) {
    if (!(await isFile(path.join(SITE_OUTPUT, relative)))) fail(`dist/${relative}: expected build output is missing`);
  }

  const sourceFiles = new Map();
  for (const relative of await walkFiles(SITE_SOURCE)) {
    sourceFiles.set(relative, await readFile(path.join(SITE_SOURCE, relative), 'utf8'));
  }
  validatePrivacy(sourceFiles);
  validateCss(sourceFiles.get('styles.css') ?? '');

  const htmlByPath = new Map([
    ['index.html', await readFile(path.join(SITE_OUTPUT, 'index.html'), 'utf8')],
    ['en/index.html', await readFile(path.join(SITE_OUTPUT, 'en', 'index.html'), 'utf8')],
  ]);
  const externalReferences = new Set();

  for (const [htmlRelative, html] of htmlByPath) {
    const locale = htmlRelative === 'index.html' ? 'zh-CN' : 'en';
    await validateHtmlSyntax(html, htmlRelative);
    validateMetadata(html, htmlRelative, locale);
    validateAccessibility(html, htmlRelative);
    validateClaims(html, htmlRelative, locale);

    if (/\son[a-z]+\s*=/i.test(html)) fail(`${htmlRelative}: inline event handlers are not allowed`);
    if (/<(?:iframe|form)\b/i.test(html)) fail(`${htmlRelative}: forms and embedded remote frames are not allowed`);

    const activeResources = [
      ...tags(html, 'script').map((tag) => ['script', attribute(tag, 'src')]),
      ...tags(html, 'img').map((tag) => ['image', attribute(tag, 'src')]),
      ...linkTagsByRel(html, 'stylesheet').map((tag) => ['stylesheet', attribute(tag, 'href')]),
    ];
    for (const [kind, reference] of activeResources) {
      if (!reference) continue;
      if (isExternalReference(reference)) {
        fail(`${htmlRelative}: remote ${kind} is not allowed: ${reference}`);
      } else {
        await validateReference(reference, htmlRelative, htmlByPath, kind);
      }
    }

    for (const anchor of tags(html, 'a')) {
      const reference = attribute(anchor, 'href');
      if (!reference) {
        fail(`${htmlRelative}: anchor is missing href`);
        continue;
      }
      validateFragment(reference, html, htmlRelative);
      if (isExternalReference(reference)) {
        const target = classifyExternalLink(reference);
        if (target.kind === 'site') {
          await validateReference(target.reference, htmlRelative, htmlByPath, 'link');
        } else if (target.kind === 'network') {
          externalReferences.add(target.url);
        } else {
          fail(`${htmlRelative}: ${target.message}`);
        }
      } else {
        await validateReference(reference, htmlRelative, htmlByPath, 'link');
      }
    }
  }

  for (const issue of await validateExternalLinks(externalReferences)) {
    fail(`external link check: ${issue}`);
  }

  const chineseKeys = sectionSyncKeys(htmlByPath.get('index.html'));
  const englishKeys = sectionSyncKeys(htmlByPath.get('en/index.html'));
  if (JSON.stringify(chineseKeys) !== JSON.stringify(englishKeys)) {
    fail('Chinese and English pages do not expose the same synchronized section keys');
  }

  const screenshotHashes = new Map();
  for (const filename of REQUIRED_SCREENSHOTS) {
    const digest = await validatePng(filename);
    if (!digest) continue;
    if (screenshotHashes.has(digest)) {
      fail(`assets/${filename}: duplicates screenshot bytes from ${screenshotHashes.get(digest)}`);
    } else {
      screenshotHashes.set(digest, filename);
    }
  }

  for (const message of warnings) process.stderr.write(`WARN ${message}\n`);
  if (failures.length > 0) {
    for (const message of failures) process.stderr.write(`FAIL ${message}\n`);
    process.stderr.write(`Site check failed with ${failures.length} problem${failures.length === 1 ? '' : 's'}.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Site check passed${warnings.length > 0 ? ` with ${warnings.length} expected screenshot warnings` : ''}.\n`);
}

await main();
