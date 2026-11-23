document.documentElement.classList.add('js');

const english = document.documentElement.lang === 'en';
const label = (zh, en) => english ? en : zh;
const motion = matchMedia('(prefers-reduced-motion: reduce)');

const menu = document.querySelector('.nav-toggle');
const links = document.querySelector('.nav-links');
function openMenu(open) {
  menu.setAttribute('aria-expanded', String(open));
  links.classList.toggle('open', open);
}
menu.addEventListener('click', () => openMenu(menu.getAttribute('aria-expanded') !== 'true'));
links.addEventListener('click', (event) => {
  if (event.target.closest('a')) openMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    openMenu(false);
    menu.focus();
  }
});

function onScreen(element, change) {
  if (!('IntersectionObserver' in window)) {
    change(true);
    return;
  }
  const observer = new IntersectionObserver(([entry]) => change(entry.isIntersecting));
  observer.observe(element);
}

function setupTabs(group) {
  const tabs = Array.from(group.querySelectorAll('[role="tab"]'));
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
  let current = 0;
  function select(index, focus = false) {
    current = index;
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    group.style.setProperty('--slide', index);
    if (focus) tabs[index].focus();
    group.dispatchEvent(new Event('tabchange'));
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i));
    tab.addEventListener('keydown', event => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select((next + tabs.length) % tabs.length, true);
    });
  });
  select(0);
  return {
    advance: () => select((current + 1) % tabs.length),
    first: () => select(0),
  };
}

const tabGroups = new Map();
for (const group of document.querySelectorAll('[data-tabs]')) {
  tabGroups.set(group, setupTabs(group));
}

function setupCarousel(stage) {
  const control = stage.querySelector('.stage-pause');
  const interval = 8000;
  let paused = motion.matches;
  let visible = false;
  let timer;
  stage.style.setProperty('--interval', interval + 'ms');
  function update() {
    clearTimeout(timer);
    stage.classList.remove('running');
    control.textContent = paused ? label('继续轮播', 'Resume slides') : label('暂停轮播', 'Pause slides');
    control.setAttribute('aria-pressed', String(paused));
    if (paused || !visible || document.hidden || stage.matches(':hover, :focus-within')) return;
    void stage.offsetWidth;
    stage.classList.add('running');
    timer = setTimeout(() => tabGroups.get(stage).advance(), interval);
  }
  control.addEventListener('click', () => { paused = !paused; update(); });
  stage.addEventListener('tabchange', () => {
    stage.querySelector('.stage-path').textContent = stage.querySelector('.stage-slide:not([hidden]) code').textContent;
    update();
  });
  stage.addEventListener('pointerenter', update);
  stage.addEventListener('pointerleave', update);
  stage.addEventListener('focusin', update);
  stage.addEventListener('focusout', () => queueMicrotask(update));
  document.addEventListener('visibilitychange', update);
  motion.addEventListener('change', () => { paused = motion.matches; update(); });
  onScreen(stage, seen => { visible = seen; update(); });
}

setupCarousel(document.querySelector('[data-carousel]'));

function setupSampleReplay(workspace) {
  const send = workspace.querySelector('[data-send]');
  const skip = workspace.querySelector('[data-skip]');
  const guide = workspace.querySelector('.ready-guide');
  const question = workspace.querySelector('.question-bubble');
  const log = workspace.querySelector('.sample-log');
  const logSummary = log.querySelector('summary');
  const rows = [...log.querySelectorAll('li')];
  const answer = workspace.querySelector('.recorded-answer');
  const paragraphs = [...answer.querySelectorAll('[data-answer-block]')];
  const snapshots = paragraphs.map(block => block.cloneNode(true));
  const files = workspace.querySelector('.source-links');
  const cover = workspace.querySelector('.source-cover');
  const passages = [...workspace.querySelectorAll('.passage')];
  const status = workspace.querySelector('[data-replay-status]');
  let timer;
  let userSelectedPassage = false;
  let userToggledLog = false;
  let activePassageId = null;

  function syncReferenceState() {
    const allLinks = [...answer.querySelectorAll('a[href^="#passage-"]')];
    allLinks.forEach(link => {
      const active = activePassageId !== null && link.hash === '#' + activePassageId;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  function selectPassage(passage, navigate, fromUser = false) {
    if (!passage) return;
    if (fromUser) userSelectedPassage = true;
    activePassageId = passage.id;
    cover.hidden = true;
    passages.forEach(item => { item.hidden = item !== passage; });
    syncReferenceState();
    const mark = passage.querySelector('mark');
    if (mark) {
      mark.classList.remove('sweep');
      void mark.offsetWidth;
      mark.classList.add('sweep');
    }
    if (navigate) {
      passage.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        if (passage.hidden) return;
        const compact = matchMedia('(max-width: 768px)').matches;
        const bounds = (mark || passage).getBoundingClientRect();
        if (compact || bounds.top < 72 || bounds.bottom > innerHeight) {
          const target = compact ? passage : (mark || passage);
          target.scrollIntoView({ behavior: motion.matches ? 'instant' : 'smooth', block: compact ? 'start' : 'nearest' });
        }
      });
    }
  }

  function restoreParagraphs() {
    paragraphs.forEach((block, i) => {
      block.classList.remove('is-streaming-block');
      block.replaceChildren(...snapshots[i].cloneNode(true).childNodes);
    });
    syncReferenceState();
  }

  function clearPlayback() {
    clearTimeout(timer);
    userSelectedPassage = false;
    userToggledLog = false;
    activePassageId = null;
    question.hidden = true;
    log.hidden = true;
    log.open = true;
    answer.hidden = true;
    files.hidden = true;
    cover.hidden = false;
    restoreParagraphs();
    [...rows, ...paragraphs, ...passages].forEach(item => { item.hidden = true; });
    rows.forEach(row => row.classList.remove('pending-call'));
  }

  function finish() {
    clearTimeout(timer);
    workspace.dataset.phase = 'done';
    if (document.activeElement === skip) send.focus({ preventScroll: true });
    skip.hidden = true;
    question.hidden = log.hidden = answer.hidden = files.hidden = false;
    restoreParagraphs();
    [...rows, ...paragraphs].forEach(item => { item.hidden = false; });
    rows.forEach(row => row.classList.remove('pending-call'));
    if (matchMedia('(max-width: 639px)').matches && !userToggledLog) {
      log.open = false;
    }
    if (!userSelectedPassage) selectPassage(passages[0], false, false);
    else syncReferenceState();
    status.textContent = label('回答完成，共 3 条来源可核对。', 'Answer complete. 3 sources are ready to inspect.');
  }

  function prepareStreamSteps(block, snapshot) {
    const clone = snapshot.cloneNode(true);
    const steps = [];
    function walk(node) {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const full = child.nodeValue;
          if (!full) continue;
          child.nodeValue = '';
          steps.push({ kind: 'text', node: child, full });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.matches('a.ref')) {
            child.hidden = true;
            steps.push({ kind: 'ref', node: child });
          } else {
            walk(child);
          }
        }
      }
    }
    walk(clone);
    block.replaceChildren(...clone.childNodes);
    return steps;
  }

  function streamAnswer(index) {
    answer.hidden = false;
    const block = paragraphs[index];
    const steps = prepareStreamSteps(block, snapshots[index]);
    block.hidden = false;
    block.classList.add('is-streaming-block');

    const totalChars = steps.reduce((sum, step) => sum + (step.kind === 'text' ? step.full.length : 1), 0);
    const targetMs = index === paragraphs.length - 1 ? 420 : 720;
    const tickMs = 26;
    const charsPerTick = Math.max(2, Math.ceil(totalChars / Math.max(1, Math.round(targetMs / tickMs))));
    let stepIndex = 0;
    let charOffset = 0;

    function tick() {
      let budget = charsPerTick;
      while (budget > 0 && stepIndex < steps.length) {
        const current = steps[stepIndex];
        if (current.kind === 'ref') {
          current.node.hidden = false;
          syncReferenceState();
          stepIndex += 1;
          budget -= 1;
        } else {
          const nextOffset = Math.min(current.full.length, charOffset + budget);
          current.node.nodeValue = current.full.slice(0, nextOffset);
          budget -= (nextOffset - charOffset);
          charOffset = nextOffset;
          if (charOffset >= current.full.length) {
            stepIndex += 1;
            charOffset = 0;
          }
        }
      }
      if (stepIndex < steps.length) {
        timer = setTimeout(tick, tickMs);
      } else {
        block.classList.remove('is-streaming-block');
        if (index + 1 === paragraphs.length) finish();
        else timer = setTimeout(() => streamAnswer(index + 1), 90);
      }
    }
    tick();
  }

  function streamCall(index) {
    log.hidden = false;
    const row = rows[index];
    row.hidden = false;
    row.classList.add('pending-call');
    timer = setTimeout(() => {
      row.classList.remove('pending-call');
      if (index + 1 === rows.length) {
        if (matchMedia('(max-width: 639px)').matches && !userToggledLog) {
          log.open = false;
        }
        streamAnswer(0);
      } else {
        streamCall(index + 1);
      }
    }, 400);
  }

  function play() {
    clearPlayback();
    workspace.dataset.phase = 'playing';
    guide.hidden = true;
    send.textContent = label('重播', 'Replay');
    question.hidden = false;
    if (motion.matches) {
      finish();
      return;
    }
    skip.hidden = false;
    status.textContent = label('正在检索并回放采样轨迹。', 'Searching notes and replaying the recorded trace.');
    timer = setTimeout(() => streamCall(0), 160);
  }

  clearPlayback();
  workspace.dataset.phase = 'ready';
  onScreen(workspace, seen => workspace.classList.toggle('in-view', seen));
  logSummary.addEventListener('click', () => { userToggledLog = true; });
  send.addEventListener('click', play);
  skip.addEventListener('click', finish);
  motion.addEventListener('change', () => {
    if (motion.matches && workspace.dataset.phase === 'playing') finish();
  });
  answer.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#passage-"]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    selectPassage(document.getElementById(link.hash.slice(1)), true, true);
  });
}
setupSampleReplay(document.querySelector('#qa-replay'));


function setupTrace(trace) {
  const rows = [...trace.querySelectorAll('.log-lines li')];
  const totals = [...trace.querySelectorAll('[data-total]')];
  let timer;
  function play() {
    clearTimeout(timer);
    trace.classList.add('is-streaming');
    rows.forEach(row => row.classList.add('waiting'));
    totals.forEach(el => { el.textContent = '0'; });
    function step(i) {
      rows[i].classList.remove('waiting');
      if (i === 0) totals[0].textContent = totals[0].dataset.total;
      if (i === rows.length - 1) {
        totals.forEach(el => { el.textContent = el.dataset.total; });
        trace.classList.remove('is-streaming');
      } else if (motion.matches) {
        step(i + 1);
      } else {
        timer = setTimeout(() => step(i + 1), 420);
      }
    }
    step(0);
  }
  trace.querySelector('[data-replay]').addEventListener('click', play);
}
setupTrace(document.querySelector('.trace'));

function setupDraft(draft) {
  const work = draft.querySelector('.draft-work');
  const editor = draft.querySelector('textarea');
  const preview = draft.querySelector('.draft-preview');
  const schedule = draft.querySelector('.check input');
  const receipt = draft.querySelector('.receipt');
  const steps = [...receipt.querySelectorAll('.receipt-stages li')];
  const confirm = draft.querySelector('[data-confirm]');
  const reset = draft.querySelector('[data-reset]');
  const status = draft.querySelector('[data-draft-status]');
  let timer;
  function refresh() {
    preview.replaceChildren();
    let list;
    for (const line of editor.value.split(/\r?\n/)) {
      const bullet = line.match(/^\s*[-*+]\s+(.+)/);
      if (bullet) {
        if (!list) {
          list = document.createElement('ul');
          preview.append(list);
        }
        const item = document.createElement('li');
        const task = bullet[1].match(/^\[([ xX])\]\s+(.*)/);
        if (task) {
          item.className = 'task-item';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = task[1].toLowerCase() === 'x';
          box.disabled = true;
          box.setAttribute('aria-label', task[2]);
          item.append(box, document.createTextNode(task[2]));
        } else {
          item.textContent = bullet[1];
        }
        list.append(item);
      } else {
        list = null;
        if (!line.trim()) continue;
        const heading = line.match(/^#{1,6}\s+(.+)/);
        const block = document.createElement(heading ? 'strong' : 'p');
        block.textContent = heading ? heading[1] : line;
        preview.append(block);
      }
    }
    confirm.disabled = !editor.value.trim();
  }
  refresh();
  editor.addEventListener('input', refresh);
  confirm.addEventListener('click', () => {
    const items = [...preview.querySelectorAll('li')].map(item => item.textContent);
    const synced = schedule.checked ? items : [];
    const taskList = receipt.querySelector('.saved-items');
    taskList.replaceChildren(...synced.map(text => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
    const empty = receipt.querySelector('.schedule-empty');
    empty.hidden = synced.length > 0;
    empty.textContent = schedule.checked
      ? label('没有可同步的事项', 'No tasks to add')
      : label('本次仅保存笔记', 'Note saved without scheduling tasks');
    const count = schedule.checked ? 4 : 3;
    steps[3].textContent = label('已同步 ' + synced.length + ' 条日程', synced.length + (synced.length === 1 ? ' task added' : ' tasks added') + ' to the schedule');
    work.hidden = true;
    receipt.hidden = false;
    steps.forEach(el => { el.hidden = true; });
    reset.focus({ preventScroll: true });
    function show(i) {
      steps[i].hidden = false;
      status.textContent = steps[i].textContent;
      if (i + 1 >= count) return;
      if (motion.matches) show(i + 1);
      else timer = setTimeout(() => show(i + 1), 320);
    }
    show(0);
  });
  reset.addEventListener('click', () => {
    clearTimeout(timer);
    editor.value = editor.defaultValue;
    schedule.checked = true;
    status.textContent = '';
    receipt.hidden = true;
    work.hidden = false;
    tabGroups.get(work).first();
    refresh();
    work.querySelector('[role="tab"]').focus();
  });
}
setupDraft(document.querySelector('.draft'));

const gallery = [...document.querySelectorAll('.gallery .shot')];
const filters = [...document.querySelectorAll('[data-filter]')];
for (const filter of filters) {
  filter.addEventListener('click', () => {
    filters.forEach(item => item.setAttribute('aria-pressed', String(item === filter)));
    gallery.forEach(shot => { shot.hidden = filter.dataset.filter !== 'all' && shot.dataset.category !== filter.dataset.filter; });
  });
}

function setupViewer(viewer) {
  if (typeof viewer.showModal !== 'function') return;
  let items = [];
  let position = 0;
  let trigger;
  function draw() {
    const shot = items[position];
    const image = shot.querySelector('img').cloneNode();
    image.loading = 'eager';
    viewer.querySelector('[data-original]').href = image.src;
    viewer.querySelector('.viewer-image').replaceChildren(image);
    viewer.querySelector('#viewer-title').textContent = shot.querySelector('strong').textContent;
    viewer.querySelector('#viewer-copy').textContent = shot.querySelector('figcaption span').textContent;
    viewer.querySelector('[data-position]').textContent = (position + 1) + ' / ' + items.length;
  }
  function move(by) {
    position = (position + by + items.length) % items.length;
    draw();
  }
  document.addEventListener('click', event => {
    const opener = event.target.closest('a[data-zoom]');
    if (!opener || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    items = opener.closest('.gallery') ? gallery.filter(shot => !shot.hidden) : gallery;
    position = items.findIndex(shot => shot.querySelector('a').dataset.zoom === opener.dataset.zoom);
    if (position < 0) return;
    event.preventDefault();
    trigger = opener;
    draw();
    viewer.showModal();
    viewer.querySelector('[data-close]').focus();
  });
  viewer.querySelector('[data-close]').addEventListener('click', () => viewer.close());
  viewer.addEventListener('close', () => trigger?.focus({ preventScroll: true }));
  viewer.querySelector('[data-prev]').addEventListener('click', () => move(-1));
  viewer.querySelector('[data-next]').addEventListener('click', () => move(1));
  viewer.addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft'].includes(event.key)) return;
    event.preventDefault();
    move(event.key === 'ArrowRight' ? 1 : -1);
  });
}
setupViewer(document.querySelector('#viewer'));

function setupVideo(video) {
  let visible = false;
  const chapter = video.closest('[role="tabpanel"]');
  const badge = document.getElementById(chapter.getAttribute('aria-labelledby')).querySelector('small');
  function showDuration() {
    const seconds = Math.round(video.duration);
    badge.textContent = Number.isFinite(seconds) && seconds > 0
      ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
      : label('实机录屏', 'Recording');
  }
  showDuration();
  video.addEventListener('durationchange', showDuration);
  let userPaused = false;
  let active = false;
  function sync() {
    const next = visible && !video.closest('[role="tabpanel"]').hidden && !document.hidden;
    if (next === active) return;
    active = next;
    if (!active) video.pause();
    else if (!motion.matches && !userPaused) video.play().catch(() => {});
  }
  video.addEventListener('pause', () => { if (active && !video.ended) userPaused = true; });
  video.addEventListener('play', () => { userPaused = false; });
  document.addEventListener('visibilitychange', sync);
  motion.addEventListener('change', () => { if (motion.matches) video.pause(); });
  video.closest('[data-tabs]').addEventListener('tabchange', sync);
  onScreen(video, seen => { visible = seen; sync(); });
}
document.querySelectorAll('video').forEach(setupVideo);

function copySelection(value, button) {
  const field = document.createElement('textarea');
  field.value = value;
  field.readOnly = true;
  field.className = 'sr-only';
  document.body.append(field);
  try {
    field.select();
    return document.execCommand('copy');
  } finally {
    field.remove();
    button.focus({ preventScroll: true });
  }
}
for (const button of document.querySelectorAll('.copy')) {
  const initial = button.textContent;
  let timer;
  button.addEventListener('click', async () => {
    const value = button.closest('[role="tabpanel"]').querySelector('code').textContent;
    let copied = false;
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch {
      try { copied = copySelection(value, button); } catch { /* The code remains selectable. */ }
    }
    button.textContent = copied ? label('已复制 ✓', 'Copied ✓') : label('请手动复制', 'Select and copy');
    button.classList.toggle('success', copied);
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.textContent = initial;
      button.classList.remove('success');
    }, 2000);
  });
}

if ('IntersectionObserver' in window && !motion.matches) {
  const reveal = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('revealed');
      reveal.unobserve(entry.target);
    }
  }, { threshold: 0.05, rootMargin: '0px 0px -30px 0px' });
  document.querySelectorAll('.section > h2, .trust dl > div, .closing-card').forEach(element => {
    if (element.getBoundingClientRect().top > window.innerHeight) reveal.observe(element);
  });
}
