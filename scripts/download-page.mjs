const base = '/Second-Mind/';
const origin = 'https://kygoyuan2004.github.io';
const platforms = ['windows', 'macos', 'linux', 'docker'];
const labels = { windows: 'Windows', macos: 'macOS', linux: 'Linux', docker: 'Docker' };
const packageSuffixes = {
  'windows/x64/.exe': 'windows-x64-setup.exe',
  'linux/x64/.AppImage': 'linux-x86_64.AppImage',
  'linux/amd64/.deb': 'linux-amd64.deb',
  'macos/arm64/.dmg': 'macos-arm64.dmg',
  'macos/x64/.dmg': 'macos-x64.dmg',
};
const quarantine = 'xattr -dr com.apple.quarantine "/Applications/Second Mind Pi.app"';
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function checkReleaseManifest(manifest, published = false) {
  const expected = { claude: 'Second-Mind', pi: 'Second_Mind_PIAGENT_OPTIMIZE' };
  if (manifest.editions.map(edition => edition.id).join() !== 'claude,pi') throw new Error('Both editions are required');
  for (const [id, repository] of Object.entries(expected)) {
    const edition = manifest.editions.find(item => item.id === id);
    const repo = 'https://github.com/kygoyuan2004/' + repository;
    const version = edition.version;
    const releaseBase = repo + '/releases/download/v' + version + '/';
    if (!/^\d+\.\d+\.\d+$/.test(version) || edition.repo !== repo ||
        edition.release !== repo + '/releases/tag/v' + version || edition.checksums !== releaseBase + 'SHA256SUMS.txt' ||
        edition.port !== (id === 'pi' ? 8788 : 8787) ||
        edition.image !== 'ghcr.io/kygoyuan2004/' + repository.toLowerCase() + ':' + (id === 'pi' ? 'v' + version : 'latest')) {
      throw new Error('Invalid release metadata for ' + id);
    }
    const signatures = edition.assets.map(file => [file.os, file.arch, file.format].join('/')).sort();
    const required = Object.keys(packageSuffixes).filter(key => id === 'pi' || !key.startsWith('macos/'));
    if (signatures.join() !== required.sort().join() || new Set(edition.assets.map(a => a.name)).size !== required.length) {
      throw new Error('Incomplete or duplicated platforms in ' + id);
    }
    for (const file of edition.assets) {
      const suffix = packageSuffixes[[file.os, file.arch, file.format].join('/')];
      const prefix = id === 'pi' ? 'SecondMindPi-' : 'SecondMind-';
      if (file.name !== prefix + version + '-' + suffix || file.url !== releaseBase + file.name) {
        throw new Error('Asset filename or URL does not match its platform and architecture: ' + file.name);
      }
      if (file.sha256 === null && file.bytes === null && !published && id === 'pi') continue;
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
        throw new Error('Release checksum or byte length missing for ' + file.name);
      }
    }
  }
}

export function renderDownload(manifest, locale) {
  const zh = locale === 'zh-CN';
  const t = (cn, en) => zh ? cn : en;
  const home = base + (zh ? '' : 'en/');
  const here = home + 'download/';
  const other = base + (zh ? 'en/' : '') + 'download/';
  const [claude, pi] = manifest.editions;
  const ready = edition => edition.assets.every(file => file.sha256);
  const title = t('下载 Second Mind', 'Download Second Mind');
  const description = t('按操作系统选择 Claude SDK 或 Pi Agent，下载安装程序、核对文件校验值，或用 Docker 在自己的设备上部署 Second Mind。', 'Compare Claude SDK and Pi Agent, download the installer for your device, verify the checksum, or run Second Mind with Docker.');
  function snippet(label, command) {
    return `<div class="download-command" data-copy-block><div class="command-head"><strong>${escape(label)}</strong><button class="copy interactive" type="button">${t('复制','Copy')}</button></div><pre><code>${escape(command)}</code></pre></div>`;
  }
  function fileButton(edition, file) {
    const arch = file.os === 'macos' ? (file.arch === 'arm64' ? 'Apple Silicon (arm64)' : 'Intel (x64)') : file.arch;
    const name = edition.name + ' · ' + arch + ' ' + file.format;
    if (!file.sha256) return `<span class="download-pending">${escape(name)} · ${t('发行验收中','In release testing')}</span>`;
    return `<a class="button download-file" href="${escape(file.url)}">${escape(name)} <span aria-hidden="true">↓</span></a>`;
  }
  function platformCell(edition, os) {
    const key = edition.id;
    const files = edition.assets.filter(file => file.os === os);
    let body;
    if (os === 'docker') {
      body = `<code class="image-ref">${escape(edition.image)}</code><p>${t('本机端口','Local port')} <strong>${edition.port}</strong></p><a class="text-link" href="#docker-${key}">${t('查看安装命令','View install commands')} →</a>`;
    } else if (os === 'macos' && key === 'claude') {
      body = `<p>Docker Desktop · Apple Silicon / Intel</p><a class="text-link" href="#docker-claude">${t('用 Docker 安装 Claude SDK','Install Claude SDK with Docker')} →</a>`;
    } else {
      body = `<div class="file-list">${files.map(file => fileButton(edition, file)).join('')}</div>`;
      if (os === 'linux') {
        const appImage = files.find(file => file.format === '.AppImage').name;
        const deb = files.find(file => file.format === '.deb').name;
        body += `<details class="install-hint"><summary>${t('Linux 安装步骤','Linux install steps')}</summary>${snippet('AppImage', 'chmod +x ' + appImage + '\n./' + appImage)}${snippet('Debian / Ubuntu', 'sudo apt install ./' + deb)}</details>`;
      }
      if (os === 'windows') body += `<p>${t('下载后运行安装程序，为当前用户安装。','Run the installer for your current Windows account.')} <a href="#first-open">SmartScreen</a></p>`;
      if (os === 'macos') body += `<p>${t('开源未公证构建','Open-source, unnotarized builds')} · <a href="#first-open">${t('首次打开说明','First launch')}</a></p>`;
    }
    return `<div class="edition-cell"><h3>${edition.name} <small>v${edition.version}</small></h3>${body}</div>`;
  }
  function releaseLinks(edition) {
    if (!ready(edition)) return `<p>${t('校验清单将在发行物验收后公布。','Checksums will be available after release verification.')}</p>`;
    return `<p class="download-links"><a href="${edition.release}">${t('发行说明','Release notes')}</a> · <a href="${edition.checksums}">SHA256SUMS.txt</a></p>`;
  }
  function hashCommand(file) {
    if (file.os === 'windows') return 'Get-FileHash .\\' + file.name + ' -Algorithm SHA256';
    return (file.os === 'macos' ? 'shasum -a 256 ' : 'sha256sum ') + file.name;
  }
  function dockerInstructions(edition) {
    const repoName = edition.repo.split('/').at(-1);
    const clone = 'git clone --depth 1 --branch v' + edition.version + ' ' + edition.repo + '.git\ncd ' + repoName + '\n';
    return `<article id="docker-${edition.id}" class="install-detail"><h3>${edition.name} <small>v${edition.version}</small></h3>
<p>${t('安装完成后，在本机浏览器访问','After setup, open')} <code>127.0.0.1:${edition.port}</code></p>
${snippet('Linux / macOS · Bash', clone + 'bash ./install.sh')}
${snippet('Windows · PowerShell', clone + 'powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\\install.ps1')}</article>`;
  }
  const sections = platforms.map(os => `<section class="platform-row" id="${os}" data-sync-key="platform-${os}" aria-labelledby="heading-${os}">
<div class="platform-name"><h2 id="heading-${os}">${labels[os]}</h2><p>${escape(manifest.platforms[os][zh ? 'zh' : 'en'])}</p></div>
${manifest.editions.map(edition => platformCell(edition, os)).join('')}</section>`).join('\n');
  const compare = pi.repo + '/blob/main/' + (zh ? 'README.md' : 'README.en.md') + '#comparison';
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | ${t('桌面安装包和 Docker 指引','Desktop installers and Docker')}</title>
<meta name="description" content="${escape(description)}"><link rel="canonical" href="${origin + here}">
<link rel="alternate" hreflang="zh-CN" href="${origin + base}download/"><link rel="alternate" hreflang="en" href="${origin + base}en/download/"><link rel="alternate" hreflang="x-default" href="${origin + base}download/">
<meta property="og:type" content="website"><meta property="og:site_name" content="Second Mind"><meta property="og:locale" content="${t('zh_CN','en_US')}"><meta property="og:title" content="${title}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${origin + here}"><meta property="og:image" content="${origin + base}assets/second-mind-qa.png"><meta property="og:image:alt" content="${t('Second Mind 知识问答界面','The Second Mind knowledge workspace')}"><meta name="color-scheme" content="light dark">
<link rel="icon" href="${base}favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${base}styles.css"><script src="${base}site.js" defer></script>
</head>
<body class="download-page">
<a class="skip-link" href="#main">${t('跳到主要内容','Skip to content')}</a>
<header><nav class="shell nav" aria-label="${t('主导航','Main navigation')}"><a class="brand" href="${home}"><span class="mark" aria-hidden="true">SM</span><strong>Second Mind</strong></a>
<button type="button" class="nav-toggle" aria-expanded="false" aria-controls="nav-links">${t('菜单','Menu')} ☰</button><div class="nav-links" id="nav-links">
<a href="${home}">${t('首页','Home')}</a><a href="#downloads">${t('下载','Downloads')}</a><a href="#install-docker">Docker</a><a href="#checksums">${t('校验文件','Checksums')}</a><a href="${other}" hreflang="${t('en','zh-CN')}" lang="${t('en','zh-CN')}">${t('English','中文')}</a></div></nav></header>
<main id="main" class="shell downloads">
<section class="download-hero" data-sync-key="download-hero" aria-labelledby="page-title"><div><h1 id="page-title">${t('下载','Download')} <span>Second Mind</span></h1>
<p>${t('已有 Anthropic Messages 接口，可以选择 Claude SDK 版。','Choose Claude SDK if you use an Anthropic Messages endpoint.')}</p>
<p>${t('Pi Agent 版还支持 OpenAI Chat Completions，提供同轮并发检索、逐行引用核验和阅读覆盖记录。','Pi Agent also supports OpenAI Chat Completions, parallel searches in a single turn, line-verified citations and reading coverage.')}</p>
<a class="text-link" href="${compare}">${t('比较两个版本的功能','Compare edition features')} ↗</a></div>
<div class="owl-window"><img src="${base}assets/second-mind-hero.png" width="1672" height="941" alt="${t('Second Mind 的猫头鹰在星空书桌前整理笔记','The Second Mind owl sorting notes at a starlit desk')}"></div></section>
<nav id="downloads" class="platform-jump" aria-label="${t('选择操作系统','Choose your platform')}">${platforms.map(os => `<a href="#${os}">${labels[os]} ↓</a>`).join('')}</nav>
${sections}
<section id="first-open" class="download-detail" data-sync-key="first-open"><h2>${t('首次打开桌面版','Opening a desktop app')}</h2>
<h3>macOS · Pi Agent</h3><p>${t('先用下方 SHA-256 清单校验 DMG。打开映像，把 Second Mind Pi.app 拖入「应用程序」。如果提示无法验证开发者或应用已损坏，重新核对哈希后，前往「系统设置 → 隐私与安全性 → 仍要打开」。也可对这一个已核验的应用使用下列命令。','Verify the DMG against the SHA-256 list below, then drag Second Mind Pi.app to Applications. If macOS reports an unidentified developer or a damaged app, recheck the hash, then choose System Settings → Privacy &amp; Security → Open Anyway. The following command also applies to this verified app alone.')}</p>
${snippet(t('终端 · 首次打开','Terminal · First launch'),quarantine)}
<h3>Windows · SmartScreen</h3><p>${t('两版的 Windows 安装包均未签名。请先核对 SHA-256。若 SmartScreen 提示未知发布者，确认来源后可选「更多信息」再选「仍要运行」。','Both Windows installers are unsigned. Verify the SHA-256 first. If SmartScreen reports an unknown publisher, confirm the source, choose More info, then Run anyway.')}</p></section>
<section id="install-docker" class="download-detail" data-sync-key="install-docker"><h2>${t('用 Docker 安装','Install with Docker')}</h2><p>${t('先安装 Git。Linux 使用 Docker Engine 和 Compose v2，macOS 与 Windows 使用 Docker Desktop。两版的运行状态和索引都保存在 Vault 之外。Docker 部署使用独立的数据卷。共用一个 Obsidian Vault 时，请依次执行写入任务。','Install Git first. Use Docker Engine and Compose v2 on Linux, or Docker Desktop on macOS and Windows. Both editions store runtime state and indexes outside the Vault. Each Docker installation uses its own data volume. If the editions share a Vault, run writing tasks one edition at a time.')}</p>
<div class="install-grid">${manifest.editions.map(dockerInstructions).join('')}</div></section>
<section id="checksums" class="download-detail" data-sync-key="checksums"><h2>${t('校验文件','Verify your download')}</h2>
<p>${t('在下载目录计算文件的 SHA-256，与同版本、同文件名的记录逐字核对。','In the download folder, compute the SHA-256 and compare it with the entry for the same version and filename.')}</p>
<div class="install-grid">${manifest.editions.map(edition => `<article><h3>${edition.name} <small>v${edition.version}</small></h3>${releaseLinks(edition)}
${edition.assets.filter(file => file.sha256).map(file => `<details class="hash-entry"><summary>${escape(file.name)} <small>${Math.round(file.bytes/1048576)} MiB</small></summary><code>${file.sha256}</code>${snippet(t('计算 SHA-256','Compute SHA-256'),hashCommand(file))}</details>`).join('')}</article>`).join('')}</div>
</section>
</main><footer class="shell download-footer"><a href="${home}">← ${t('返回 Second Mind 首页','Back to Second Mind')}</a></footer>
</body></html>\n`;
}
