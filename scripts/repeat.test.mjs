// Repeating reminders: the schedule in shared/repeat.mjs (pure). Runs in Europe/Bucharest
// so the DST cases are fixed. Run: `npm run test:repeat`.
process.env.TZ = 'Europe/Bucharest';
const { nextRemind, remindResting, REMIND_EVERY, dueAt, restStamp, onceAt, copyStamp, repeats, lastSlot } = await import('../shared/repeat.mjs');

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const L = (s) => new Date(s); // local wall time
const fmt = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const next = (at, every, after) => { const r = nextRemind(L(at).toISOString(), every, L(after).getTime()); return r && fmt(r); };
const is = (name, got, want) => check(name, got === want, `got ${got}, want ${want}`);

is('hourly: one hour on', next('2026-10-01T09:30', 'hour', '2026-10-01T09:30:05'), '2026-10-01 10:30');
is('hourly: a late push still lands on the grid', next('2026-10-01T09:30', 'hour', '2026-10-01T11:45'), '2026-10-01 12:30');
is('hourly: the 21:30 slot is followed by 8:30 (quiet 22:00–8:00)', next('2026-10-01T21:30', 'hour', '2026-10-01T21:30:05'), '2026-10-02 08:30');
is('hourly: in the middle of the night the next slot is 8:00', next('2026-10-01T09:00', 'hour', '2026-10-03T03:10'), '2026-10-03 08:00');
is('hourly: 21:00 is still allowed', next('2026-10-01T20:00', 'hour', '2026-10-01T20:00:01'), '2026-10-01 21:00');
is('daily: same time tomorrow', next('2026-10-01T09:00', 'day', '2026-10-01T09:00:02'), '2026-10-02 09:00');
is('daily: stays 9:00 across the autumn clock change', next('2026-10-24T09:00', 'day', '2026-10-24T09:00:02'), '2026-10-25 09:00');
is('daily: stays 9:00 across the spring clock change', next('2027-03-27T09:00', 'day', '2027-03-27T09:00:02'), '2027-03-28 09:00');
is('daily: a time inside the spring gap lands an hour later that day only', next('2027-03-27T03:30', 'day', '2027-03-27T04:00'), '2027-03-28 04:30');
is('daily: ...and is back at 3:30 the day after', next('2027-03-27T03:30', 'day', '2027-03-28T04:30'), '2027-03-29 03:30');
is('daily: after a long gap, the first slot after now', next('2026-01-01T09:00', 'day', '2026-10-01T10:00'), '2026-10-02 09:00');
is('weekdays: Friday is followed by Monday', next('2026-10-02T09:00', 'weekday', '2026-10-02T09:00:01'), '2026-10-05 09:00');
is('weekdays: Wednesday is followed by Thursday', next('2026-09-30T09:00', 'weekday', '2026-09-30T09:00:01'), '2026-10-01 09:00');
is('weekly: same weekday', next('2026-10-01T09:00', 'week', '2026-10-01T09:00:01'), '2026-10-08 09:00');
is('weekly: after a gap, still the same weekday', next('2026-10-01T09:00', 'week', '2026-10-20T09:00'), '2026-10-22 09:00');
is('monthly: same day next month', next('2026-10-15T09:00', 'month', '2026-10-15T09:00:01'), '2026-11-15 09:00');
is('monthly: the 31st clamps to the end of a short month', next('2026-01-31T09:00', 'month', '2026-01-31T09:00:01'), '2026-02-28 09:00');
is('monthly: across the year end', next('2026-12-10T09:00', 'month', '2026-12-10T09:00:01'), '2027-01-10 09:00');
is('a time still ahead is its own next slot', next('2026-10-05T09:00', 'day', '2026-10-01T08:00'), '2026-10-05 09:00');
check('the result is strictly after "after"', REMIND_EVERY.every((e) => Date.parse(nextRemind('2026-10-01T06:00:00.000Z', e, Date.parse('2026-10-01T06:00:00.000Z'))) > Date.parse('2026-10-01T06:00:00.000Z')));
check('not repeating: null', nextRemind('2026-10-01T06:00:00.000Z', null, 0) === null && nextRemind('2026-10-01T06:00:00.000Z', 'yearly', 0) === null && nextRemind('nope', 'day', 0) === null);

// The way the server walks a schedule: the anchor never moves, each push stamps remindedAt.
const walk = (at, every, n) => {
  const c = { remindAt: L(at).toISOString(), remindEvery: every, remindedAt: null };
  const out = [];
  for (let i = 0; i < n; i++) {
    const due = dueAt(c);
    out.push(fmt(due));
    c.remindedAt = new Date(Date.parse(due) + 1500).toISOString(); // pushed a moment after its time
  }
  return out.join(' | ');
};
is('monthly on the 31st comes back to the 31st (no drift)', walk('2026-01-31T09:00', 'month', 5), '2026-01-31 09:00 | 2026-02-28 09:00 | 2026-03-31 09:00 | 2026-04-30 09:00 | 2026-05-31 09:00');
is('daily at 3:30 is back at 3:30 after the spring gap (no drift)', walk('2027-03-26T03:30', 'day', 4), '2027-03-26 03:30 | 2027-03-27 03:30 | 2027-03-28 04:30 | 2027-03-29 03:30');
is('weekly keeps its weekday and time across the autumn change', walk('2026-10-19T09:00', 'week', 3), '2026-10-19 09:00 | 2026-10-26 09:00 | 2026-11-02 09:00');
is('hourly walks the hours and sleeps through the night', walk('2026-10-01T20:15', 'hour', 4), '2026-10-01 20:15 | 2026-10-01 21:15 | 2026-10-02 08:15 | 2026-10-02 09:15');
const iso = (s) => L(s).toISOString();
is('dueAt: a one-off is its remindAt', fmt(dueAt({ remindAt: iso('2026-10-01T09:00'), remindedAt: iso('2026-10-01T09:00:02') })), '2026-10-01 09:00');
is('dueAt: a repeating one never pushed is its anchor', fmt(dueAt({ remindAt: iso('2026-10-01T09:00'), remindEvery: 'day', remindedAt: null })), '2026-10-01 09:00');
is('dueAt: a one-off already sent that is switched to repeat is due at its next slot (never stuck)', fmt(dueAt({ remindAt: iso('2026-10-01T09:00'), remindEvery: 'day', remindedAt: iso('2026-10-01T09:00:02') })), '2026-10-02 09:00');
check('dueAt: none without a time; an unknown repeat is a one-off', dueAt({ remindAt: null, remindEvery: 'day' }) === null && dueAt({ remindAt: iso('2026-10-01T09:00'), remindEvery: 'yearly', remindedAt: iso('2026-10-02T09:00') }) === iso('2026-10-01T09:00') && !repeats({ remindEvery: 'yearly' }));
const nowIso = iso('2026-10-03T12:00');
check('restStamp: an overdue repeating reminder is handled through now (next slot ahead)', restStamp({ remindAt: iso('2026-10-01T09:00'), remindEvery: 'day', remindedAt: null }, nowIso) === nowIso && fmt(dueAt({ remindAt: iso('2026-10-01T09:00'), remindEvery: 'day', remindedAt: nowIso })) === '2026-10-04 09:00');
check('restStamp: an overdue one-off is missed (= remindAt)', restStamp({ remindAt: iso('2026-10-01T09:00'), remindedAt: null }, nowIso) === iso('2026-10-01T09:00'));
check('restStamp: nothing overdue, nothing to stamp', restStamp({ remindAt: iso('2026-10-05T09:00'), remindEvery: 'day' }, nowIso) === undefined && restStamp({ remindAt: iso('2026-10-01T09:00'), remindedAt: iso('2026-10-01T09:00:01') }, nowIso) === undefined && restStamp({ remindAt: null }, nowIso) === undefined);
is('onceAt: back to once keeps the upcoming slot', fmt(onceAt({ remindAt: iso('2026-10-01T09:00'), remindEvery: 'day', remindedAt: iso('2026-10-02T09:00:01') }, Date.parse(nowIso))), '2026-10-04 09:00');
// A Repeat card's copy: `born` is when the finished card was created.
const copyDue = (at, every, now, born) => fmt(dueAt({ remindAt: iso(at), remindEvery: every, remindedAt: copyStamp({ remindAt: iso(at), remindEvery: every, createdAt: born && iso(born) }, iso(now)) }));
is('copy: finished after its reminder fired: the next slot', copyDue('2026-10-01T09:00', 'day', '2026-10-03T09:05', '2026-10-02T09:05'), '2026-10-04 09:00');
is('copy: fired this morning, finished in the evening: tomorrow still reminds', copyDue('2026-10-01T09:00', 'day', '2026-10-03T21:30', '2026-10-02T10:00'), '2026-10-04 09:00');
is('copy: weekdays, fired Friday, finished Sunday night: Monday reminds', copyDue('2026-10-01T09:00', 'weekday', '2026-10-04T22:00', '2026-10-01T10:00'), '2026-10-05 09:00');
is('copy: weekly, fired Thursday, finished Monday: this Thursday reminds', copyDue('2026-10-01T09:00', 'week', '2026-10-05T12:00', '2026-09-25T12:00'), '2026-10-08 09:00');
is('copy: monthly, fired on the 1st, finished on the 18th: next month reminds', copyDue('2026-10-01T09:00', 'month', '2026-10-18T12:00', '2026-09-20T12:00'), '2026-11-01 09:00');
is('copy: finished 10 minutes ahead of its own reminder: that one is skipped', copyDue('2026-10-01T09:00', 'day', '2026-10-03T08:50', '2026-10-02T09:05'), '2026-10-04 09:00');
is('copy: finished well ahead (the evening before, 13 h): tomorrow still reminds', copyDue('2026-10-01T09:00', 'day', '2026-10-02T20:00', '2026-10-02T09:05'), '2026-10-03 09:00');
is('copy: weekly, finished two days ahead of its own reminder: skipped', copyDue('2026-10-01T09:00', 'week', '2026-10-06T09:00', '2026-10-01T10:00'), '2026-10-15 09:00');
is('copy: a card never reminded yet, finished well ahead: its first time holds', copyDue('2026-10-05T09:00', 'day', '2026-10-01T08:00', '2026-10-01T07:00'), '2026-10-05 09:00');

check('slots keep the anchor\'s milliseconds', nextRemind('2026-10-01T06:00:00.789Z', 'day', Date.parse('2026-10-01T06:00:01.000Z')) === '2026-10-02T06:00:00.789Z' && nextRemind('2026-10-01T06:00:00.789Z', 'month', Date.parse('2026-10-01T06:00:01.000Z')).endsWith('.789Z'));

// After an outage only the latest slot matters.
const last = (at, every, now) => { const r = lastSlot(iso(at), every, L(now).getTime()); return r === null ? null : fmt(new Date(r).toISOString()); };
is('lastSlot: daily, two days later', last('2026-10-01T09:00', 'day', '2026-10-03T10:00'), '2026-10-03 09:00');
is('lastSlot: weekdays on a Sunday is Friday', last('2026-10-01T09:00', 'weekday', '2026-10-04T10:00'), '2026-10-02 09:00');
is('lastSlot: hourly in the night is the last one before the quiet hours', last('2026-10-01T09:15', 'hour', '2026-10-03T03:00'), '2026-10-02 21:15');
is('lastSlot: monthly', last('2026-01-31T09:00', 'month', '2026-03-10T10:00'), '2026-02-28 09:00');
is('lastSlot: weekly, exactly on a slot', last('2026-10-01T09:00', 'week', '2026-10-15T09:00'), '2026-10-15 09:00');
check('lastSlot: not started yet', last('2026-10-05T09:00', 'day', '2026-10-01T10:00') === null);

// Garbage from sync never throws.
const edge = '+275760-09-13T00:00:00.000Z';
check('a stamp at the end of the Date range: no time due, nothing thrown', REMIND_EVERY.every((e) => dueAt({ remindAt: iso('2026-10-01T09:00'), remindEvery: e, remindedAt: edge }) === null));
check('...nor from an unparsable stamp or anchor', dueAt({ remindAt: iso('2026-10-01T09:00'), remindEvery: 'day', remindedAt: 'nope' }) === iso('2026-10-01T09:00') && dueAt({ remindAt: 'nope', remindEvery: 'day' }) === null && restStamp({ remindAt: 'nope', remindEvery: 'day' }, nowIso) === undefined && onceAt({ remindAt: iso('2026-10-01T09:00'), remindEvery: 'day', remindedAt: edge }, 0) === null);
check('resting: Someday always; Done only when repeating', remindResting({ someday: true }) && remindResting({ remindEvery: 'day', status: 'done' }) && !remindResting({ status: 'done' }) && !remindResting({ remindEvery: 'day', status: 'todo' }));

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
