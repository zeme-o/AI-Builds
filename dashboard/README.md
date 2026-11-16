# Dashboard

Hidden from search engines: every page carries `<meta name="robots" content="noindex, …">` (added by `tools/csp.py`).

A static dashboard on GitHub Pages that hosts two apps and checks them for urgent items.

| Path | What it is |
|---|---|
| `index.html` + `assets/app.js` | Overview. Reads each app's data and lists what needs attention. |
| `apps/goals/` | Goals: weekly goals and one-time tasks |
| `apps/writing/` | Writing: prompts, drafts and editor's notes |
| `shared/aib-store.js` | Storage and Claude hand-off used by all apps |
| `data/site.json` | App list shown on the overview |

## Where the data lives
**Not in this repo.** Every app saves to a JSON file in the private repo
`zeme-o/ai-builds-data` (`apps/<app>.json`) through the GitHub API. Each browser asks once for a
fine-grained GitHub token limited to that repo with **Contents: Read and write**. The token is kept
for the browser session (or on the device, if you tick "Remember") and only sent to `api.github.com`.

Changes save about 1.5 seconds after you stop editing, as one commit per batch, so the data repo's
history is a full undo log. If two devices save at once, the later save re-reads the file and
re-applies its own changes on top.

## Security
- **No third-party code.** Fonts (`vendor/fonts`, SIL OFL) and libraries (`vendor/js`: d3 7.9.0, JSZip 3.10.1) are served from this site.
- **Content-Security-Policy** on every page: scripts only from this site (inline scripts allowed by hash),
  network calls only to this site and `api.github.com`, no frames, forms, plugins or `<base>` changes. No referrer is sent.
  After editing any inline `<script>`, run `python3 tools/csp.py` (CI-style check: `python3 tools/csp.py --check`).
- **Token rules.** Only fine-grained tokens (`github_pat_…`) are accepted; classic tokens are refused. The data repo must be
  private or nothing is saved. The token is kept for the browser session unless "Remember on this device" is ticked.
  Enter the token's expiry date to get a warning 7 days before. A revoked/expired token prompts for a new one without
  losing unsaved changes. Sign out from the ⚙ menu or the Security page.
- **Audit.** `security.html` lists the last 40 commits to the data repo and flags any author who is not you or the daily
  `AI-Builds sync`. Saves from this site end in `(web)`; the daily push starts with `sync from claude.ai`.

## Daily push from claude.ai
A scheduled Claude task runs every day at 5:42 am (Eastern). It exports the claude.ai apps and merges only what
changed there into the data repo (see `tools/sync_claude.py` in `ai-builds-data`). It can also be started from the
**AI-Builds Push** page on claude.ai.

## Where the AI runs
Writing's AI steps (prompts, research, editor's notes, ink, summaries) run in **Claude**. The page
shows the request, copies it and opens claude.ai; you paste Claude's reply back. No API key is
stored anywhere.

## Checks on the overview
| App | Urgent | Warning |
|---|---|---|
| Goals | open goal overdue or due within 1 day | due within 3 days; weekly goal behind pace |
| Writing | draft deadline passed or under 24 h away | deadline within 3 days |

## Add an app
1. Put it in `apps/<id>/index.html` and add, right after `<meta charset>`:
   `<script src="../../shared/aib-store.js" data-app="<id>" data-home="../../"></script>`
2. Use `await window.claude.use('db')` for storage (Firestore-style: `collection`, `doc`, `get`,
   `set`, `update`, `delete`, `onSnapshot`, `where`, `orderBy`, `limit`).
3. Add it to `data/site.json`, and optionally a check in `CHECKS` in `assets/app.js`.

## Preview locally
Run this from the repo root, then open http://localhost:8000/dashboard/:
```bash
python3 -m http.server 8000
```
