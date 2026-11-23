document.documentElement.classList.add('js');

const en = document.documentElement.lang === 'en';
const label = (zh, english) => en ? english : zh;
const motion = matchMedia('(prefers-reduced-motion: reduce)');

const menu = document.querySelector('.nav-toggle');
const menuLinks = document.getElementById('nav-links');
function toggleMenu(open) {
  menu.setAttribute('aria-expanded', String(open));
  menuLinks.classList.toggle('open', open);
}
menu.addEventListener('click', () => toggleMenu(menu.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('click', event => {
  if (!event.target.closest('.nav') || event.target.closest('.nav a')) toggleMenu(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    toggleMenu(false);
    menu.focus();
  }
});

function selectTab(tab) {
  for (const sibling of tab.parentElement.querySelectorAll('[role="tab"]')) {
    const selected = tab === sibling;
    sibling.setAttribute('aria-selected', String(selected));
    sibling.tabIndex = selected ? 0 : -1;
    document.getElementById(sibling.getAttribute('aria-controls')).hidden = !selected;
  }
}
for (const group of document.querySelectorAll('[role="tablist"]')) {
  const tabs = [...group.children];
  selectTab(tabs[0]);
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const selected = tabs[(next + tabs.length) % tabs.length];
      selectTab(selected);
      selected.focus();
    });
  });
}

const citations = [...document.querySelectorAll('.cite')];
const reader = document.querySelector('.source-scroll');
function showCitation(link, follow = false) {
  const target = document.getElementById(link.hash.slice(1));
  for (const citation of citations) {
    const active = citation === link;
    if (active) citation.setAttribute('aria-current', 'location');
    else citation.removeAttribute('aria-current');
    document.getElementById(citation.hash.slice(1)).classList.toggle('active', active);
  }
  document.querySelector('.source-head [data-line]').textContent = 'L' + target.dataset.line;
  const top = reader.scrollTop + target.getBoundingClientRect().top - reader.getBoundingClientRect().top;
  reader.scrollTo({ top, behavior: motion.matches ? 'instant' : 'smooth' });
  if (follow && matchMedia('(max-width: 768px)').matches) {
    reader.closest('.source').scrollIntoView({ block: 'nearest', behavior: motion.matches ? 'instant' : 'smooth' });
  }
}
for (const citation of citations) {
  citation.addEventListener('pointerenter', event => {
    if (event.pointerType === 'mouse') showCitation(citation);
  });
  citation.addEventListener('focus', () => showCitation(citation));
  citation.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    showCitation(citation, true);
  });
}
function restoreFragment() {
  const target = document.getElementById(location.hash.slice(1));
  if (!target) return;
  const panels = [];
  for (let element = target; element; element = element.parentElement) {
    if (element.getAttribute('role') === 'tabpanel') panels.push(element);
  }
  for (const panel of panels.reverse()) selectTab(document.getElementById(panel.getAttribute('aria-labelledby')));
  const citation = citations.find(link => link.hash === location.hash);
  if (citation) showCitation(citation, true);
  else if (panels.length) target.scrollIntoView({ block: 'nearest' });
}
showCitation(citations[0]);
restoreFragment();
window.addEventListener('hashchange', restoreFragment);

function setupDraft() {
  const editor = document.getElementById('editor');
  const preview = document.querySelector('[data-preview]');
  const schedule = document.querySelector('[data-schedule]');
  const confirm = document.querySelector('[data-confirm]');
  const reset = document.querySelector('[data-reset]');
  const receipt = document.querySelector('.receipt');
  const result = receipt.querySelector('[data-result]');
  const status = document.querySelector('[data-draft-status]');
  const markdown = new marked.Marked({ renderer: {
    html() { return ''; },
    image(token) { return this.parser.parseInline(token.tokens); },
    heading(token) { return '<h4>' + this.parser.parseInline(token.tokens) + '</h4>'; },
  } });
  let taskLines = [];

  // Lex a numbered copy to associate rendered task boxes with the editable source.
  // The parser distinguishes actual list items from lookalikes in code blocks.
  const taskPrefix = /^((?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[)[ xX](\]\s+)/;
  function render() {
    const numbered = editor.value.split('\n').map((line, index) =>
      line.replace(taskPrefix, prefix => prefix + index + ' ')).join('\n');
    taskLines = [];
    marked.walkTokens(markdown.lexer(numbered), token => {
      if (token.type === 'list_item' && token.task) taskLines.push(Number.parseInt(token.text, 10));
    });
    preview.replaceChildren(DOMPurify.sanitize(markdown.parse(editor.value), {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ['p', 'h4', 'ul', 'ol', 'li', 'input', 'em', 'strong', 'del', 'pre', 'code',
        'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
      ALLOWED_ATTR: ['href', 'type', 'checked', 'disabled', 'start'],
    }));
    for (const [index, box] of [...preview.querySelectorAll('input')].entries()) {
      box.disabled = !Number.isInteger(taskLines[index]);
      box.dataset.index = String(index);
      const taskLabel = document.createElement('label');
      box.before(taskLabel);
      // A nested list has its own tasks and labels.
      let sibling = taskLabel.nextSibling;
      while (sibling && !(sibling instanceof Element && sibling.matches('ul, ol'))) {
        taskLabel.append(sibling);
        sibling = taskLabel.nextSibling;
      }
      box.setAttribute('aria-label', taskLabel.textContent.trim());
    }
    confirm.disabled = !editor.value.trim();
  }
  function hideReceipt() {
    receipt.hidden = true;
    status.textContent = '';
  }
  function update() {
    hideReceipt();
    render();
  }
  preview.addEventListener('change', event => {
    const box = event.target.closest('input[type="checkbox"]');
    if (!box) return;
    const lines = editor.value.split('\n');
    const number = taskLines[Number(box.dataset.index)];
    lines[number] = lines[number].replace(taskPrefix, (_, before, after) => before + (box.checked ? 'x' : ' ') + after);
    editor.value = lines.join('\n');
    hideReceipt();
  });
  editor.addEventListener('input', update);
  schedule.addEventListener('change', hideReceipt);
  confirm.addEventListener('click', () => {
    const entries = schedule.checked
      ? [...preview.querySelectorAll('input:checked')].map(box => box.getAttribute('aria-label'))
      : [];
    const message = entries.length
      ? label('加入每日安排 · ', 'Added to the daily schedule · ') + entries.join(label('、', ', '))
      : label('仅保存计划正文。', 'Saved the plan text only.');
    result.textContent = message;
    receipt.hidden = false;
    status.textContent = label('示例已保存。', 'Preview saved. ') + message;
    reset.focus({ preventScroll: true });
  });
  reset.addEventListener('click', () => {
    editor.value = editor.defaultValue;
    schedule.checked = true;
    update();
    const tab = document.getElementById('draft-preview-tab');
    selectTab(tab);
    tab.focus({ preventScroll: true });
  });
  render();
}
setupDraft();

const viewer = document.getElementById('viewer');
if (typeof viewer.showModal === 'function') {
  const shots = [...new Map([...document.querySelectorAll('[data-zoom]')].map(shot => [shot.dataset.zoom, shot])).values()];
  let index = 0;
  let opener;
  function draw() {
    const shot = shots[index];
    const image = new Image();
    image.src = shot.href;
    image.alt = shot.dataset.title;
    viewer.querySelector('.viewer-image').replaceChildren(image);
    viewer.querySelector('#viewer-title').textContent = image.alt;
    viewer.querySelector('.original').href = image.src;
    viewer.querySelector('[data-position]').textContent = (index + 1) + ' / ' + shots.length;
  }
  function move(step) {
    index = (index + step + shots.length) % shots.length;
    draw();
  }
  document.addEventListener('click', event => {
    const shot = event.target.closest('[data-zoom]');
    if (!shot || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    opener = shot;
    index = shots.findIndex(entry => entry.dataset.zoom === shot.dataset.zoom);
    draw();
    viewer.showModal();
    viewer.querySelector('[data-close]').focus();
  });
  viewer.querySelector('[data-prev]').addEventListener('click', () => move(-1));
  viewer.querySelector('[data-next]').addEventListener('click', () => move(1));
  viewer.querySelector('[data-close]').addEventListener('click', () => viewer.close());
  viewer.addEventListener('close', () => opener?.focus({ preventScroll: true }));
  viewer.addEventListener('click', event => {
    if (event.target !== viewer) return;
    const bounds = viewer.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) viewer.close();
  });
  viewer.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    move(event.key === 'ArrowLeft' ? -1 : 1);
  });
}

for (const button of document.querySelectorAll('.copy')) {
  const original = button.textContent;
  let timer;
  button.addEventListener('click', async () => {
    const code = button.closest('.terminal').querySelector('code');
    let copied = false;
    try {
      await navigator.clipboard.writeText(code.textContent);
      copied = true;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      try { copied = document.execCommand('copy'); } catch { /* Keep the command selected. */ }
    }
    button.textContent = copied ? label('已复制', 'Copied') : label('请手动复制', 'Select and copy');
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = original; }, 2000);
  });
}
