// Seeds an account with the v6 prototype's demo board, 1:1 (scripts/visual/proto/v6.html, the
// `cards` in its Component state), with every date computed from a FIXED "now" so the app renders
// the same strings as the design ("2h", "Sat", "28 Sep", "Yesterday"). The visual harness freezes
// the browser clock to the same instant (VISUAL_NOW, default Tuesday 6 Oct 2026 12:00 local).
//   TODOS_BASE=http://127.0.0.1:8795 TODOS_USER=… TODOS_PASS=… VISUAL_NOW=2026-10-06T12:00:00 node scripts/visual/seed-design.mjs
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { diffCards, diffLabels } from '../../shared/merge.mjs';

export const DEFAULT_NOW = '2026-10-06T12:00:00'; // the prototype's header reads "Tuesday 6 Oct"

const BASE = process.env.TODOS_BASE || 'http://127.0.0.1:8795';
const USER = process.env.TODOS_USER;
const PASS = process.env.TODOS_PASS;
if (!USER || !PASS) throw new Error('TODOS_USER and TODOS_PASS are required');
const now = new Date(process.env.VISUAL_NOW || DEFAULT_NOW);
if (Number.isNaN(now.getTime())) throw new Error(`VISUAL_NOW is not a date: ${process.env.VISUAL_NOW}`);

const login = await fetch(`${BASE}/kanban/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const cookie = login.headers.getSetCookie()[0].split(';')[0];
const H = { cookie, 'content-type': 'application/json' };

// --- the "Hallway paint" swatch: the prototype's grey-green gradient as a PNG -------------------------
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 3 + 1) + 1 + x * 3);
  }
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const a = [0x9a, 0xa6, 0x9e];
const b = [0x5f, 0x6e, 0x66];
const swatch = png(480, 260, (x, y) => {
  const t = Math.min(1, (x / 480 + y / 260) / 2);
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
});
const up = await fetch(`${BASE}/kanban/files`, { method: 'POST', headers: { cookie, 'content-type': 'image/png', 'x-filename': 'swatches.png' }, body: swatch });
if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text()}`);
const file = await up.json();

// --- dates, relative to the fixed now, chosen so the app prints the prototype's literal strings ---------
const day = (offset, h = 10, m = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const dow = now.getDay();
const weekday = (target) => -((dow - target + 7) % 7 || 7); // the most recent such day before today
const ago = (hours) => new Date(now.getTime() - hours * 3600000).toISOString();
const nextDow = (target, h, m) => day(((target - dow + 7) % 7) || 7, h, m);
const DATE = {
  '2h': ago(2), '3h': ago(3), '4h': ago(4), Today: day(0, 9), Yesterday: day(-1, 18), Mon: day(weekday(1)), Sun: day(weekday(0)), Sat: day(weekday(6)),
  '28 Sep': day(-8), '30 Aug': day(-37), '1 Sep': day(-35), '9 Sep': day(-27), '12 Sep': day(-24), '21 Sep': day(-15), '29 Sep': day(-7), '1 Oct': day(-5), '2 Oct': day(-4), '3 Oct': day(-3),
};

// --- labels: the palette hexes the app maps to the prototype's per-theme dots (labelDotColors) ----------
const LABELS = [
  { id: 'home', name: 'Home', color: '#2E9E6B' },
  { id: 'work', name: 'Work', color: '#2F80ED' },
  { id: 'health', name: 'Health', color: '#E2699A' },
  { id: 'errands', name: 'Errands', color: '#F5A524' },
  { id: 'ideas', name: 'Ideas', color: '#12A6B8' },
].map((l) => ({ ...l, updatedAt: now.toISOString() }));

// --- the v6 cards, verbatim from the prototype, in its order (that order is the grid order) ----------------
const SRC = [
  { id: 't1', kind: 'todo', status: 'todo', title: 'Renew passport', titleBy: 'user', content: '', items: [], labels: ['errands'], remind: nextDow(4, 12, 7), date: 'Sat' },
  { id: 't2', kind: 'todo', status: 'todo', title: 'Routine checkup', titleBy: 'user', content: 'Bring a list of questions.\n\n[Appointment details](https://example.org)', items: [{ text: 'Call to confirm' }, { text: 'Add to calendar' }], labels: ['health'], remind: nextDow(5, 11, 7), date: 'Sat' },
  { id: 't3', kind: 'todo', status: 'todo', title: 'Q4 roadmap review', titleBy: 'user', content: '## Topics\n- Ship notes by Nov\n- Siri actions\n- Rooms invite flow', items: [{ ref: 'n9' }], labels: ['work'], date: 'Mon' },
  { id: 'd1', kind: 'todo', status: 'doing', title: 'Plan the Lisbon trip', titleBy: 'user', content: '', items: [{ text: 'Book flights', done: true }, { text: 'Hotel near Alfama' }, { ref: 'n8' }, { text: 'Confirm the car rental' }], labels: ['home'], date: '28 Sep' },
  { id: 'd2', kind: 'todo', status: 'doing', title: 'Groceries', titleBy: 'user', content: '', items: [{ text: 'Eggs', done: true }, { text: 'Olive oil', done: true }, { text: 'Coconut milk' }, { text: 'Bread' }], labels: ['errands'], date: 'Sun' },
  { id: 'x1', kind: 'todo', status: 'done', title: 'Pay electricity bill', titleBy: 'user', content: '', items: [], labels: ['home'], date: 'Today', doneAt: 'Today' },
  { id: 'x2', kind: 'todo', status: 'done', title: 'Send the tax return', titleBy: 'user', content: '', items: [{ text: 'Gather receipts', done: true }, { ref: 'n5' }], labels: ['errands'], date: 'Yesterday', doneAt: 'Yesterday' },
  { id: 'n1', title: 'Chasing the light in Lisbon · Aperture Diaries', titleBy: 'auto', content: '[Chasing the light in Lisbon · Aperture Diaries](https://aperturediaries.com/chasing-the-light-lisbon)', items: [], labels: [], date: '2h', via: 'share', w: 1, h: 1 },
  { id: 'n0', title: 'Saturday shop', titleBy: 'ai', content: '', items: [{ text: 'Lemons' }, { text: 'Parmesan' }, { text: 'Oat milk' }, { text: 'Dish soap' }], labels: [], suggest: 'errands', date: '3h', via: 'siri', w: 1, h: 2 },
  { id: 'n2', title: 'Boiler service before winter', titleBy: 'ai', content: 'Ask the landlord whether the boiler service is booked before November. Last year it was done in October, and the certificate is in the kitchen drawer.', items: [], labels: [], suggest: 'home', date: '4h', via: 'siri', w: 2, h: 1 },
  { id: 'n3', title: '', titleBy: null, content: 'Guest Wi-Fi details are in the router app.', items: [], labels: [], date: '28 Sep', w: 1, h: 1 },
  { id: 'n6', title: 'Sourdough, basic loaf', titleBy: 'user', content: '## Dough\n500 g flour, 350 g water, 100 g **starter**, 10 g salt.\n\n## Method\n- Mix, rest 30 min\n- Fold every 30 min for 2 h\n- Shape, fridge overnight\n- Bake 250° covered 20 min, 230° uncovered 25 min\n\nFrom [The Perfect Loaf](https://theperfectloaf.com).', items: [], labels: ['home'], date: '9 Sep', w: 2, h: 2 },
  { id: 'n7', title: 'Hallway paint', titleBy: 'ai', content: `Farrow & Ball **Pigeon** for the walls, Little Greene **French Grey Pale** for the woodwork. Two tins each.\n\n![swatches](/kanban/files/${file.id})`, items: [], labels: ['home'], attach: true, date: '21 Sep', w: 1, h: 2 },
  { id: 'n8', title: 'Camping kit', titleBy: 'user', content: '', items: [{ text: 'Tent pegs (lost two)' }, { text: 'Head torch batteries', done: true }, { ref: 'n14' }, { text: 'Gas canister' }, { text: 'First aid refill' }], labels: ['home'], date: '30 Aug', w: 1, h: 2 },
  { id: 'n14', title: 'Water filter: which one', titleBy: 'user', content: 'Gravity bag for base camp, squeeze for day hikes. Ask a friend about the squeeze one before buying.', items: [{ ref: 'n16' }, { text: 'Check flow rate on the gravity bag' }], labels: ['home'], date: '1 Sep', w: 1, h: 2 },
  { id: 'n16', title: '', titleBy: null, content: 'Ask about the squeeze filter', items: [], labels: ['home'], date: '1 Sep', w: 1, h: 1 },
  { id: 'n5', title: '', titleBy: null, content: 'Fix the garden gate', items: [], labels: ['home'], done: true, date: '12 Sep', w: 1, h: 1 },
  { id: 'n9', title: 'Offsite room', titleBy: 'ai', content: 'Book a room for the offsite. Thursday works best; the big room is free after 2.', items: [], labels: ['work'], date: 'Mon', w: 1, h: 1 },
  { id: 'n10', title: '', titleBy: null, content: 'Review sync options and the mobile layout before the next planning session.', items: [], labels: ['work'], date: '1 Oct', w: 1, h: 1 },
  { id: 'n11', title: '', titleBy: null, content: 'A timer that only counts while the laptop lid is open.', items: [], labels: ['ideas'], date: '3 Oct', w: 1, h: 1 },
  { id: 'n13', title: 'Learn to make sourdough', titleBy: 'user', content: '', items: [], labels: ['ideas'], done: true, date: '12 Sep', w: 1, h: 1 },
  { id: 'n12', title: '', titleBy: null, content: 'Birthday gift idea: a book about city tiles.', items: [], labels: ['ideas', 'errands'], date: '29 Sep', w: 1, h: 1 },
  { id: 'n18', title: '', titleBy: null, content: 'Water the olive tree twice a week.', items: [], labels: ['home'], date: '2 Oct', w: 1, h: 1 },
  { id: 'n17', title: '', titleBy: null, content: 'Return the borrowed drill', items: [], labels: ['errands'], date: '2 Oct', w: 1, h: 1 },
];

const uid = (k) => `v6-${k}`;
const byKey = new Map(SRC.map((c) => [c.id, c]));
const title = (c) => c.title || c.content.split('\n')[0];
const doneOf = (k) => { const c = byKey.get(k); return c.kind === 'todo' ? c.status === 'done' : !!c.done; };
const cards = SRC.map((c, i) => {
  const created = DATE[c.date];
  const isNote = c.kind !== 'todo';
  const h = c.h ?? (c.items.length || c.content.length > 90 ? 2 : 1);
  const card = {
    id: uid(c.id),
    title: c.title,
    notes: c.content,
    status: c.status ?? 'todo',
    order: i,
    items: c.items.map((it, j) => (it.ref ? { id: uid(`${c.id}-${j}`), text: title(byKey.get(it.ref)), done: doneOf(it.ref), ref: uid(it.ref) } : { id: uid(`${c.id}-${j}`), text: it.text, done: !!it.done })),
    labels: [...c.labels],
    createdAt: created,
    updatedAt: created,
    completedAt: c.doneAt ? DATE[c.doneAt] : c.done ? day(-1, 20) : null,
    archivedAt: null,
    someday: false,
    repeat: false,
    remindAt: c.remind ?? null,
    remindedAt: null,
    layout: { order: i, w: c.w ?? 1, h },
  };
  if (isNote) card.kind = 'note';
  if (c.titleBy) card.titleBy = c.titleBy;
  if (c.done) card.done = true;
  if (c.via) card.via = c.via;
  if (c.suggest) card.suggestedLabel = c.suggest;
  if (c.attach) card.attachments = [{ id: file.id, name: 'swatches.png', type: 'image/png', size: swatch.length, createdAt: created }];
  return card;
});

const ts = now.toISOString();
// The account starts with the server's starter labels under random ids: replace them with the design's.
const snap = await (await fetch(`${BASE}/kanban/snapshot`, { headers: H })).json();
const existing = (snap.labels ?? []).filter((l) => !LABELS.some((d) => d.id === l.id));
// Label changes carry the real time: the starter labels were written 'now', and an older stamp would lose.
const actions = [...diffLabels(existing, LABELS, new Date().toISOString(), 'seed'), ...diffCards([], cards, ts, 'seed')];
const res = await fetch(`${BASE}/kanban/push`, { method: 'POST', headers: H, body: JSON.stringify({ deviceId: 'seed-' + crypto.randomUUID().slice(0, 8), actions }) });
console.log(`replaced ${existing.length} starter label(s) (${existing.map((l) => l.name).join(', ')}); seeded ${cards.length} cards and ${LABELS.length} labels as of ${now.toString()}: ${res.status} ${await res.text()}`);
