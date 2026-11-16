// Dashboard overview: lists the apps and runs "checks" on each app's private data
// (read from GitHub through shared/aib-store.js) to raise urgent notifications.
(function () {
  const DISMISS_KEY = 'dismissedNotifications';
  const order = { urgent: 0, warning: 1, info: 2 };
  const DAY = 864e5;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const todayStr = () => isoDay(new Date());
  const daysUntil = (dayStr) => {
    const [y, m, d] = String(dayStr).split('-').map(Number);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((new Date(y, m - 1, d) - t) / DAY);
  };
  const inDays = (n) => (n < 0 ? `${-n} day${n === -1 ? '' : 's'} overdue` : n === 0 ? 'due today' : n === 1 ? 'due tomorrow' : `due in ${n} days`);
  const docs = (data, c) => Object.entries((data && data.collections && data.collections[c]) || {}).map(([id, v]) => ({ id, ...v }));

  function getDismissed() { try { return JSON.parse(localStorage.getItem(DISMISS_KEY)) || []; } catch { return []; } }
  function dismiss(id) { try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...getDismissed(), id])); } catch {} }

  // ---------- checks: one function per app, returning { metric, notes[] } ----------
  const CHECKS = {
    // Mirrors the Goals app's own "Needs attention" rules: an active goal is open unless it is a
    // finished one-time task; open goals past their target date are late, within 3 days are due soon,
    // and weekly goals behind this week's pace (week starts Sunday) are flagged too.
    goals(data) {
      const t = new Date(); t.setHours(0, 0, 0, 0);
      const sunday = isoDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - t.getDay()));
      const daysSoFar = t.getDay() + 1;
      const thisWeek = {};
      for (const c of docs(data, 'checkins')) if (c.day >= sunday && c.day <= todayStr()) thisWeek[c.goalId] = (thisWeek[c.goalId] || 0) + (+c.amount || 0);
      const active = docs(data, 'goals').filter((g) => (g.status || 'Active') === 'Active');
      const open = active.filter((g) => !(g.kind === 'once' && g.doneDay));
      const notes = [];
      for (const g of open) {
        const n = g.targetDate ? daysUntil(g.targetDate) : null;
        if (n !== null && n < 0) notes.push({ level: 'urgent', text: `${g.name}: ${inDays(n)}`, date: g.targetDate });
        else if (n !== null && n <= 3) notes.push({ level: n <= 1 ? 'urgent' : 'warning', text: `${g.name}: ${inDays(n)}`, date: g.targetDate });
        else if (g.kind !== 'once' && g.target > 0) {
          const done = thisWeek[g.id] || 0;
          if (done < g.target && done < Math.floor((g.target * (daysSoFar - 1)) / 7)) notes.push({ level: 'warning', text: `${g.name}: behind this week (${done}/${g.target}${g.unit ? ' ' + g.unit : ''})`, date: '' });
        }
      }
      return { metric: { value: open.length, label: open.length === 1 ? 'open goal' : 'open goals' }, notes };
    },
    writing(data) {
      const notes = [];
      const drafts = docs(data, 'data/users/me').filter((d) => !d.closed && !d.arch);
      const now = Date.now();
      for (const d of drafts) {
        if (!d.deadline) continue;
        const hrs = (d.deadline - now) / 36e5;
        const name = d.title || (d.prompt && d.prompt.title) || 'Untitled draft';
        const when = new Date(d.deadline);
        const date = isoDay(when);
        if (hrs < 0) notes.push({ level: 'urgent', text: `${name}: deadline passed`, date });
        else if (hrs <= 24) notes.push({ level: 'urgent', text: `${name}: ${Math.max(1, Math.round(hrs))} h left`, date });
        else if (hrs <= 72) notes.push({ level: 'warning', text: `${name}: deadline ${when.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })}`, date });
      }
      return { metric: { value: drafts.length, label: drafts.length === 1 ? 'open draft' : 'open drafts' }, notes };
    },
  };

  // ---------- render ----------
  let SITE = null;
  const RESULTS = {};          // app id -> { metric, notes } | { error }
  let lastSync = undefined;    // undefined = not loaded, null = never, Date otherwise
  let checkedAt = null;
  const fmtTime = (d) => d.toLocaleString('en', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const titleOf = (id) => (SITE.pages.find((p) => p.id === id) || {}).title || id;
  const urlOf = (id) => (SITE.pages.find((p) => p.id === id) || {}).url || '';
  const connected = () => window.AIB && AIB.hasToken();

  function allNotes() {
    const dismissed = getDismissed();
    const list = [...(SITE.notifications || [])];
    for (const p of SITE.pages) {
      const r = RESULTS[p.id];
      if (r && r.notes) r.notes.forEach((n) => list.push({ ...n, page: p.id, id: p.id + '|' + n.text + '|' + todayStr() }));
    }
    return list.filter((n) => !dismissed.includes(n.id))
      .sort((a, b) => order[a.level] - order[b.level] || String(a.date).localeCompare(String(b.date)));
  }

  function renderBar(notes) {
    const urgentFor = (id) => notes.filter((n) => n.page === id && n.level === 'urgent').length;
    const tabs = [{ id: 'home', title: 'Overview', url: './' }, ...SITE.pages.map((p) => ({ ...p, url: './' + p.url })), { id: 'security', title: 'Security', url: './security.html' }];
    $('nav').innerHTML = tabs.map((p) => {
      const c = SITE.pages.some((x) => x.id === p.id) ? urgentFor(p.id) : 0;
      return `<a href="${esc(p.url)}"${p.id === 'home' ? ' aria-current="page"' : ''}>${esc(p.title)}${c ? `<span class="count" aria-label="${c} urgent">${c}</span>` : ''}</a>`;
    }).join('');
    const conn = $('conn');
    conn.dataset.state = connected() ? 'on' : 'off';
    conn.querySelector('.label').textContent = connected() ? 'Private data connected' : 'Not connected';
  }

  function renderConnect() {
    const box = $('connect-box');
    box.hidden = connected();
    if (connected()) return;
    box.innerHTML = `<div class="notice info"><div class="grow"><b>Connect your private data</b>
      <p class="muted">The checks below need read access to your private repository. You'll paste a GitHub token once; it stays in this browser.</p></div>
      <button type="button" class="btn primary" id="connect">Connect</button></div>`;
    $('connect').onclick = () => AIB.connect().then(runChecks);
  }

  function renderStats(notes) {
    const el = $('stats');
    if (!connected()) { el.innerHTML = ''; return; }
    const loaded = Object.keys(RESULTS).length > 0;
    const u = notes.filter((n) => n.level === 'urgent').length;
    const w = notes.filter((n) => n.level === 'warning').length;
    const v = (x) => (loaded ? x : '—');
    let syncValue = '—', syncSub = 'Checking…', syncCls = '';
    if (lastSync === null) { syncValue = 'Never'; syncSub = 'No push from claude.ai yet'; syncCls = 'is-warn'; }
    else if (lastSync) {
      const hrs = (Date.now() - lastSync) / 36e5;
      syncValue = hrs < 1 ? 'Just now' : hrs < 24 ? `${Math.round(hrs)} h ago` : `${Math.round(hrs / 24)} d ago`;
      syncSub = fmtTime(lastSync); syncCls = hrs > 30 ? 'is-warn' : 'is-ok';
    }
    el.innerHTML = `
      <div class="stat ${u ? 'is-urgent' : ''}"><span class="label">Urgent</span><span class="value">${v(u)}</span><span class="sub">Overdue or due within a day</span></div>
      <div class="stat ${w ? 'is-warn' : ''}"><span class="label">Due soon</span><span class="value">${v(w)}</span><span class="sub">Next few days</span></div>
      <div class="stat ${syncCls}"><span class="label">Last claude.ai push</span><span class="value">${esc(syncValue)}</span><span class="sub">${esc(syncSub)}</span></div>`;
  }

  function renderAlerts(notes) {
    const el = $('alerts');
    $('att-count').textContent = connected() && Object.keys(RESULTS).length ? `${notes.length} item${notes.length === 1 ? '' : 's'}` : '';
    if (!connected()) { el.innerHTML = '<p class="empty">Connect your private data to see what needs attention.</p>'; return; }
    if (!Object.keys(RESULTS).length) { el.innerHTML = '<p class="empty">Checking your apps…</p>'; return; }
    if (!notes.length) { el.innerHTML = '<p class="empty"><b>All clear.</b> Nothing is overdue or due in the next few days.</p>'; return; }
    const label = { urgent: 'Urgent', warning: 'Due soon', info: 'Info' };
    el.innerHTML = notes.map((n) => `
      <div class="item ${n.level}">
        <span class="sev">${label[n.level] || esc(n.level)}</span>
        <div><div class="what">${esc(n.text)}</div><div class="meta">${esc(titleOf(n.page))}${n.date ? ' · ' + esc(n.date) : ''}</div></div>
        <a class="open" href="./${esc(urlOf(n.page))}">Open<span class="visually-hidden"> ${esc(titleOf(n.page))}</span></a>
        <button type="button" class="icon-btn" aria-label="Dismiss: ${esc(n.text)}" title="Dismiss for today" data-id="${esc(n.id)}">×</button>
      </div>`).join('');
    el.querySelectorAll('button[data-id]').forEach((b) => b.addEventListener('click', () => { dismiss(b.dataset.id); renderAll(); }));
  }

  function renderCards(notes) {
    $('page-cards').innerHTML = SITE.pages.map((p) => {
      const r = RESULTS[p.id];
      const urgent = notes.filter((n) => n.page === p.id && n.level === 'urgent').length;
      const metric = r && r.metric ? `<div class="metric"><b>${esc(r.metric.value)}</b><span>${esc(r.metric.label)}</span></div>`
        : r && r.error ? `<div class="metric"><span>Couldn't check: ${esc(r.error)}</span></div>`
        : `<div class="metric"><span>${connected() ? 'Checking…' : 'Connect to see status'}</span></div>`;
      return `<a class="app" href="./${esc(p.url)}">
        <div class="app-top"><span class="app-icon" aria-hidden="true">${esc(p.initial || p.title[0])}</span><h3>${esc(p.title)}</h3>${urgent ? `<span class="count" aria-label="${urgent} urgent">${urgent}</span>` : ''}</div>
        ${metric}
        <p>${esc(p.summary)}</p>
        <span class="go">Open ${esc(p.title)} →</span></a>`;
    }).join('');
  }

  function renderAll() {
    const notes = allNotes();
    renderBar(notes); renderConnect(); renderStats(notes); renderAlerts(notes); renderCards(notes);
    $('refresh').hidden = !connected();
    $('checked').textContent = checkedAt ? `Checked ${fmtTime(checkedAt)}. What needs your attention across your apps.` : 'What needs your attention across your apps.';
  }

  async function runChecks() {
    $('refresh').disabled = true;
    renderAll();
    const tasks = SITE.pages.map(async (p) => {
      try { RESULTS[p.id] = CHECKS[p.id] ? CHECKS[p.id](await AIB.readApp(p.id)) : { notes: [] }; }
      catch (e) { RESULTS[p.id] = { error: (e && e.message) || 'unknown error', notes: [] }; }
    });
    tasks.push(AIB.commits(30).then((list) => {
      const c = list.find((x) => /^sync from claude\.ai/.test(x.commit.message || ''));
      lastSync = c ? new Date(c.commit.author.date) : null;
    }).catch(() => { lastSync = undefined; }));
    await Promise.all(tasks);
    checkedAt = new Date();
    $('refresh').disabled = false;
    renderAll();
  }

  $('refresh').addEventListener('click', runChecks);
  fetch('./data/site.json', { cache: 'no-store' })
    .then((r) => r.json())
    .then((site) => {
      SITE = site;
      renderAll();
      if (connected()) runChecks();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && connected()) runChecks(); });
    })
    .catch(() => {
      $('alerts').innerHTML = '<p class="empty">Could not load the app list. Reload the page to try again.</p>';
    });
})();
