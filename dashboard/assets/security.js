// Security page: connection checks and an audit of recent commits to the private data repo.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SYNC_AUTHOR = 'AI-Builds sync';
  const ICON = { pass: '✓', fix: '!', note: 'i' };
  const LABEL = { pass: 'Passed', fix: 'Needs fixing', note: 'Note' };

  const row = (state, title, detail) => `<div class="check ${state}"><span class="ic" aria-hidden="true">${ICON[state]}</span>` +
    `<span class="t"><span class="visually-hidden">${LABEL[state]}: </span>${esc(title)}</span><span class="d">${detail}</span></div>`;

  function source(c) {
    const first = (c.commit.message || '').split('\n')[0];
    if (/^sync from claude\.ai/.test(first)) return ['claude.ai push', 'sync'];
    if (/\(web\)\s*$/.test(first)) return ['This site', 'web'];
    return ['Other', ''];
  }

  function setConn(on) {
    $('conn').dataset.state = on ? 'on' : 'off';
    $('conn').querySelector('.label').textContent = on ? 'Private data connected' : 'Not connected';
  }

  async function run() {
    setConn(true);
    const cfg = AIB.config;
    const rows = [];
    try {
      const repo = await AIB.repo();
      rows.push(['pass', `Data repository ${cfg.owner}/${cfg.repo} is private`, 'Only you, and people you invite, can read it.']);
      rows.push([repo.permissions && repo.permissions.push ? 'pass' : 'fix', 'Token can save to the data repository', 'Needed for the apps to save.']);
    } catch (e) {
      rows.push(['fix', 'Data repository check failed', esc(e.message || 'Unknown error')]);
    }
    const ti = AIB.tokenInfo();
    rows.push(['pass', 'Fine-grained token in use', 'Classic tokens are refused because they can reach every repository you own.']);
    rows.push(ti.daysLeft === null ? ['note', 'Token expiry date not recorded', 'Replace the token from any app\'s ⚙ menu and enter its expiry date to get a reminder.']
      : ti.daysLeft < 0 ? ['fix', 'Token has expired', 'Create a new token on GitHub and replace it from any app\'s ⚙ menu.']
      : [ti.daysLeft > 7 ? 'pass' : 'fix', `Token expires in ${ti.daysLeft} day${ti.daysLeft === 1 ? '' : 's'} (${esc(ti.expires)})`, 'Create a new one before then.']);
    rows.push(ti.remembered ? ['note', 'Token is remembered on this device', 'Fine on your own device. On a shared computer, sign out.']
      : ['pass', 'Token is forgotten when the browser closes', 'Safest setting for shared computers.']);
    rows.push([location.protocol === 'https:' || location.hostname === 'localhost' ? 'pass' : 'fix', 'Page loaded over HTTPS', 'Protects the token in transit.']);
    rows.push(['pass', 'Hidden from search engines', 'Every page asks search engines not to index it.']);
    $('checks').innerHTML = '<div class="checks">' + rows.map((r) => row(...r)).join('') + '</div>';
    const fixes = rows.filter((r) => r[0] === 'fix').length;
    $('chk-sum').textContent = fixes ? `${fixes} to fix` : 'All passed';
    $('signout').hidden = false;

    let me = null;
    try { me = await AIB.me(); } catch {}
    try {
      const commits = await AIB.commits(40);
      const mine = me && me.login;
      $('log').innerHTML = commits.map((c) => {
        const who = (c.author && c.author.login) || c.commit.author.name || 'unknown';
        const [src, cls] = source(c);
        const expected = who === mine || c.commit.author.name === SYNC_AUTHOR;
        const when = new Date(c.commit.author.date).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
        return `<tr${expected ? '' : ' class="flag"'}><td class="num">${esc(when)}</td><td>${esc(who)}${expected ? '' : ' <span class="chip bad">Unexpected</span>'}</td>` +
          `<td><span class="chip ${cls}">${esc(src)}</span></td><td><a href="${esc(c.html_url)}" target="_blank" rel="noopener">${esc(c.commit.message.split('\n')[0])}</a></td></tr>`;
      }).join('') || '<tr><td colspan="4" class="muted">No changes yet.</td></tr>';
    } catch (e) {
      $('log').innerHTML = `<tr><td colspan="4" class="muted">${esc(e.message || 'Could not load the history.')}</td></tr>`;
    }
  }

  $('signout').addEventListener('click', () => { AIB.signOut(); location.reload(); });
  if (AIB.hasToken()) run();
  else {
    $('checks').innerHTML = '<div class="notice info"><div class="grow"><b>Connect your private data</b><p class="muted">The checks need access to your private repository.</p></div><button type="button" class="btn primary" id="connect">Connect</button></div>';
    $('connect').onclick = () => AIB.connect().then(run);
  }
})();
