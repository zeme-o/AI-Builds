/*
 * AI-Builds storage + Claude hand-off layer.
 *
 * Gives the apps the same `window.claude.use(...)` interface they had on claude.ai:
 *   - "db"        -> documents saved as one JSON file per app in a PRIVATE GitHub repo
 *   - "user"      -> a single local user ("me")
 *   - "downloads" -> normal browser downloads
 *   - "sample"    -> hands the request to Claude (claude.ai) and takes the reply back
 *
 * The GitHub token lives only in this browser (localStorage). It is never sent anywhere
 * except api.github.com.
 *
 * Usage: <script src=".../aib-store.js" data-app="goals"></script>
 */
(function () {
  'use strict';
  const CFG = Object.assign({ owner: 'zeme-o', repo: 'ai-builds-data', branch: 'main', dir: 'apps' }, window.AIB_CONFIG || {});
  const script = document.currentScript;
  const APP = script && script.dataset.app;
  const TOKEN_KEY = 'aib.githubToken';
  const EXPIRY_KEY = 'aib.tokenExpires';
  const API = 'https://api.github.com';

  // ---------- small utils ----------
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const later = (fn) => setTimeout(fn, 0);
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const store = (kind) => { try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch { return null; } };
  // A token is kept for this browser tab session only, unless "Remember on this device" was ticked.
  const getToken = () => { try { return (store('session') && store('session').getItem(TOKEN_KEY)) || (store('local') && store('local').getItem(TOKEN_KEY)) || ''; } catch { return ''; } };
  const isRemembered = () => { try { return !!(store('local') && store('local').getItem(TOKEN_KEY)); } catch { return false; } };
  const setToken = (t, remember) => {
    try {
      for (const k of ['local', 'session']) { const s = store(k); if (s) s.removeItem(TOKEN_KEY); }
      if (t) { const s = store(remember ? 'local' : 'session'); if (s) s.setItem(TOKEN_KEY, t); }
      else { const s = store('local'); if (s) s.removeItem(EXPIRY_KEY); }
    } catch {}
  };
  const getExpiry = () => { try { return (store('local') && store('local').getItem(EXPIRY_KEY)) || ''; } catch { return ''; } };
  const setExpiry = (d) => { try { const s = store('local'); if (s) d ? s.setItem(EXPIRY_KEY, d) : s.removeItem(EXPIRY_KEY); } catch {} };
  const daysLeft = (iso) => { if (!iso) return null; const t = new Date(iso + 'T23:59:59'); return isNaN(t) ? null : Math.ceil((t - Date.now()) / 864e5); };
  const tokenProblem = (t) => {
    if (/^(ghp|gho|ghu|ghs|ghr)_/.test(t)) return 'This is a classic token, which can reach all your repositories. Use a fine-grained token (it starts with github_pat_) limited to the data repository.';
    if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(t)) return 'That does not look like a fine-grained GitHub token. It should start with github_pat_.';
    return '';
  };
  const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  const textToB64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  function el(tag, attrs, html) {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
    if (html != null) e.innerHTML = html;
    return e;
  }
  const onReady = (fn) => (document.body ? fn() : document.addEventListener('DOMContentLoaded', fn));

  // ---------- GitHub contents API ----------
  const GH = {
    headers(extra) {
      return Object.assign({ Authorization: 'Bearer ' + getToken(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, extra || {});
    },
    path(app) { return `${API}/repos/${CFG.owner}/${CFG.repo}/contents/${CFG.dir}/${app}.json`; },
    async checkRepo() {
      const r = await fetch(`${API}/repos/${CFG.owner}/${CFG.repo}`, { headers: this.headers(), cache: 'no-store' });
      if (r.status === 401) throw { code: 'bad_token', message: 'GitHub rejected this token. Check it was copied in full and has not expired.' };
      if (r.status === 404 || r.status === 403) throw { code: 'no_repo', message: `This token can't see ${CFG.owner}/${CFG.repo}. Give it access to that repository.` };
      if (!r.ok) throw { code: 'unavailable', message: 'GitHub did not respond (' + r.status + ').' };
      const j = await r.json();
      if (j.private !== true) throw { code: 'public_repo', message: `${CFG.owner}/${CFG.repo} is public, so anyone could read your data. Make it private in the repository's Settings, then connect again.` };
      if (j.permissions && !j.permissions.push) throw { code: 'read_only', message: 'This token can read but not save. Set "Contents" to "Read and write".' };
      return j;
    },
    async commits(n) {
      const r = await fetch(`${API}/repos/${CFG.owner}/${CFG.repo}/commits?per_page=${n || 40}`, { headers: this.headers(), cache: 'no-store' });
      if (!r.ok) throw { code: 'unavailable', message: 'Could not read the commit history (' + r.status + ').' };
      return r.json();
    },
    async me() {
      const r = await fetch(`${API}/user`, { headers: this.headers(), cache: 'no-store' });
      return r.ok ? r.json() : null;
    },
    async read(app) {
      const r = await fetch(this.path(app) + '?ref=' + encodeURIComponent(CFG.branch), { headers: this.headers(), cache: 'no-store' });
      if (r.status === 404) return { data: { format: 1, collections: {} }, sha: null, missing: true };
      if (r.status === 401) throw { code: 'bad_token', message: 'GitHub rejected the saved token.' };
      if (!r.ok) throw { code: 'unavailable', message: 'Could not read your data from GitHub (' + r.status + ').' };
      const j = await r.json();
      let text = j.content ? b64ToText(j.content) : '';
      if (!text && j.size > 0) { // files over 1 MB come back without content
        const raw = await fetch(this.path(app) + '?ref=' + encodeURIComponent(CFG.branch), { headers: this.headers({ Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' });
        text = await raw.text();
      }
      const data = text ? JSON.parse(text) : { format: 1, collections: {} };
      if (!data.collections) data.collections = {};
      return { data, sha: j.sha };
    },
    async write(app, data, sha, message) {
      const body = { message, content: textToB64(JSON.stringify(data, null, 1)), branch: CFG.branch };
      if (sha) body.sha = sha;
      const r = await fetch(this.path(app), { method: 'PUT', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
      if (r.status === 409 || r.status === 422) return { conflict: true };
      if (!r.ok) throw { code: r.status === 401 ? 'bad_token' : 'unavailable', message: 'Saving to GitHub failed (' + r.status + ').' };
      const j = await r.json();
      return { sha: j.content.sha };
    },
  };

  // ---------- in-memory document store with GitHub sync ----------
  function createStore(app) {
    let state = { format: 1, collections: {} };
    let sha = null;
    let pending = [];          // ops not yet confirmed by GitHub
    let flushing = false, timer = null, firstPendingAt = 0, retryMs = 4000;
    const listeners = new Set();
    const statusFns = new Set();
    let status = 'loading';

    const coll = (c, create) => (state.collections[c] || (create ? (state.collections[c] = {}) : null));
    function setStatus(s, msg) { status = s; statusFns.forEach((f) => f(s, msg)); }

    function setPath(obj, path, val) {
      const parts = path.split('.');
      let o = obj;
      for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {}; o = o[parts[i]]; }
      o[parts[parts.length - 1]] = val;
    }
    function applyOp(st, op) {
      const save = state; state = st;
      try {
        if (op.t === 'set') coll(op.c, true)[op.id] = clone(op.data);
        else if (op.t === 'delete') { const m = coll(op.c); if (m) delete m[op.id]; }
        else if (op.t === 'update') {
          const m = coll(op.c, true);
          const doc = m[op.id] || (m[op.id] = {});
          Object.entries(op.data).forEach(([k, v]) => (k.includes('.') ? setPath(doc, k, clone(v)) : (doc[k] = clone(v))));
        }
      } finally { state = save; }
    }
    function mutate(op) {
      if (op.t === 'update' && !(coll(op.c) || {})[op.id]) return Promise.reject({ code: 'invalid_argument', message: 'No document to update: ' + op.c + '/' + op.id });
      applyOp(state, op);
      pending.push(op);
      if (!firstPendingAt) firstPendingAt = Date.now();
      setStatus('pending');
      notify(op.c);
      schedule();
      return Promise.resolve();
    }
    function schedule() {
      clearTimeout(timer);
      const wait = Date.now() - firstPendingAt > 8000 ? 0 : 1500;
      timer = setTimeout(flush, wait);
    }
    async function flush() {
      if (flushing || !pending.length) return;
      flushing = true; setStatus('saving');
      try {
        for (let attempt = 0; pending.length && attempt < 5; attempt++) {
          const n = pending.length;
          const res = await GH.write(app, state, sha, `${app}: ${n} change${n > 1 ? 's' : ''} (web)`);
          if (res.conflict) {           // someone (another device) saved first: replay our changes on theirs
            const remote = await GH.read(app);
            const st = remote.data;
            pending.forEach((op) => applyOp(st, op));
            state = st; sha = remote.sha;
            notify(null);
            continue;
          }
          sha = res.sha;
          pending.splice(0, n);
        }
        retryMs = 4000;
        if (!pending.length) { firstPendingAt = 0; setStatus('saved'); }
        else schedule();
      } catch (e) {
        setStatus('error', (e && e.message) || 'Saving failed.');
        clearTimeout(timer);
        if (e && e.code === 'bad_token') {   // expired or revoked: ask again, keep unsaved changes in memory
          setToken('');
          flushing = false;
          tokenSetup('GitHub stopped accepting your token (expired or revoked). Your unsaved changes are kept; connect again to save them.').then(() => flush());
          return;
        }
        timer = setTimeout(flush, retryMs); retryMs = Math.min(retryMs * 2, 60000);
      } finally { flushing = false; if (pending.length && status === 'saving') schedule(); }
    }
    async function refresh() {          // pick up changes made on another device
      if (pending.length || flushing) return;
      try {
        const remote = await GH.read(app);
        if (remote.sha !== sha && !pending.length) { state = remote.data; sha = remote.sha; notify(null); }
      } catch {}
    }

    // ---------- queries ----------
    const OPS = {
      '==': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
      in: (a, b) => Array.isArray(b) && b.includes(a), 'not-in': (a, b) => Array.isArray(b) && !b.includes(a),
      'array-contains': (a, b) => Array.isArray(a) && a.includes(b),
    };
    const getField = (d, f) => f.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d);
    const meta = () => ({ fromCache: false, hasPendingWrites: pending.length > 0 });
    function docSnap(c, id) {
      const d = (coll(c) || {})[id];
      return { id, exists: d !== undefined, data: () => clone(d), metadata: meta(), ref: docRef(c + '/' + id) };
    }
    function run(q) {
      const m = coll(q.c) || {};
      let ids = Object.keys(m).filter((id) => q.where.every(([f, op, v]) => (OPS[op] || OPS['=='])(getField(m[id], f), v)));
      if (q.order.length) {
        ids.sort((x, y) => {
          for (const [f, dir] of q.order) {
            const a = getField(m[x], f), b = getField(m[y], f);
            if (a === b) continue;
            const r = a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
            return dir === 'desc' ? -r : r;
          }
          return 0;
        });
      }
      if (q.lim != null) ids = ids.slice(0, q.lim);
      const docs = ids.map((id) => docSnap(q.c, id));
      return { docs, size: docs.length, empty: !docs.length, metadata: meta(), docChanges: () => docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })), forEach: (f) => docs.forEach(f) };
    }
    function notify(c) {
      listeners.forEach((l) => { if (c === null || l.c === c) later(() => l.fire()); });
    }
    let loaded = false;
    function listen(c, fire) {
      const l = { c, fire };
      listeners.add(l);
      if (loaded) later(fire);
      return () => listeners.delete(l);
    }
    function query(c, where, order, lim) {
      const q = { c, where, order, lim };
      return {
        where: (f, op, v) => query(c, [...where, [f, op, v]], order, lim),
        orderBy: (f, dir) => query(c, where, [...order, [f, dir || 'asc']], lim),
        limit: (n) => query(c, where, order, n),
        get: async () => run(q),
        onSnapshot: (next) => listen(c, () => next(run(q))),
      };
    }
    function collRef(path) {
      return Object.assign(query(path, [], [], null), {
        path,
        id: path.split('/').pop(),
        doc: (id) => docRef(path + '/' + (id || newId())),
        add: async (data) => { const id = newId(); await mutate({ t: 'set', c: path, id, data }); return docRef(path + '/' + id); },
      });
    }
    function docRef(path) {
      const i = path.lastIndexOf('/');
      const c = path.slice(0, i), id = path.slice(i + 1);
      return {
        id, path,
        get: async () => docSnap(c, id),
        set: (data) => mutate({ t: 'set', c, id, data }),
        update: (data) => mutate({ t: 'update', c, id, data }),
        delete: () => mutate({ t: 'delete', c, id }),
        acquire: async () => ({ acquired: true }),
        onSnapshot: (next) => listen(c, () => next(docSnap(c, id))),
        collection: (sub) => collRef(path + '/' + sub),
      };
    }
    const db = { doc: docRef, collection: collRef };

    return {
      db,
      async load() {
        let r = await GH.read(app);
        // A missing data file must never be treated as "no data": apps save derived records on open,
        // which would overwrite real data with empty values. Ask first.
        while (r.missing) {
          setStatus('error', 'No saved data found');
          const choice = await missingPrompt();
          if (choice === 'empty') break;
          r = await GH.read(app);
        }
        state = r.data; sha = r.sha; loaded = true; setStatus('saved');
        notify(null);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
        setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 120000);
        window.addEventListener('beforeunload', (e) => { if (pending.length) { flush(); e.preventDefault(); e.returnValue = ''; } });
        return db;
      },
      onStatus(f) { statusFns.add(f); f(status); },
      flushNow: flush,
      snapshot: () => clone(state),
    };
  }

  // ---------- UI: styles, token setup, save status, Claude hand-off ----------
  const CSS = `
  .aib-ui{--aib-bg:#fff;--aib-ink:#14201d;--aib-muted:#56645f;--aib-line:#d6deda;--aib-accent:#0b6b5c;--aib-accent-ink:#fff;--aib-ok:#1d7543;--aib-warn:#8a5300;--aib-bad:#b42318;--aib-field:#f3f5f4;
    font:14px/1.45 "Figtree",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--aib-ink)}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .aib-ui{--aib-bg:#151d1b;--aib-ink:#e5edea;--aib-muted:#9db0aa;--aib-line:#2a3633;--aib-accent:#5fc6b1;--aib-accent-ink:#062019;--aib-ok:#71d49c;--aib-warn:#f1bd63;--aib-bad:#ff8d84;--aib-field:#0d1312}}
  :root[data-theme="dark"] .aib-ui{--aib-bg:#151d1b;--aib-ink:#e5edea;--aib-muted:#9db0aa;--aib-line:#2a3633;--aib-accent:#5fc6b1;--aib-accent-ink:#062019;--aib-ok:#71d49c;--aib-warn:#f1bd63;--aib-bad:#ff8d84;--aib-field:#0d1312}
  .aib-bar{position:sticky;top:0;z-index:9990;flex:0 0 auto;display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;min-height:52px;box-sizing:border-box;
    padding:6px max(12px,env(safe-area-inset-right,0px)) 6px max(12px,env(safe-area-inset-left,0px));background:var(--aib-bg);border-bottom:1px solid var(--aib-line)}
  .aib-home{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding:0 14px 0 10px;border-radius:8px;border:1px solid var(--aib-line);background:var(--aib-field);color:var(--aib-ink);font-weight:600;text-decoration:none;white-space:nowrap}
  .aib-home:hover{border-color:var(--aib-accent);color:var(--aib-accent)}
  .aib-home svg{width:16px;height:16px}
  .aib-name{font-weight:600;color:var(--aib-muted);white-space:nowrap}
  .aib-status{margin-left:auto;display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--aib-muted);white-space:nowrap}
  .aib-status .d{width:8px;height:8px;border-radius:50%;background:var(--aib-muted)}
  .aib-status[data-s=saved] .d{background:var(--aib-ok)} .aib-status[data-s=error] .d{background:var(--aib-bad)}
  .aib-status[data-s=pending] .d,.aib-status[data-s=saving] .d{background:var(--aib-warn)}
  .aib-status .x{color:var(--aib-bad);font-weight:600}
  .aib-k{width:38px;height:38px;border:0;border-radius:8px;background:transparent;color:var(--aib-muted);cursor:pointer;font-size:18px;line-height:1}
  .aib-k:hover{background:var(--aib-field);color:var(--aib-ink)}
  .aib-home:focus-visible,.aib-k:focus-visible,.aib-btn:focus-visible{outline:2px solid var(--aib-accent);outline-offset:2px}
  body .selbar{top:60px!important}
  @media (max-width:520px){.aib-name{display:none}.aib-status .t{display:none}}
  .aib-modal{position:fixed;inset:0;z-index:10000;background:rgba(10,14,20,.55);display:flex;align-items:center;justify-content:center;padding:16px}
  .aib-box{background:var(--aib-bg);border:1px solid var(--aib-line);border-radius:14px;width:min(640px,100%);max-height:calc(100dvh - 32px);overflow:auto;padding:20px;display:grid;gap:12px}
  .aib-box h2{margin:0;font-size:19px} .aib-box p{margin:0} .aib-box ol{margin:0;padding-left:20px}
  .aib-box .m{color:var(--aib-muted);font-size:13px}
  .aib-box textarea,.aib-box input{width:100%;box-sizing:border-box;border:1px solid var(--aib-line);border-radius:8px;background:var(--aib-field);color:var(--aib-ink);padding:8px 10px;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
  .aib-box textarea{min-height:110px;resize:vertical}
  .aib-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;align-items:center}
  .aib-row .grow{flex:1}
  .aib-btn{text-decoration:none;display:inline-flex;align-items:center;border:1px solid var(--aib-line);background:var(--aib-bg);color:var(--aib-ink);border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit;font-weight:500}
  .aib-btn.p{background:var(--aib-accent);border-color:var(--aib-accent);color:var(--aib-accent-ink)}
  .aib-btn:disabled{opacity:.5;cursor:default}
  .aib-err{color:var(--aib-bad);font-size:13px}
  .aib-ok{color:var(--aib-ok);font-size:13px}
  .aib-box a{color:var(--aib-accent)}
  @media (max-width:520px){.aib-box{padding:16px}}`;
  let cssDone = false;
  function ensureCss() { if (cssDone) return; cssDone = true; document.head.appendChild(el('style', {}, CSS)); }

  function modal(html) {
    ensureCss();
    const m = el('div', { class: 'aib-modal aib-ui', role: 'dialog', 'aria-modal': 'true' });
    const box = el('div', { class: 'aib-box' }, html);
    m.appendChild(box);
    document.body.appendChild(m);
    return { m, box, close: () => m.remove(), $: (s) => box.querySelector(s) };
  }

  function tokenSetup(reason) {
    return new Promise((resolve) => {
      onReady(() => {
        const repo = `${CFG.owner}/${CFG.repo}`;
        const d = modal(`
          <h2>Connect your private data</h2>
          <p>This app saves to your private GitHub repository <b>${repo}</b>. Paste a GitHub token once; it stays in this browser only.</p>
          ${reason ? `<p class="aib-err">${reason}</p>` : ''}
          <ol class="m">
            <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → new fine-grained token</a>.</li>
            <li><b>Expiration:</b> 90 days or less.</li>
            <li><b>Repository access:</b> Only select repositories → <b>${CFG.repo}</b>.</li>
            <li><b>Permissions → Repository → Contents:</b> Read and write. Nothing else.</li>
            <li>Generate, copy, and paste it below.</li>
          </ol>
          <input type="password" id="aib-tok" placeholder="github_pat_…" autocomplete="off" spellcheck="false" aria-label="GitHub token">
          <label class="m" for="aib-exp">Token expiry date (from GitHub), so this page can remind you before it stops working</label>
          <input type="date" id="aib-exp" aria-label="Token expiry date">
          <label class="m" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="aib-rem" style="width:auto"> Remember on this device. Leave unticked on shared computers: the token is then forgotten when you close the browser.</label>
          <p class="aib-err" id="aib-msg" hidden></p>
          <div class="aib-row"><button class="aib-btn p" id="aib-save">Connect</button></div>`);
        const msg = d.$('#aib-msg');
        const fail = (text) => { msg.textContent = text; msg.hidden = false; d.$('#aib-save').disabled = false; };
        d.$('#aib-save').onclick = async () => {
          const t = d.$('#aib-tok').value.trim();
          if (!t) return;
          const bad = tokenProblem(t);
          if (bad) return fail(bad);
          const prev = getToken(), prevRem = isRemembered();
          setToken(t, d.$('#aib-rem').checked);
          d.$('#aib-save').disabled = true; msg.hidden = true;
          try { await GH.checkRepo(); setExpiry(d.$('#aib-exp').value); d.$('#aib-tok').value = ''; d.close(); resolve(); }
          catch (e) { setToken(prev, prevRem); fail(e.message || 'That token did not work.'); }
        };
        d.$('#aib-tok').focus();
      });
    });
  }

  function appBar(store) {
    onReady(() => {
      ensureCss();
      const home = script.dataset.home || '../../';
      const name = script.dataset.title || '';
      const bar = el('header', { class: 'aib-bar aib-ui', role: 'banner' },
        `<a class="aib-home" href="${home}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>Dashboard</a>` +
        (name ? `<span class="aib-name">${name}</span>` : '') +
        '<span class="aib-status" role="status" aria-live="polite"><span class="d" aria-hidden="true"></span><span class="t">Loading…</span><span class="x" hidden></span></span>' +
        '<button type="button" class="aib-k" aria-label="GitHub connection and sign out" title="GitHub connection and sign out">⚙</button>');
      document.body.prepend(bar);
      const st = bar.querySelector('.aib-status'), t = st.querySelector('.t');
      const LABEL = { loading: 'Loading…', saved: 'Saved to GitHub', pending: 'Unsaved changes', saving: 'Saving…', error: 'Not saved, retrying' };
      store.onStatus((s, m) => { st.dataset.s = s; t.textContent = LABEL[s] || s; st.title = m || LABEL[s] || ''; });
      const left = daysLeft(getExpiry());
      if (left !== null && left <= 7) {
        const x = st.querySelector('.x'); x.hidden = false;
        x.textContent = left < 0 ? 'Token expired' : `Token expires in ${left} day${left === 1 ? '' : 's'}`;
      }
      bar.querySelector('.aib-k').onclick = () => {
        const exp = getExpiry();
        const d = modal(`<h2>GitHub connection</h2>
          <p>Saving to <b>${CFG.owner}/${CFG.repo}</b> (private).</p>
          <p class="m">Token ${isRemembered() ? 'remembered on this device' : 'kept until you close the browser'}${exp ? ' · expires ' + exp : ''}.</p>
          <div class="aib-row"><button class="aib-btn" id="x">Close</button><button class="aib-btn" id="rm">Sign out</button><button class="aib-btn p" id="re">Replace token</button></div>`);
        d.$('#x').onclick = d.close;
        d.$('#rm').onclick = async () => { await store.flushNow(); setToken(''); location.reload(); };
        d.$('#re').onclick = () => { d.close(); tokenSetup().then(() => location.reload()); };
      };
    });
  }

  function missingPrompt() {
    return new Promise((resolve) => {
      onReady(() => {
        const name = script.dataset.title || 'this app';
        const d = modal(`<h2>No saved data found</h2>
          <p>GitHub has no data file for <b>${name}</b> in <b>${CFG.owner}/${CFG.repo}</b>. If you expected data here, it may have been moved or renamed. Nothing has been saved.</p>
          <p class="m">Choose <b>Start empty</b> only if this is a brand-new app. It will create a new, empty data file the first time something is saved.</p>
          <div class="aib-row"><a class="aib-btn" href="${script.dataset.home || '../../'}">Back to dashboard</a><button class="aib-btn" id="aib-empty">Start empty</button><button class="aib-btn p" id="aib-retry">Retry</button></div>`);
        d.$('#aib-retry').onclick = () => { d.close(); resolve('retry'); };
        d.$('#aib-empty').onclick = () => { d.close(); resolve('empty'); };
        d.$('#aib-retry').focus();
      });
    });
  }

  // Claude hand-off: the request is copied to claude.ai; the reply is pasted back.
  function asText(input) {
    if (typeof input === 'string') return input;
    if (Array.isArray(input)) return input.map((m) => (m.role === 'assistant' ? 'Assistant' : 'User') + ':\n' + m.content).join('\n\n');
    return String(input);
  }
  function sample(input, opts) {
    const text = asText(input);
    const signal = opts && opts.signal;
    return new Promise((resolve, reject) => {
      const tier = (opts && opts.modelTier) || 'default';
      const d = modal(`
        <h2>Ask Claude</h2>
        <p class="m">This step runs in Claude using your own account. Nothing is sent until you paste it.</p>
        <ol class="m"><li>Press <b>Copy &amp; open Claude</b>, then paste into the new chat and send.</li><li>Copy Claude's whole reply and paste it below.</li></ol>
        <textarea id="aib-q" readonly aria-label="Request for Claude"></textarea>
        <div class="aib-row"><span class="grow m" id="aib-cp"></span><button class="aib-btn" id="aib-copy">Copy only</button><button class="aib-btn p" id="aib-open">Copy &amp; open Claude</button></div>
        <textarea id="aib-a" placeholder="Paste Claude's reply here" aria-label="Claude's reply"></textarea>
        <div class="aib-row"><button class="aib-btn" id="aib-cancel">Cancel</button><button class="aib-btn p" id="aib-use" disabled>Use this reply</button></div>
        <p class="m">${tier === 'complex' ? 'Tip: this is a long, careful task; a stronger model in Claude gives better results.' : ''}</p>`);
      d.$('#aib-q').value = text;
      const done = (fn, v) => { d.close(); fn(v); };
      const copy = async () => {
        try { await navigator.clipboard.writeText(text); d.$('#aib-cp').textContent = 'Copied ✓'; return true; }
        catch { d.$('#aib-q').select(); d.$('#aib-cp').textContent = 'Select all and copy manually'; return false; }
      };
      d.$('#aib-copy').onclick = copy;
      d.$('#aib-open').onclick = async () => { await copy(); window.open('https://claude.ai/new', '_blank', 'noopener'); d.$('#aib-a').focus(); };
      d.$('#aib-a').oninput = () => { d.$('#aib-use').disabled = !d.$('#aib-a').value.trim(); };
      d.$('#aib-use').onclick = () => {
        const reply = d.$('#aib-a').value.trim();
        if (opts && typeof opts.onText === 'function') { try { opts.onText({ text: reply, delta: reply }); } catch {} }
        done(resolve, { text: reply, truncated: false });
      };
      d.$('#aib-cancel').onclick = () => done(reject, { code: 'cancelled', message: 'Cancelled. Nothing was sent to Claude.' });
      if (signal) signal.addEventListener('abort', () => done(reject, { code: 'aborted', message: 'Stopped.' }), { once: true });
    });
  }
  sample.limits = async () => ({ images: false });

  const user = {
    id: async () => 'me',
    me: async () => ({ id: 'me', name: '' }),
    isOwner: () => true, canEdit: () => true, can: () => true,
    profiles: async (ids) => Object.fromEntries((ids || []).map((i) => [i, { id: i, name: '' }])),
    search: async () => [],
  };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = el('a', { href: URL.createObjectURL(blob), download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { status: 'saved' };
    },
  };

  // ---------- wire up window.claude ----------
  async function ready() {
    if (!getToken()) await tokenSetup();
    for (;;) {
      try { await GH.checkRepo(); return; }
      catch (e) {
        if (e.code === 'unavailable') throw e;
        setToken(''); await tokenSetup(e.message);
      }
    }
  }

  let dbPromise = null;
  function getDb() {
    if (!APP) return Promise.resolve(null);
    if (!dbPromise) {
      const store = createStore(APP);
      appBar(store);
      dbPromise = ready().then(() => store.load()).catch(() => null);
    }
    return dbPromise;
  }
  const caps = { db: getDb, user: async () => user, sample: async () => sample, downloads: async () => downloads };
  window.claude = Object.freeze({ use: (name) => (caps[name] ? caps[name]() : Promise.resolve(null)) });

  // For the dashboard: read-only access to any app's data.
  window.AIB = {
    config: CFG,
    hasToken: () => !!getToken(),
    connect: () => ready(),
    readApp: async (app) => { const r = await GH.read(app); if (r.missing) throw { code: 'missing', message: 'No saved data found' }; return r.data; },
    commits: (n) => GH.commits(n),
    me: () => GH.me(),
    repo: () => GH.checkRepo(),
    tokenInfo: () => ({ remembered: isRemembered(), expires: getExpiry(), daysLeft: daysLeft(getExpiry()) }),
    signOut: () => { setToken(''); },
    _createStore: createStore, // used by tests
  };
})();
