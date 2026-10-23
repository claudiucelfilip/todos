// §15.1 verbatim-copy contract — the 21 builders in src/lib/copy.ts, the single
// source for the toasts + confirmations the store now drives through `copy` (Wave 2
// step 3). The strings must match the handoff spec exactly, including the ASCII
// single quotes around titles. Per §15.1 / step 4, "· Undo" is a SEPARATE <Toast>
// button — the undo-capable builders return the text BEFORE it, so " · Undo" is NOT
// expected here. Run: `npm run test:copy`.
import { copy, syncCopy, swipeCopy, remindCopy } from '../src/lib/copy';

let failures = 0;
const eq = (name: string, actual: string, expected: string) => {
  if (actual === expected) console.log('  ok            ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name +
     '\n       expected: ' + JSON.stringify(expected) +
     '\n       actual:   ' + JSON.stringify(actual));
   }
};

// --- undo-capable (the <Toast> appends its own "Undo" button — no suffix here) ---
eq('cardDeleted', copy.cardDeleted('Groceries'), "Deleted 'Groceries'");
eq('cardDeleted passport', copy.cardDeleted('Renew passport'), "Deleted 'Renew passport'");
eq('severalDeleted 3', copy.severalDeleted(3), 'Deleted 3 cards');
eq('severalDeleted 1', copy.severalDeleted(1), 'Deleted 1 card');
eq('itemRemoved', copy.itemRemoved('Eggs'), "Removed 'Eggs'");
eq('itemsCleared 4', copy.itemsCleared(4), 'Cleared 4 items');
eq('itemsCleared 1', copy.itemsCleared(1), 'Cleared 1 item');
eq('archived 6', copy.archived(6), 'Archived 6 cards');
eq('archived 1', copy.archived(1), 'Archived 1 card');
eq('addItems 1', copy.addItems(1), 'Added 1 item');
eq('addItems 120', copy.addItems(120), 'Added 120 items');

// --- status / lifecycle ---
eq('landedElsewhere', copy.landedElsewhere('Doing'), 'Added to Doing');
eq('repeatBackInTodo', copy.repeatBackInTodo('Groceries'), 'Groceries is back in To do');
eq('checkAllRejected', copy.checkAllRejected(), 'Uncheck an item to reopen');
eq('copied', copy.copied(), 'Copied');

// --- hard limits / storage ---
eq('titleTrimmed', copy.titleTrimmed(), 'trimmed to 200 characters');
eq('itemCap', copy.itemCap(), 'This list is full (500 items)');
eq('storageFailure', copy.storageFailure(), "Couldn't save changes. Export your board to keep it.");

// --- import / sync / backup ---
eq('corruptRecord 1', copy.corruptRecord(1), "1 card couldn't be read");
eq('corruptRecord 3', copy.corruptRecord(3), '3 cards couldn\'t be read');
eq('badImport', copy.badImport(), "That file isn't a board export.");
eq('importPreview', copy.importPreview(4, 12), 'Replace current board (4 cards) with file (12 cards)?');
eq('backupReminder 8', copy.backupReminder(8), '8 cards and no backup. Export or turn on sync.');
eq('syncStalled', copy.syncStalled('yesterday'), "Changes haven't synced since yesterday.");
eq('deletedElsewhere', copy.deletedElsewhere(), 'Card was deleted');

// --- import (added in wave 4; undo-capable) ---
eq('importReplaced 8', copy.importReplaced(8), 'Replaced board with 8 cards');
eq('importReplaced 1', copy.importReplaced(1), 'Replaced board with 1 card');
eq('importMerged 3', copy.importMerged(3), 'Merged 3 cards');
eq('importMerged 1', copy.importMerged(1), 'Merged 1 card');

eq('tokenRejected', copy.tokenRejected(), 'Token rejected');
eq('checkedAll 5', copy.checkedAll(5), 'Checked 5 items');
eq('uncheckedAll 1', copy.uncheckedAll(1), 'Unchecked 1 item');

// --- labels + links (undo-capable) ---
eq('labelDeleted', copy.labelDeleted('Work'), "Deleted label 'Work'");
eq('linkRemoved', copy.linkRemoved('Spec'), "Removed link 'Spec'");

// --- sign-in + sync (added with login) ---
eq('wrongCredentials', syncCopy.wrongCredentials, 'Wrong username or password');
eq('signIn', syncCopy.signIn, 'Sign in');
eq('signOut', syncCopy.signOut, 'Sign out');
eq('signedInAs', syncCopy.signedInAs('demo'), 'Signed in as demo');
eq('synced', syncCopy.synced('2 min ago'), 'Synced · 2 min ago');
eq('waiting 1', syncCopy.waiting(1), '1 change waiting');
eq('failingWith', syncCopy.failingWith('pull failed (500)'), 'Sync failing: pull failed (500)');
eq('offlineSince', syncCopy.offlineSince('2 h ago'), 'Offline · last synced 2 h ago');

// --- phone swipe actions ---
eq('swipe labels', [swipeCopy.start, swipeCopy.done, swipeCopy.reopen, swipeCopy.delete].join('|'), 'Start|Done|Reopen|Delete');
eq('swipe deleteAria', swipeCopy.deleteAria('Groceries'), 'Delete Groceries');
eq('swipe goAria', swipeCopy.goAria('Start', 'Groceries'), 'Start: Groceries');

// --- reminders ---
eq('remind chips', [remindCopy.later, remindCopy.evening, remindCopy.tomorrow, remindCopy.monday, remindCopy.pick].join('|'), 'Later today|This evening|Tomorrow 9:00|Next Monday 9:00|Pick date & time…');
eq('reminded', remindCopy.reminded('Tue 9:00'), 'Reminded Tue 9:00');
eq('reminderCleared', copy.reminderCleared(), 'Reminder cleared');
eq('notify instructions', remindCopy.instructions, 'Install the ntfy app and subscribe to this topic');

// --- app lifecycle ---
eq('installOffer', copy.installOffer(), 'Install for offline use');
eq('updated', copy.updated('v1.2'), 'Updated to v1.2');

// --- top-bar sync hint: status → label (pure) --------------------------------------------
{
  const { offlineHint } = await import('../src/lib/sync-line');
  const base = { signedIn: true, needsLogin: false, user: 'trip', rejected: false, online: true, syncedAt: '2026-09-25T08:00:00.000Z', pending: 0, failingSince: null, lastError: null, syncing: false };
  const label = (over: object) => offlineHint({ ...base, ...over })?.label ?? null;
  eq('hint: synced → none', String(label({})), 'null');
  eq('hint: offline', String(label({ online: false })), 'Offline');
  eq('hint: offline with waiting edits', String(label({ online: false, pending: 2 })), 'Offline · 2 waiting');
  eq('hint: server unreachable (network error) reads offline', String(label({ failingSince: base.syncedAt, lastError: 'Failed to fetch', pending: 1 })), 'Offline · 1 waiting');
  eq('hint: a timeout reads offline', String(label({ failingSince: base.syncedAt, lastError: 'signal timed out' })), 'Offline');
  eq('hint: a real server error (the banner has the detail) → Not synced', String(label({ failingSince: base.syncedAt, lastError: 'push failed (500)', pending: 3 })), 'Not synced');
  eq('hint: pending while online and healthy → none', String(label({ pending: 2 })), 'null');
  eq('hint: not signed in → none', String(label({ signedIn: false, online: false })), 'null');
  eq('hint: token rejected → none (its own message)', String(label({ rejected: true, online: false })), 'null');
  eq('hint: offline aria', offlineHint({ ...base, online: false })!.aria, "Offline. Changes are saved on this device and will sync when you're back online.");
}

if (failures === 0) console.log('\nRESULT: ALL PASS');
else {
  console.log('\nRESULT: ' + failures + ' FAILED');
  process.exit(1);
 }
