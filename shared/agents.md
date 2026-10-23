# Todos for AI agents

Todos is a personal kanban board (To do · Doing · Done, with a Someday section under To do). This page is the single source of truth for scripts and AI agents that read or change it. Every change you make appears on the user's devices within a few seconds.

Base URL: `{{BASE}}`

## Getting the token

Most routes below need the external token. The three bot question routes need that bot's own token instead:

```
Authorization: Bearer <token>
```

- **Running on the server:** read it from the file `external-token` in the data directory (`DATA_DIR`, by default `data/` next to `server.js`; created once, mode 0600): `TOKEN=$(cat data/external-token)`.
- **Running anywhere else:** you cannot fetch it. Ask the server owner to give it to you.
- Never print it, log it, commit it or put it in a URL.
- The examples use `B={{BASE}}` and `$TOKEN`.

## Answering bot workspace questions

These routes are for Claw and Lurch. Use the bot token created by `scripts/provision-bots.mjs`, stored under `data/bot-credentials/<bot name>` on the server. It selects that bot's workspace. The general external token cannot answer questions.

### GET /kanban/external/asks

List queued questions and stale claims. Each entry includes a `requestId` and `cardId`.

```
curl -s "$B/kanban/external/asks" -H "Authorization: Bearer $BOT_TOKEN"
```

### POST /kanban/external/ask/claim

Claim a question before working on it. A claim can be retried after ten minutes.

```
curl -s -X POST "$B/kanban/external/ask/claim" -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" -d '{"requestId":"REQUEST_ID"}'
```

### POST /kanban/external/ask/reply

Return the answer on the original card. Use `blocked` when the bot needs input; `reply` must be nonempty and at most 4,000 characters.

```
curl -s -X POST "$B/kanban/external/ask/reply" -H "Authorization: Bearer $BOT_TOKEN" -H "Content-Type: application/json" -d '{"requestId":"REQUEST_ID","status":"done","reply":"The answer."}'
```

## Finding a card

Most routes act on one card. Pick it with a query parameter:

- `?id=<card id>`: exact, always unique (best once you know it).
- `?key=<your key>`: a stable key you chose when you created the card (idempotent captures).
- `?title=<title>`: the exact title, any letter case. Two cards with the same title answer 409 `ambiguous_title` with their `ids`; add `&exact=1` for a case-sensitive match, or use the id.

### GET /kanban/external/cards

Find cards. Optional `q` (text in title, notes or checklist), `status` (`todo`, `doing`, `done`), `label` (name or id), `archived=1`. Returns compact rows `{ id, title, status, someday, labels, labelNames, remindAt, remindEvery, remindNext?, links, attachments, key? }` in board order: `labels` are label ids, `labelNames` their names, and each attachment has its `url`. GET card below uses the same shapes.

```
curl -s "$B/kanban/external/cards?q=trip&status=todo" -H "Authorization: Bearer $TOKEN"
```

### GET /kanban/external/card

One full card by `?id=`, `?key=` or `?title=`: every field (notes, checklist `items`, dates), with `labels` as ids plus `labelNames`, and attachments with their `url`.

```
curl -s "$B/kanban/external/card?title=Plan%20the%20trip" -H "Authorization: Bearer $TOKEN"
```

## Creating and updating

### POST /kanban/external/card

JSON body. Two modes:

- **Create (or re-send):** no target in the query. Needs `key` (a stable id you choose) and `title` in the body. Sending the same `key` again updates that card instead of making a second one, so a capture can safely retry; in this mode a re-sent `title`/`notes` are ignored unless listed in `replace`.
- **Update:** target a card with `?id=`, `?key=` or `?title=`, including cards the user made. 404 if there is no such card; it never creates one. Here `title` or `notes` without `replace` is a 400, so a rename cannot silently do nothing.

Fields: `title`, `notes`, `status` (on create), `links` (`[{ title, url }]`, added, never duplicated), `labels` (on create: `[{ id, name, color }]`), `addLabels` / `removeLabels` (label names or ids; unknown names are created), `remindAt` (ISO date-time, or `null` to clear), `remindEvery` (`hour`, `day`, `weekday`, `week`, `month`, or `null` for once: the reminder repeats from `remindAt` until the card is Done; `hour` stays quiet 22:00–8:00; it needs a `remindAt`, on the request or already on the card, else 400; a repeating card keeps `remindAt` as its first time and reports the next one as `remindNext`, absent while the card rests in Done or Someday), `someday` (`true` parks it in Someday, and a card in Doing or Done moves to To do first, its checklist unchecked; `false` brings it back), `replace` (`["title"]` and/or `["notes"]`: on an update, title and notes change only when listed here).

Create:

```
curl -s -X POST "$B/kanban/external/card" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"agent:trip-1","title":"Plan the trip","notes":"Train or car?","addLabels":["Travel"]}'
```

Update by your key (or `?id=` / `?title=`): rename it.

```
curl -s -X POST "$B/kanban/external/card?key=agent:trip-1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Plan the Lisbon trip","replace":["title"]}'
```

Update notes, add a label and a link, set a reminder (times are UTC ISO):

```
curl -s -X POST "$B/kanban/external/card?title=Plan%20the%20trip" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"notes":"Book the 9:10 train","replace":["notes"],"addLabels":["Urgent"],"links":[{"title":"Timetable","url":"https://example.com/t"}],"remindAt":"2030-01-02T08:00:00Z"}'
```

Park it for later, or clear the reminder:

```
curl -s -X POST "$B/kanban/external/card?id=CARD_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"someday":true}'
curl -s -X POST "$B/kanban/external/card?id=CARD_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"remindAt":null}'
```

Remind every weekday at that time until the card is done (or nag hourly with `"remindEvery":"hour"`):

```
curl -s -X POST "$B/kanban/external/card?id=CARD_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"remindAt":"2030-01-02T08:00:00Z","remindEvery":"weekday"}'
```

Returns `{ ok, id, created }`.

### POST /kanban/external/status

Move a card: body `{ "status": "todo" | "doing" | "done" }`, target by `?id=`, `?key=`, `?title=` (or `key` / `slackTs` in the body). Checklists follow the app's rules: Done checks every item, To do unchecks them, and a fully checked list cannot go to Doing (409 `list_complete`). Moving out of To do also leaves Someday.

```
curl -s -X POST "$B/kanban/external/status?title=Plan%20the%20trip" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"status":"doing"}'
```

Returns `{ ok, id, changed }`.

### DELETE /kanban/external/card

Delete a card by `?id=`, `?key=` or `?title=`. There is no undo for a delete made here, so move the card to Done instead unless the user asked for a delete.

```
curl -s -X DELETE "$B/kanban/external/card?id=CARD_ID" -H "Authorization: Bearer $TOKEN"
```

## Attachments (images, screenshots, any file)

Up to 25 MB per file. Files are private: every download needs the token (or the user's session).

### POST /kanban/external/card/attach

Upload and attach in one call. Target the card with `?id=`, `?key=` or `?title=`. Send the raw file (`--data-binary`) or use multipart (`curl -F file=@path`, optional `-F name=...`).

- **The name:** best is multipart (`-F`) or `?name=` (URL-encode it). An `X-Filename` header works for plain names and raw UTF-8; percent-escapes in it are decoded only with `X-Filename-Encoding: percent`, so `100%20off.png` stays literal otherwise.
- **The type:** send the real `Content-Type`. curl's default for `--data-binary` (`application/x-www-form-urlencoded`) and `application/octet-stream` are ignored; the name's extension, then the file's first bytes (PNG, JPEG, GIF, WebP, PDF) decide.

```
curl -s -X POST "$B/kanban/external/card/attach?title=Plan%20the%20trip" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" -H "X-Filename: screenshot.png" --data-binary @screenshot.png

curl -s -X POST "$B/kanban/external/card/attach?id=CARD_ID" -H "Authorization: Bearer $TOKEN" -F file=@report.pdf
```

Returns `{ ok, cardId, attachment: { id, name, type, size, createdAt, url } }`. The attachment shows on the card in the open app within a few seconds.

### DELETE /kanban/external/card/attach

Remove one attachment: `?id=CARD_ID&attachment=ATTACHMENT_ID` (or `?title=`/`?key=` for the card). The file itself stays downloadable for 30 days (so the user can undo in the app), then it is deleted.

```
curl -s -X DELETE "$B/kanban/external/card/attach?id=CARD_ID&attachment=ATT_ID" -H "Authorization: Bearer $TOKEN"
```

### POST /kanban/files

Upload without attaching (raw body + `Content-Type` + `X-Filename`, or multipart). Returns `{ id, name, type, size, url }`. Unattached uploads are deleted after 30 days, so prefer the attach route above.

```
curl -s -X POST "$B/kanban/files" -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/plain" -H "X-Filename: notes.txt" --data-binary @notes.txt
```

### GET /kanban/files/:id

Download a file (`url` from any response above). Images and PDFs are sent inline, other types as a download. Responses carry an `ETag`; send `If-None-Match` to get a 304 when you already have it.

```
curl -s "$B/kanban/files/FILE_ID" -H "Authorization: Bearer $TOKEN" -o file
```

### GET /kanban/files/:id/thumb

A small JPEG/WebP preview when the app made one at upload, else 404.

```
curl -s "$B/kanban/files/FILE_ID/thumb" -H "Authorization: Bearer $TOKEN" -o thumb.jpg
```

### POST /kanban/files/:id/thumb

Store a preview (image/jpeg, image/webp or image/png, at most 2 MB, about 400 px). Optional; the app does this for images it uploads.

```
curl -s -X POST "$B/kanban/files/FILE_ID/thumb" -H "Authorization: Bearer $TOKEN" -H "Content-Type: image/jpeg" --data-binary @thumb.jpg
```

## Siri capture

### POST /kanban/capture

What the "Update my board" Siri shortcut and "Send to Todos" share-sheet shortcut call (Settings → Siri makes the token and the signed shortcut files). It is **not** the external token: `Authorization: Bearer <capture token>` identifies one account, and the card lands in that account's personal room. Three body shapes. `{ say, now? }` is one spoken sentence, understood against the account's cards by the local model: "add a checklist groceries with milk and eggs", "add carrots to groceries", "rename groceries to shopping", "add a note to shopping: use the loyalty card", "remind me about shopping tomorrow at 9" → `{ ok, id, action: create|add_items|rename|notes|remind, title, items, remindAt, said }`; a request that names no items ("add some items to shopping") answers `{ ok, ask: "items", said: "Which items for “shopping”?" }`, and sending the same `say` again with `items` (a dictated string) completes it. `{ url?, text?, name? }` (the share sheet) saves a link as a card named after its page title (public hosts only), or text as a card. `{ title, items?, notes?, now?, remindAt? }` is the direct form: a time spoken inside `title` ("water the plants tomorrow at 9", "Friday 5pm", "in 2 hours", also in Romanian) becomes the reminder and leaves the title; `items` is a dictated string ("milk, eggs and bread" → three checklist items; without separators the local model groups the words) or an array; `now` is the device's time as ISO 8601 with its zone, so "tomorrow" is the device's tomorrow; an explicit `remindAt` (ISO) wins. With `Accept: text/plain` the reply is the sentence Siri speaks ("Added “Groceries” with 3 items: milk, eggs, bread."), otherwise `{ ok, id, title, items, remindAt, said }`. Limits: 60 captures per account per 10 minutes; ten wrong tokens lock the address for 10 minutes.

```
curl -s -X POST "$B/kanban/capture" -H "Authorization: Bearer $CAPTURE_TOKEN" -H "Content-Type: application/json" -H "Accept: text/plain" \
  -d '{"title":"Water the plants tomorrow at 9","now":"2026-10-05T10:40:00+03:00"}'
```

## Errors

Errors are JSON `{ "error": "<code>" }` with an HTTP status:

- 400: a bad or missing field (the message says which), or no target given.
- 401 `unauthorized`: missing or wrong token.
- 404 `not_found`: no such card, file or attachment.
- 409 `ambiguous_title` (with `ids`), `list_complete`, or `file_id_taken`.
- 413 `file_too_large` (with `maxBytes`).

## This page

### GET /agents

This guide, as markdown (curl) or HTML (a browser). No token needed; it contains no secrets.

```
curl -s "$B/agents"
```
