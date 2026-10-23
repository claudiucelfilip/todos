# Todos — Developer guide

[← Product overview](../README.md)

A personal notes app with a Board that filters notes into To do, Doing and Done columns.
Installable PWA; a self-hosted server holds the shared board and devices keep an offline cache.

## Appearance

Settings offers the ten selected Studio themes as miniature app previews, with eight independently selectable background patterns. Theme and pattern choices follow the signed-in account across rooms and devices; a local cache keeps offline startup consistent. Text and borders use translucent neutral overlays that adapt to bright and dark surfaces. Cards use 1px blur, the overlapping editor uses 36px blur, and the header lets scrolling content show beneath it.

Capture expands from the bottom-right field into the same editor used for existing notes. Board cards stay separated, Notes uses one column on phones, and label rules keep their existing behavior.

## Core rules
- **One note model.** To do, Doing and Done are exclusive workflow labels. Other labels coexist.
  The Board filters by workflow label; Notes shows every unarchived note, including Done.
- **One editor.** Add opens the same floating panel as editing. Board Add preselects To do;
  Notes Add starts without a workflow label. Title and body save as you type. Closing an
  untouched empty draft discards it. Desktop panels stay open until explicitly closed.
- **Natural card sizes.** Content determines card height; drag or Alt+arrows reorder the grid.
  Manual resizing and panel minimization are retired.
- **Drag into a checklist.** Drop a card on another card's center when “Add to checklist” appears.
  The original stays intact as a linked item; Undo removes the link. Edges still rearrange cards.
  Works in Board, including touch long-press, and in desktop Notes.
- **Completion and progress are separate.** A note's ring moves it into To do; the next tap
  completes it, and another reopens it. Checklist
  ticks never move the parent note, and moving or completing a note keeps its ticks.
  A linked checklist row still completes/reopens its child note.
- **Markdown bodies.** Click a body line to edit it; other lines render markdown. Files and
  links can be pasted into the editor. Untitled notes use their first body line as a preview.
- **Capture.** Siri and share-sheet parsing remain available. Text typed into the editor is
  literal; choose labels and reminders with its controls. Swipe between Board columns and
  Notes; swiping an item left reveals Delete.
- **Forgiving.** No confirmation dialogs; every destructive action has Undo (⌘Z,
  10-deep stack). An undo step reverts only the fields and checklist items its action
  changed (a card it created is deleted, a card it deleted comes back whole), so changes
  that arrived from sync or the external API meanwhile, even on the same card, survive it.
- **Labels.** User-defined, colored board labels (built-in `Sherlock` can be renamed or
  recolored, not deleted). Cards show up to two label dots/names + "+N"; the detail's inline "Add label"
  picker toggles labels or creates one (Enter creates and applies). Settings → Labels
  renames, recolors and deletes (deleting strips it from every card; undoable). The top-bar
  label filter shows only cards with at least one selected label (AND with search), is kept
  per device, and applies independently to each view. `#name` in search
  also matches a card's labels.
- **Reminders.** "Remind me" in the detail: Later today (+3 h, to the hour), This evening
  (18:00), Tomorrow 9:00, Next Monday 9:00 or any date & time; the card face shows a bell and
  the time (accent within 24 h). Times are entered and shown in local time, stored as UTC
  (`remindAt`; the server stamps `remindedAt`). The server checks every 15 s and sets a
  precise timer for anything due sooner, so pushes land within a second or two; they go
  out as ntfy JSON (any title; links with "," or ";" intact). Install the ntfy app and
  subscribe to the topic shown in Settings → Notifications (Send test checks it).
  `kanban.remind(card, isoOrNull, every?)`; undo covers set / change / clear.
- **Repeating reminders.** Once a time is set, the picker next to it chooses Once, Every hour,
  Daily, Weekdays, Weekly or Monthly (`remindEvery`). `remindAt` stays as the anchor the user
  set; the time due is the first slot after the last push (`dueAt` in `shared/repeat.mjs`:
  wall-clock steps in the server's time zone, so 9:00 stays 9:00 across DST and a monthly
  31st comes back to the 31st; hourly skips 22:00–8:00). The server only ever writes
  `remindedAt`, so a push never competes with an edit made offline. It keeps reminding until
  the card is Done; it rests in Done and Someday and waits for its next slot, never late.
  Back to Once keeps the upcoming slot as a single reminder. A Repeat card's fresh copy
  carries the schedule on (finished less than half an interval ahead of a reminder, that one
  is skipped). Card face: "9:00 · daily".
- **Input-aware.** Drag follows the input, not the layout: touch and pen lift after a 350 ms press
  (the card swells as the press builds), a mouse after a few pixels, so an iPad drags across the
  desktop columns and into Someday. Dragging near a column's or the list's edge scrolls it; on a
  phone, holding a card over a column tab for 500 ms switches to that column. Swipe actions run on
  any touch pointer (never a mouse) and never start within 20 px of the left edge (iOS back).
  Coarse pointers always show hover-only controls and get ≥ 44 px targets. Desktop mouse: right-click
  a card (or Shift+F10 / the ContextMenu key, or the hover ···) for Move to To do/Doing/Done, Someday,
  Remind me and Delete; hovering a card also shows "→ Start / Done". Rules in `src/lib/input.ts`.
- **Swipe actions (touch, iOS Mail style).** Swipe a card left for Delete. Past 40 % of the
  width (or a fast flick) commits; past 72 px it stays open at 88 px with a tappable action;
  one open row at a time. Checklist rows in the detail swipe left to delete. Undo covers all
  of it; reduced motion commits or closes without sliding. Use the card's status control or
  menu to move it through To do, Doing, and Done.
- **Icons.** The chrome's icons come from `src/components/Icons.tsx` (gear, three dots, X) at
  22 px on 36–44 px buttons, so none reads as a speck; no text glyphs for controls. Full-height
  sheets and the assistant leave the iPhone's top inset free (`--safe-top`), so their close
  buttons never sit under the status bar.
- **Editing items.** On desktop a click on an item's text edits it in place (the box toggles);
  Enter with text after the caret splits the item there, and the rest opens as the next item,
  caret at its start. Escape cancels, an emptied item is removed. The add field above the list
  is a two-line box, one item per line. Touch: hold and release to edit, as below.
- **Checklist order.** Any input can reorder items, always within their group (unchecked above,
  checked below; a drop across the line stops at the group's edge and never changes an item's
  state). Mouse: drag the ⋮⋮ handle, or the row once it moves a few pixels (a click on the box still toggles).
  Mouse: a click on the text edits. Touch / pen: press and hold (the row swells), then move to drag; hold and release without moving
  to edit; a horizontal swipe before the hold deletes; a tap toggles. ⌥↑/⌥↓ (or ⌘↑/⌘↓) moves a
  focused row. Rows glide aside on the heavy spring and the panel scrolls near its edges. Synced as
  `items.order`.
- **Links in text.** Items, notes and titles show bare http(s)/mailto URLs and Markdown
  `[words](url)` as links (only the words); anything else, `javascript:` included, stays text.
  Links open a new tab and never toggle, edit, drag or swipe the row; on the card face they are
  shown but not clickable. Editing shows the raw Markdown. In the item editor and the add-items field,
  pasting a URL over selected words, or ⌘K with a selection (a small inline prompt), makes
  `[words](url)`. Items hold up to 1000 characters so links fit; the grammar keeps them verbatim.
- **Attachments.** Images, screenshots and any file (25 MB each) attach from the detail's
  Files and links section: Add (on iPhone/iPad the picker offers camera, photos or files), drop
  files on the panel, or paste (⌘V). Each file shows its upload progress; offline it waits in an
  IndexedDB queue as pending and uploads on reconnect (Retry after a failure). Images get a
  tile preview and a lightbox (←/→ or swipe, Esc, open or download); other files a tile with extension, name
  and size. × removes with Undo. The card face shows a file count and a 40 px preview of the first
  attachment (an image or its file extension). Files the device has shown stay viewable offline (service worker cache,
  about 100 MB); signing out or a session that ends deletes it and a marker stops the worker from
  serving or storing files until the next working session. Synced per attachment (`att.put` / `att.delete`, LWW with
  tombstones), so two devices adding at once both keep theirs. `kanban.attach(card, fileOrBlob,
  name?)`, `kanban.attachments(card)`, `kanban.detach(card, id)`. **Agents:** see `/agents`
  (the guide the server publishes from `shared/agents.md`).
- **Links.** Cards may carry `links` (shown as a link count on the face, a list in the
  detail, removable with undo) and an `ext` reference to the external record they came from.
- **Someday.** A quiet "Someday · N" divider always sits at the bottom of To do (desktop and
  phone); everything below it is parked. Drag a card below or above it (cards from Doing/Done
  land in To do, parked), use ⌘↑/↓ across it, S, the card menu (Move to / out of Someday) or
  the detail's Someday segment. Parking lands at the top of Someday, un-parking at the bottom
  of To do; Doing/Done or checking an item un-parks. Someday cards count only on the divider
  (not the To do column, the phone segment or the header counter). The chevron collapses it (per device,
  `kept.somedayOpen`); search and the label filter apply inside it. Empty, it shows "Drag here
  to park for later". `kanban.someday(card, bool)`.
- **Reminders pause in Someday.** The server never sends for a Someday card and the card keeps
  `remindAt` (face: slashed bell; detail: "Paused · …"). Leaving Someday before the time arms it
  again. Leaving after the time marks it **missed**, never sent late: the app (and the server,
  when it moves a card) stamps `remindedAt = remindAt` in the same write. Rule: `remindedAt ===
  remindAt` means passed without a push (also used for >12 h late), shown as "Missed Tue 9:00";
  a sent push is always stamped strictly after `remindAt` ("Reminded …").
- **Repeat** re-creates a finished list in To do; Done cards archive after 14 days (configurable).

## Develop
```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + PWA build to dist/
npm test           # all suites (merge, sync, syncclient, db, derive, reducer, copy, store, api, search, external, serverboard, reminders, repeat, files, windows)
npm start          # self-contained server: dist/ + legacy sync API on :8094
```

## Layout
```
src/
  App.tsx                 routing (#card/<id>, #todo|#doing|#done, §14.2 intents), keyboard nav, live region
  components/             Board, Composer, CardFace, PhoneNav, CardDetailPanel, CardMenu,
                          ChecklistRow, AddItemsField, TopBar, Banners, SettingsPanel,
                          ArchiveView, Toast, ShortcutSheet
  hooks/useStore.ts       the store: ordering, persistence, undo, toasts, Repeat, archive, import/export
  hooks/useKeyboardNav.ts §7.12 desktop shortcuts
  hooks/useKeyboardInset  §9.1 --kb from visualViewport
  lib/derive.ts           §6 derivation (pure)
  lib/reducer.ts          updateCard and every pure write (pure)
  lib/parse.ts            §14.1 text grammar (parse + serialise)
  lib/copy.ts             §15.1 user-visible copy — the only source of strings
  lib/spring.ts           spring physics: damped oscillator → CSS linear() / WAAPI keyframes; the named
                          springs snappy (popovers, chips, toasts, closing), gentle (panels, sheets, column
                          switch, checkbox), heavy (card flight, FLIP reorder), release (swipe / drop settle,
                          with the finger's velocity). Tokens --spring-*(-ms) in index.css (linear() needs
                          iOS 17.2+; older engines get cubic-bezier)
  lib/kanban-api.ts       window.kanban (§14.3)
  lib/intents.ts          URL intents (§14.2)
  lib/labels.ts           built-in label, palette, label/link helpers (pure)
  lib/db.ts               IndexedDB (cards, settings + labels + label filter, outbox)
fixtures/board.json       the seven demo cards (§16); fixtures/sequence.md the scripted acceptance run
scripts/*.test.ts         explicit-assertion suites, run with tsx
```

## `window.kanban` (§14.3)

Synchronous, validates input, throws descriptive errors. Every call goes through
the same reducer as the UI, so derivation, limits and undo apply identically.
Card selectors accept an id or a case-insensitive exact title; item selectors
accept an item id, an exact text, or `"*"` for all.

```js
kanban.version                          // 1
kanban.list({ status?, query?, label?, includeArchived? })   // Card[] copies (+ done[] / remaining[] texts)
kanban.get('Groceries')                 // Card | null
kanban.addCard('Groceries\nSaturday market\n- [ ] Oat milk\n- [x] Eggs')   // text grammar
kanban.addCard({ title, notes?, items?: string[], status?, labels?: string[] })  // label ids or names (case-insensitive)
kanban.labels()                         // [{ id, name, color }]
kanban.addLabel({ name, color? })       // color '#RRGGBB'; an existing name is reused
kanban.setLabels('Groceries', ['work', 'sherlock'])   // replaces the card's labels (undoable)
kanban.addItems('Groceries', ['Bread', 'Butter'])   // appended after the last unchecked item, in order
kanban.check('Groceries', 'Bread')      // by text or item id; '*' = all (one write, one completion)
kanban.uncheck('Groceries', '*')
kanban.setStatus('Groceries', 'done')   // same item rules as the UI; a full list cannot go to Doing
kanban.someday('Groceries', true)       // park below the Someday divider (from any column → To do); false un-parks
kanban.remove('Groceries')              // → { undo() }
kanban.exportText()                     // whole board in the grammar, cards separated by ---
kanban.exportText('Groceries')
kanban.exportJSON()                     // the Board as pretty JSON (stamps lastBackupAt)
kanban.importBoard(boardOrJson, 'replace' | 'merge')   // the validator's set-up call
kanban.importText(markdown)             // grammar with --- separators, Merge semantics
kanban.subscribe(({ type, card }) => …) // fires after every committed change; returns unsubscribe
kanban.undo()
```

`window` also dispatches `CustomEvent('kanban:change', { detail: { type, card } })`.

### Text grammar (§14.1)
```
Groceries                ← line 1: title (optional leading "# ")
Saturday market + Lidl   ← plain lines before the first item: notes

- [ ] Oat milk           ← "- [ ]" unchecked, "- [x]" checked
- [x] Eggs               ← "- ", "* ", "• ", "1. " also accepted as unchecked
Spinach                  ← after the first item, bare lines are items too
```

### URL intents (§14.2)
```
/#/add?text=<urlencoded grammar>&status=todo|doing|done[&nonce=…]
/#/card/<id>/add-items?text=…      /#/card/<id>/check?items=a,b
/#/card/<id>/uncheck?items=…       /#/card/<id>/status?set=done
/#/find?q=…                        (title=<exact title> may replace <id>)
```
A nonce seen in the last 24 h is ignored. Text shared to the installed PWA
(Web Share Target) opens the same add flow.

### DOM conventions (§14.4)
`data-testid`: `composer-todo|doing|done`, `composer-submit`, `card-<id>`,
`card-<id>-circle`, `detail-title`, `detail-add-items`, `item-<id>`,
`status-someday|todo|doing|done`, `search`, `someday-divider`, `someday-toggle`, `someday-list`. Cards expose `data-status` and
`data-progress="2/7"`; the board root exposes `data-counts="todo:3,doing:2,done:1"`.

## Sync (§13.3)
`server.js` keeps an append-only action log + snapshot in `data/kanban.json`
(git-ignored). **The server board is the only board.** Signed in, a device loads
`GET /kanban/snapshot` on boot and REPLACES its local board with it, then pulls since a
cursor (`GET /kanban/pull?since=`: on launch, on returning to the app (visibility, pageshow, online),
right after a local edit, on another window's hint, and otherwise every 30 s while visible, never
while hidden; one person across devices needs propagation, not real-time) and
replaces its board with the result after every run. Pre-existing local cards are never
merged or uploaded; the local IndexedDB copy is only a read cache for offline display.
Local edits apply at once and go up through the outbox (`POST /kanban/push`); the outbox
is the only local data that ever reaches the server, and its unsent edits stay visible on
top of the server board until they land. The server applies actions with
`shared/merge.mjs` (per-field last-write-wins, items by id, 30-day tombstones).
Several windows of one browser (installed app + a tab) each keep their own pull cursor and
stamp a per-page-load device id; signed in, a change in one window only prompts the others
to sync at once (they never re-read IndexedDB, which is a write-only cache until the next boot).
Outbox rows that are not current-format actions are dropped with one `console.warn`
(IndexedDB v4 also deletes the old list-model stores). A failing run shows
"Sync failing: <reason>" under the top bar and logs `console.error`. Signed in, the top bar's
counter line adds a muted "· Offline" (· N waiting) while the device is offline or the server
can't be reached, or just "· Not synced" when the server answered with an error (the banner has
the detail); it fades out once a sync succeeds. On a phone the date truncates first. The hosted app never
seeds a Welcome/demo card.
A sync never disturbs what you are doing: a pull that changes nothing is no change at all (equal cards
keep their objects, nothing re-renders), and a real change updates only the cards it touched, without
re-mounting the open card, popovers or menus, moving focus or the caret, or overwriting text you are
typing (a field you are editing keeps your draft; only what you typed is saved). The first snapshot
after launch or login lands silently (no entrance, no counter roll), the cached board is the first
painted frame, and banners float over the board instead of pushing it. A new deploy's service worker
reloads the app only in the background (or in its first seconds, before anything is open), never in
front of you.
Board labels sync as `label.put` / `label.delete` (per-label last-write-wins, 30-day
tombstones); a card's `labels`, `links` and `ext` are whole-field LWW. Unknown label
names/ids in the API throw with the list of known labels.

**Sign-in.** Served from the backend, sync is on by default. On boot the app asks
`GET /kanban/session`: 200 → it syncs; a real 401 → a full-screen sign-in (username +
password, autofill-friendly); unreachable → the board just works offline, no login.
`POST /kanban/login` checks `TODOS_USER` / `TODOS_PASS` (environment variables, never in the repo) and sets a
one-year `todos_session` cookie (HttpOnly, SameSite=Lax, Secure behind https),
HMAC-signed with `data/session-secret` (0600, created once; restarts keep sessions,
a password change ends them; each session also expires a year after sign-in).
Failed logins/Basic attempts: 10 per 10 min per IP (`cf-connecting-ip` /
`x-forwarded-for` are trusted only from a loopback peer, i.e. the cloudflared tunnel).
Without a session the app shows only the sign-in (the cached board stays hidden). Only a
JSON 401 from the server itself (session, push, pull, snapshot) means signed out; network
errors, timeouts, aborts, 5xx and non-JSON replies are sync failures. If the server can't be
reached the app keeps retrying (30 s, backing off to 60 s, and on every return to the app) and syncs on
its own when it is back; a device with a remembered account counts as signed in meanwhile
("Offline · last synced …" plus the "Sync failing" line).
Settings → Sync shows "Synced · …" (offline: "Offline · last synced …"), "Signed in as …"
(the last user is remembered on the device) and Sign out (clears the cookie,
keeps local data). Push/pull/snapshot also accept `Bearer <API_TOKEN>` (scripts, older
devices; `/#/pair?token=…` still works) and `Basic <user:pass>`. With neither
`API_TOKEN` nor `TODOS_USER` set the routes are open (local dev only).
```
POST /kanban/login    { username, password } → { ok, user } + cookie | 401 | 429
POST /kanban/logout   → clears the cookie
GET  /kanban/session  → { ok, user } | 401
```
Tests: `npm run test:merge`, `npm run test:sync`, `npm run test:syncclient`,
`npm run test:external`, `npm run test:serverboard` (legacy device DB + outbox signs in and
shows exactly the server board; two devices identical; offline edit; 401 → login).

### External API (wiki capture, Slack hook)
Same server, JSON in/out, `Authorization: Bearer <token>` where the token is either
`API_TOKEN` or the external token in `data/external-token` (32 random bytes hex, created
with mode 0600 on first start, never logged). `DATA_DIR` overrides `./data`. Writes go
through the action log as device `server`, so every device gets them on its next pull.
```
POST /kanban/external/card    { key, title, notes?, links?: [{title,url}], labels?: [{id,name,color}],
                                status?: 'todo'|'doing'|'done', slackTs?, slackChannel? }
     → { ok, id, created }    idempotent by key: an existing card only gains links never
                              delivered before (ext.seenLinks, so a link removed in the app stays
                              removed) and slackTs/slackChannel; title/status/notes/labels stay.
                              Missing labels are created; existing ones are never overwritten.
                              A new card is plain and lands at the top of its column (order
                              ≤ -now/1000, so it also tops cards the server has never seen).
                              Also on create/update: `remindAt` (ISO or null), `remindEvery` (400 without a
                              reminder time; repeating cards report `remindNext`); on an existing key
                              `replace: ["title","notes"]` overwrites just those fields.
POST /kanban/external/status  { key? | slackTs?, status } → { ok, id, changed } | 404
                              (same rules as the status control; 409 list_complete for Doing
                              on a fully checked list)
GET  /kanban/external/card?key=… → { ok, card } | 404
```
Every external route also targets a card by `?id=` or an exact `?title=`; there are also
`GET /kanban/external/cards` (find), `DELETE /kanban/external/card`, `POST|DELETE
/kanban/external/card/attach` and the file routes (`/kanban/files`). `GET /agents` (public, no
secrets) documents all of them with curl examples; `scripts/files.test.mjs` fails if a route in the
server's `ROUTES` table is missing from it.

### Attachments on the server
Blobs in `DATA_DIR/files/<id>` + `<id>.json` (+ `<id>.thumb`). `POST /kanban/files` (raw body with
`Content-Type` + `X-Filename`, or multipart; `X-File-Id` makes a retry idempotent) → `{ id, name,
type, size, url }`; `GET /kanban/files/<id>` (private, no-cache + ETag so every view re-checks the session; images/PDF inline, HTML/SVG
sandboxed); `GET|POST /kanban/files/<id>/thumb`. Auth: session, Bearer, Basic or the external token.
413 `file_too_large` above 25 MB (`FILE_MAX_BYTES`). Files no card references are deleted 30 days
after their last reference ended (on start and every 12 h); `FILES_QUOTA_WARN_BYTES` (5 GB) only logs.
400 `{ error }` on a missing key/title, a bad status or a non-http(s) link.

### View-only link
Settings → Share (owner only) makes one link to the whole board for anyone, no account needed:
"Create view-only link", Copy, "New link" (the old one stops working) and "Stop sharing" (both ask
first, in the app). The token is 32 random bytes in `DATA_DIR/share-token` (0600; no file = not
shared). `GET /view/<token>` sets a one-year `todos_view` cookie (HttpOnly, SameSite=Lax, Secure
behind https) plus a readable `todos_viewer=1` marker (no secret) and redirects to `/`; a wrong or old
token gets a small "no longer shared" page and counts against its own per-IP limit (10 per 10 min,
separate from logins; the right link always opens, so guesses cannot lock it). A viewer may only read `GET /kanban/session` (`{ ok, user: null, viewer: true }`),
`GET /kanban/snapshot` (filtered: no archived cards, no `ext`, no tombstones, only labels in use) and the files attached to
visible cards; every other route treats it as signed out (or `403 read_only`), so revoking or rotating
the token ends every viewer at once. A signed-in owner always wins over the view cookie, and the
owner's browser stops being a viewer: a session answer or a sign-in removes the view cookie and the
marker (a sign-in on a browser that held one answers `fresh: true`, and the app drops anything unsent).
Writes (anything but GET/HEAD/OPTIONS) whose `Origin` is not this server (or whose `Sec-Fetch-Site` is
`same-site` / `cross-site`) are never authenticated by a cookie or a remembered Basic login, and cannot
sign the owner out; Bearer tokens are unaffected.
```
GET    /kanban/share                  → { shared, url }          (owner)
POST   /kanban/share  { rotate? }     → { shared: true, url }    (creates once; rotate replaces)
DELETE /kanban/share                  → { shared: false, url: null }
```
The marker cookie makes the app read-only from the first frame (before the server answers, offline too,
whatever happened to localStorage); the session answer keeps it in step (owner: removed; viewer: set;
logout with a working view link: set). A confirmed viewer, a revoked link and a sign-in from either
discard everything unsent on the device (outbox, queued uploads), so an owner sign-in there starts
from the server board; the marker alone discards nothing (an owner who opened their own link keeps
unsent edits).
In the app a viewer gets the board read-only (`<html data-readonly>`, a quiet "View only" pill): the
board comes from the snapshot only (launch, return to the app, every 30 s while visible), nothing is
ever pushed, pulled from the log or queued, and one guard in the store (`VIEW_ACTIONS` in
`useStore.ts`) turns every other action into a no-op; `window.kanban` write methods throw (`src/lib/readonly.ts`).
When the link stops working the cached board, cached files and the marker are deleted and "This board
is no longer shared" shows, with Sign in. Tests: `npm run test:share` (server), `npm run test:readonly` (client).

### Email signup and sign-in

With an SMTP sender configured, sign-in asks only for an email. The first verified
sign-in creates a private account without a password; room invitations use the same
flow. Links expire after 15 minutes and work once. Opening a link requires pressing
a button, so email scanners cannot consume it. Existing users can verify their email
in Settings to retain their rooms and preferences.

The link can be opened anywhere, including a different browser than the one that
asked (an installed phone app, say, whose emails open in Safari or Chrome). The device
that asked shows a four-digit code and waits; the link page names that device and asks
for that code, which signs in the waiting device and nothing else. Typing the code proves
the approver can see the waiting device, so a link someone else requested with your
address cannot sign their device in (five wrong codes void the link). "Continue in this
browser instead" signs in the browser that opened the link, as before, and tells the
waiting device the link was used. Opened in the same browser that asked, the page just
offers Continue. A request repeated within a minute answers exactly like a fresh one
(the device waits until the window ends), so replies never reveal that someone is
signing in. Routes: `POST /kanban/email/request` returns `{ request, code }` for the
device to wait with; `POST /kanban/email/link { token }` names the device that asked; `POST
/kanban/email/approve { token, code }` approves it; `POST /kanban/email/wait { request }`
answers `pending`, `approved` (with the session cookie, once), `used` or `expired`. The
wait id is a 256-bit secret stored hashed, like the token.

Set `TODOS_SMTP_HOST`, `TODOS_SMTP_PORT`, `TODOS_SMTP_USER`, `TODOS_SMTP_PASS`
and `TODOS_MAIL_FROM` in the service environment. `APP_URL` must be the public
HTTPS app address. External SMTP connections require TLS. Without a sender,
existing password sign-in and invited registration remain available.

Configure an SMTP sender with `TODOS_SMTP_HOST`, `TODOS_SMTP_PORT`, `TODOS_SMTP_USER`, `TODOS_SMTP_PASS`, and `TODOS_MAIL_FROM`.
Run `npm run test:email` against an isolated SMTP sink; no external email is sent.

### Siri (iPhone and Apple Watch)
Two shortcuts: "Update my board" (the name is the Siri phrase: a longer one is caught far better than
a bare "todo", and it must not read as a Reminders command, since "update my todos" made Siri look
for a Reminders list called "todos") and "Send to Todos" in the share sheet. Siri
cannot pass words spoken after a shortcut's name into it, so "Update my board" asks one question and the whole
sentence goes to the server as `say`: `shared/intent.mjs` lifts the time out (when.mjs), shows the
local model the active card titles and gets back one action (`create` with optional items,
`add_items`, `rename`, `notes`, `remind`) whose words are checked against the sentence (the model
may pick and group words, never invent them, and may only name a real card); without the model, an
exact title plus a time is a reminder and "x with a, b and c" a checklist. Problems are spoken too
("I didn't catch a time for …", 200 with `Accept: text/plain`, 400 as JSON). "add some items to
watch movie" names no items, so the model marks `needsItems` and the reply is the question "Which
items for “watch movie”?"; the shortcut's If step asks it and sends the dictated answer as `items`
with the same sentence. "Send to Todos" posts
`{ url, text }`; the card is named after the page's `<title>` (`shared/page-title.mjs`: public
http(s) hosts only, the name is resolved and private/loopback/link-local addresses refused, 6 s,
1.5 MB), falls back to the first line of text or the host, and keeps the link on the card. Settings → Siri makes one capture token per account (`data/accounts.json` → `shortcuts`, plain so the
files can embed it; "New shortcuts" replaces it, "Turn off" deletes it) and serves two signed Apple
Shortcuts files, `GET /kanban/shortcuts/todo.shortcut` and `send.shortcut` (session, or the
10-minute `?key=` the install links carry, since a phone browser downloads without the cookie; the
server runs `/usr/bin/shortcuts sign --mode anyone`, so it needs macOS, else 503). Each shortcut asks
by voice, sends the phone's clock as ISO 8601 with its zone, posts to `POST /kanban/capture` with the
token and speaks the plain-text reply; `WatchKit` in the file makes it run on the watch. The route
(`shared/capture.mjs`, `shared/when.mjs`) cleans the dictated title, lifts a spoken time out of it
("tomorrow at 9", "Friday 5pm", "in 2 hours", "tonight", "October 12 at 3pm"; English and Romanian)
into `remindAt`, splits dictated items on commas and "and" (a dictation without any separator, "milk
bread chicken potatoes", is grouped into items by the local model, `shared/split.mjs`, accepted only
when it keeps exactly the dictated words; if the model is down the dictation stays one item), and adds the card at the top of To do in
the user's personal room through the action log as device `server`. `GET|POST|DELETE /kanban/shortcuts`
report, make and revoke the token. Limits: 60 captures per account per 10 minutes; ten wrong tokens
lock the client address like a failed login. `npm run test:capture`.

## Assistant

The Assistant button opens help for the current room: choose priorities, draft tasks,
or break a task into checklist steps. Review each suggestion before applying it;
Apply has Undo and never completes, moves, or deletes an existing task. Closing
keeps the conversation for this page session. Reloading or switching rooms clears it.

The backend can use a private OpenAI-compatible model server. It requires Node 20.3 or newer. Optional environment
settings: `TODOS_AI_URL`, `TODOS_AI_MODEL` (default `qwen-local`) and
`TODOS_AI_TIMEOUT_MS` (default 60000). Keep the model endpoint private.

Only signed-in room members can ask. The model receives a bounded summary of
active tasks in that room; it receives no attachment contents, other rooms,
passwords, or account email addresses. Conversations stay in browser memory.

A question runs as a queued job (`POST /kanban/assistant/jobs` answers 202 with a job
id; the app polls `GET /kanban/assistant/jobs/<id>` every second and shows the stage:
waiting, working, reconnecting). A job lives up to five minutes, each user
has one question in flight, the queue holds four, one generation runs at a time, and
each user may start thirty jobs per ten minutes; a job is only visible to the user and room that started it, and the
same `requestId` returns the same job, so a retried request never runs twice. Stop,
or closing the panel, deletes the job; the model may take a moment to release a
generation already running. A question that did not complete is marked so it can be
sent again. The older `POST /kanban/assistant` answers in one request, limited to ten
per client IP per ten minutes. No email or external AI service is used.

Run `npm run test:ai` for isolated model, authentication and room-isolation checks.
Store checks also cover literal unchecked steps, stale tasks and Undo.

## Deploy

Run `npm ci && npm run build` on your server, then start `server.js` behind HTTPS.
Set `TODOS_USER`, `TODOS_PASS`, and `APP_URL` in the server environment. Store the
runtime `data/` directory outside Git and keep it across upgrades. Optional reminder
settings are `NTFY_SERVER` (default `https://ntfy.sh`) and `NTFY_TOPIC` (otherwise a
random topic is created in `data/`). Restart the server when backend code changes.

### Sherlock handoff

A connected personal account can ask Sherlock from any saved note’s editor. The optional
message includes the note and checklist. Successful delivery adds Sherlock and moves the
note to Doing; subsequent requests reuse the same Slack thread. Existing capture/wiki
notes recover their original thread from their Slack reference or a Slack link in the body.
Imported answers, including a wiki brief posted as the first message, stay unread until
shown in the editor. Active To do captures move to Doing when connected; completed or
archived captures keep their state. Captures without a Slack reference wait for one.

Substantive replies add **Sherlock replied**, with a one-sentence preview and a Slack link
in the editor. Acknowledgments do not add that label. The label’s **On view** setting removes
it when the response is visible in a foreground editor; other labels can use the same setting.
Reading one reply does not clear a newer reply arriving from another device.

Drafts and request identifiers survive closing and reloading. Delivery errors explain the
failure and offer copied diagnostic details. Retries reconcile saved receipts before sending;
when delivery cannot be confirmed, they stop rather than start duplicate work. The Slack
thread remains available for continuing directly.

The connection is configured in the server’s private `data/sherlock-config.json`, outside Git:
Slack bot token and identity, existing DM channel, signed Hermes webhook URL/secret, allowed
Todos users and rooms. Bind the webhook listener to loopback and restart the services
after initial setup. Never put credentials in source code or frontend settings.

Checks: `npm run test:sherlock`; browser workflow: `node scripts/visual/sherlock.mjs` after
`npm run build`. The browser harness uses an isolated account and simulated Slack transport.
