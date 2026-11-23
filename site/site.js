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

function setupTrace(trace) {
  const rows = [...trace.querySelectorAll('.log-lines li')];
  const totals = [...trace.querySelectorAll('[data-total]')];
  let timer;
  let started = false;
  function play() {
    started = true;
    clearTimeout(timer);
    trace.classList.add('is-streaming');
    rows.forEach(row => row.classList.add('waiting'));
    totals.forEach(el => { el.textContent = '·'; });
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
  onScreen(trace, visible => { if (visible && !started) play(); });
}
setupTrace(document.querySelector('.trace'));

function setupDraft(draft) {
  const work = draft.querySelector('.draft-work');
  const editor = draft.querySelector('textarea');
  const preview = draft.querySelector('.draft-preview');
  const schedule = draft.querySelector('input');
  const receipt = draft.querySelector('.receipt');
  const steps = [...receipt.querySelectorAll('li')];
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
        item.textContent = bullet[1];
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
  editor.addEventListener('input', refresh);
  confirm.addEventListener('click', () => {
    const tasks = editor.value.split(/\r?\n/).filter(line => /^\s*[-*+]\s+\S/.test(line)).length;
    const count = schedule.checked ? 4 : 3;
    steps[3].textContent = label('已同步 ' + tasks + ' 条日程', tasks + (tasks === 1 ? ' task added' : ' tasks added') + ' to the schedule');
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
  });
  document.querySelectorAll('.section > h2, .trust dl > div, .closing-card').forEach((element, index) => {
    element.style.setProperty('--delay', (index % 3) * 45 + 'ms');
    reveal.observe(element);
  });
}
