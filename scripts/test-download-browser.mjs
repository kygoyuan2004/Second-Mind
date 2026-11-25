import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { SITE_BASE, SITE_OUTPUT, buildSite } from './site-build.mjs';
import { validateExternalLinks } from './site-link-check.mjs';
import { checkReleaseManifest } from './download-page.mjs';

await buildSite({ log: false });
const release = JSON.parse(await fs.readFile(path.join(SITE_OUTPUT, 'releases.json')));
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!url.pathname.startsWith(SITE_BASE)) { res.writeHead(404).end(); return; }
  const relative = decodeURIComponent(url.pathname.slice(SITE_BASE.length));
  const filename = path.resolve(SITE_OUTPUT, relative + (url.pathname.endsWith('/') ? 'index.html' : ''));
  if (!filename.startsWith(SITE_OUTPUT + path.sep)) { res.writeHead(403).end(); return; }
  const stat = await fs.stat(filename).catch(() => null);
  if (!stat?.isFile()) { res.writeHead(404).end(); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png':'image/png' };
  res.writeHead(200, { 'content-type': types[path.extname(filename)] || 'application/octet-stream' });
  createReadStream(filename).pipe(res);
});
const live = process.argv.includes('--live');
let origin = 'https://kygoyuan2004.github.io';
if (live) {
  checkReleaseManifest(release, true);
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(origin + SITE_BASE + 'releases.json?revision=' + (process.env.GITHUB_SHA || 'current'), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      assert.ok(response.ok);
      assert.deepEqual(await response.json(), release);
      break;
    } catch (error) {
      if (attempt === 11) throw error;
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  const links = release.editions.flatMap(e => [e.release, e.checksums, ...e.assets.map(f => f.url)]);
  assert.deepEqual(await validateExternalLinks(links), []);
} else {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
}

async function tabTo(page, target) {
  const limit = await page.locator('a[href], button, summary, input, select, textarea, [tabindex]').count() + 1;
  for (let step = 0; step <= limit; step++) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail('Tab could not reach ' + (await target.innerText()).trim());
}

async function verifyCommand(page, block, expected, js) {
  assert.equal(await block.locator('code').innerText(), expected);
  const button = block.locator('button.copy');
  if (js) {
    await button.click();
    await block.locator('button.success').waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
  } else {
    assert.equal(await button.isVisible(), false);
  }
}

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.SECOND_MIND_TEST_CHROME || undefined });
  for (const lang of ['zh', 'en']) {
    const home = SITE_BASE + (lang === 'en' ? 'en/' : '');
    for (const width of [1440, 390, 360]) {
      for (const mode of [true, false].flatMap(js => ['light', 'dark'].map(theme => ({ js, theme })))) {
        const context = await browser.newContext({ viewport: { width, height: width > 400 ? 960 : 844 }, javaScriptEnabled: mode.js, colorScheme: mode.theme, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + home);
        const cta = page.locator('#hero .button.primary');
        assert.equal((await cta.innerText()).trim(), lang === 'en' ? 'Download & Try' : '下载尝试');
        assert.equal(await page.locator('a[href="#quickstart"]').count() > 0, true);
        await tabTo(page, cta);
        await page.keyboard.press('Enter');
        await page.waitForURL(origin + home + 'download/');
        assert.equal(await page.locator('.platform-row').count(), 4);
        const readme = lang === 'zh' ? 'README.md' : 'README.en.md';
        assert.equal(await page.locator('.download-hero .text-link').getAttribute('href'),
          release.editions.find(edition => edition.id === 'pi').repo + '/blob/main/' + readme + '#comparison');
        assert.ok(await page.locator('body').evaluate(e => e.scrollWidth <= window.innerWidth));
        const [left, right] = await Promise.all([0,1].map(i => page.locator('#windows .edition-cell').nth(i).boundingBox()));
        assert.ok(width > 520 ? right.x > left.x + left.width - 1 : right.y >= left.y + left.height - 1);
        if (mode.js) await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
        for (const link of await page.locator('a.download-file').all()) await tabTo(page, link);
        if (mode.js) {
          const dockerCommand = page.locator('#docker-pi [data-copy-block]').first();
          await tabTo(page, dockerCommand.locator('button'));
          await page.keyboard.press('Enter');
          await dockerCommand.locator('button.success').waitFor({ timeout: 5000 });
          assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await dockerCommand.locator('code').innerText());
        }
        const entry = page.locator('#checksums details.hash-entry').last();
        await tabTo(page, entry.locator('summary'));
        await page.keyboard.press('Space');
        assert.equal(await entry.evaluate(details => details.open), true);
        await page.keyboard.press('Enter');
        assert.equal(await entry.evaluate(details => details.open), false);
        for (const edition of release.editions) {
          const scope = page.locator('#docker-' + edition.id);
          assert.ok((await scope.innerText()).includes('127.0.0.1:' + edition.port));
          const repoName = edition.repo.split('/').at(-1);
          const clone = 'git clone --depth 1 --branch v' + edition.version + ' ' + edition.repo + '.git';
          const image = 'ghcr.io/kygoyuan2004/' + repoName.toLowerCase() + ':v' + edition.version;
          const dockerCommands = scope.locator('[data-copy-block]');
          assert.equal(await dockerCommands.count(), 2);
          await verifyCommand(page, dockerCommands.nth(0), clone + " &&\n  SECOND_MIND_IMAGE='" + image + "' bash ./" + repoName + '/install.sh', mode.js);
          await verifyCommand(page, dockerCommands.nth(1), [
            'powershell -NoProfile -ExecutionPolicy RemoteSigned -Command {',
            '  ' + clone,
            '  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
            "  $env:SECOND_MIND_IMAGE = '" + image + "'",
            '  & .\\' + repoName + '\\install.ps1',
            '}',
          ].join('\n'), mode.js);

          const editionHeading = page.getByRole('heading', { name: edition.name + ' v' + edition.version, exact: true });
          const linux = page.locator('#linux .edition-cell').filter({ has: editionHeading });
          await linux.locator('summary').click();
          const appImage = edition.assets.find(asset => asset.format === '.AppImage').name;
          const deb = edition.assets.find(asset => asset.format === '.deb').name;
          const linuxCommands = linux.locator('[data-copy-block]');
          await verifyCommand(page, linuxCommands.nth(0), 'chmod +x ' + appImage + '\n./' + appImage, mode.js);
          await verifyCommand(page, linuxCommands.nth(1), 'sudo apt install ./' + deb, mode.js);
          for (const asset of edition.assets.filter(a => a.sha256)) {
            const cell = page.locator('#' + asset.os + ' .edition-cell').filter({ has: editionHeading });
            const cpu = asset.os === 'macos' ? (asset.arch === 'arm64' ? 'Apple Silicon (arm64)' : 'Intel (x64)') : asset.arch;
            const link = cell.getByRole('link', { name: edition.name + ' · ' + cpu + ' ' + asset.format, exact: true });
            assert.equal(await link.getAttribute('href'), asset.url);
            const disclosure = page.locator('details').filter({ has: page.locator('summary', { hasText: asset.name }) });
            await disclosure.locator('summary').click();
            assert.ok((await disclosure.innerText()).includes(asset.sha256));
            const checksum = asset.os === 'windows' ? 'Get-FileHash .\\' + asset.name + ' -Algorithm SHA256'
              : (asset.os === 'macos' ? 'shasum -a 256 ' : 'sha256sum ') + asset.name;
            await verifyCommand(page, disclosure.locator('[data-copy-block]'), checksum, mode.js);
            await disclosure.locator('summary').click();
          }
        }
        const block = page.locator('#first-open [data-copy-block]');
        await verifyCommand(page, block, 'xattr -dr com.apple.quarantine "/Applications/Second Mind Pi.app"', mode.js);
        const contrastFailures = await page.evaluate(() => {
          const rgb = value => value.match(/[\d.]+/g).map(Number);
          const luminance = values => values.slice(0, 3).map(n => n / 255)
            .map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
            .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
          return [...document.querySelectorAll('main a, main p, main small, main .copy, main .download-pending, main summary')]
            .filter(el => el.getClientRects().length).filter(el => {
              let ancestor = el;
              let background = [255, 255, 255];
              while (ancestor) {
                const color = rgb(getComputedStyle(ancestor).backgroundColor);
                if (color[3] !== 0) { background = color; break; }
                ancestor = ancestor.parentElement;
              }
              const fg = luminance(rgb(getComputedStyle(el).color));
              const bg = luminance(background);
              return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05) < 4.5;
            }).map(el => el.textContent.trim());
        });
        assert.deepEqual(contrastFailures, []);
        await page.reload();
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '#main');
        await page.keyboard.press('Enter');
        assert.ok(page.url().endsWith('#main'));
        assert.deepEqual(errors, []);
        if (process.env.SITE_PREVIEW_SHOTS && lang === 'zh') {
          const folder = path.resolve(process.env.SITE_PREVIEW_SHOTS);
          await fs.mkdir(folder, { recursive: true });
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: path.join(folder, 'download-' + width + '-' + mode.theme + (mode.js ? '-js' : '-static') + '.png') });
        }
        await context.close();
      }
    }
  }
  console.log('24 bilingual desktop/mobile browser journeys passed, including no-JavaScript links, clipboard, theme and keyboard.');
} finally {
  await browser?.close();
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
