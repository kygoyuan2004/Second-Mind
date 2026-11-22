const url = new URL(location.href);
const kb = url.searchParams.get('knowledgeBaseId') || 'default';
const dateInput = document.querySelector('#date');
const status = document.querySelector('#status');
const events = document.querySelector('#events');
const operations = document.querySelector('#operations');
document.querySelector('#back').href = '/knowledge.html?knowledgeBaseId=' + encodeURIComponent(kb);
const local = new Date();
dateInput.value = url.searchParams.get('date') || new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

async function call(route, body) {
  const response = await fetch('/api/knowledge/schedule/' + route + '?knowledgeBaseId=' + encodeURIComponent(kb), {
    method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json', 'x-vaultmind-request': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '请返回知识库登录后重试。');
  return result;
}
let revision = 0;
async function load() {
  const request = ++revision;
  try {
    const data = await call('state');
    if (request !== revision) return;
    events.replaceChildren();
    operations.replaceChildren();
    const selected = data.events.filter((event) => event.date === dateInput.value)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    status.textContent = selected.length ? '共 ' + selected.length + ' 项' : '当天还没有安排。';
    for (const op of data.operations.filter((op) => op.date === dateInput.value)) {
      const button = document.createElement('button');
      button.textContent = op.status === 'failed' ? op.message : '重试待同步的计划';
      button.disabled = op.status === 'failed';
      button.onclick = async () => {
        button.disabled = true;
        try { await call('operations/' + encodeURIComponent(op.id) + '/retry', {}); await load(); }
        catch (error) { status.textContent = error.message; button.disabled = false; }
      };
      operations.append(button);
    }
    for (const event of selected) {
      const form = document.querySelector('#entry').content.cloneNode(true).querySelector('form');
      const { title, startTime, minutes, done } = form.elements;
      title.value = event.title; startTime.value = event.startTime; minutes.value = event.minutes ?? ''; done.checked = event.done;
      form.onsubmit = async (e) => {
        e.preventDefault();
        const button = form.querySelector('button'); button.disabled = true;
        try {
          const updated = await call('events', { expectedRevision: event.revision, event: { ...event,
            title: title.value, startTime: startTime.value, minutes: minutes.value ? Number(minutes.value) : null, done: done.checked } });
          Object.assign(event, updated.events.find((item) => item.id === event.id));
          form.querySelector('p').textContent = '已保存';
        } catch (error) { form.querySelector('p').textContent = error.message; }
        finally { button.disabled = false; }
      };
      events.append(form);
    }
  } catch (error) { if (request === revision) status.textContent = error.message; }
}
dateInput.onchange = () => { url.searchParams.set('date', dateInput.value); history.replaceState(null, '', url); load(); };
load();
