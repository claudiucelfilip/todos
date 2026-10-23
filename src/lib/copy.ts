// Centralised user-facing copy (§15.1). This is the single source for toast and
// confirmation strings.
//
// "· Undo" is NOT part of the message — <Toast> renders a separate "Undo" button —
// so every undo-capable builder returns the text BEFORE "· Undo". The 21 strings
// below are the verbatim §15.1 table; per §15.1 anything not listed here should be
// added before it ships. Tone: short, plain, no exclamation, sentence case; the
// undo affordance is last.

const plural = (n: number) => (n === 1 ? '' : 's');

export const copy = {
   // --- undo-capable (the <Toast> appends its own "Undo" button) ---
  cardDeleted: (title: string) => `Deleted '${title}'`, // "Deleted 'Groceries' · Undo"
  severalDeleted: (n: number) => `Deleted ${n} card${plural(n)}`, // "Deleted 3 cards · Undo"
  itemRemoved: (item: string) => `Removed '${item}'`, // "Removed 'Eggs' · Undo"
  itemsCleared: (n: number) => `Cleared ${n} item${plural(n)}`, // "Cleared 4 items · Undo"
  archived: (n: number) => `Archived ${n} card${plural(n)}`, // "Archived 6 cards · Undo"
  addItems: (n: number) => `Added ${n} item${plural(n)}`, // "Added N item(s)"; §15.1 "Added 120 items"
  importReplaced: (n: number) => `Replaced board with ${n} card${plural(n)}`, // import → Replace (added wave 4)
  importMerged: (n: number) => `Merged ${n} card${plural(n)}`, // import → Merge (added wave 4)
  checkedAll: (n: number) => `Checked ${n} item${plural(n)}`, // Check all (added fix round 1)
  uncheckedAll: (n: number) => `Unchecked ${n} item${plural(n)}`, // Uncheck all (added fix round 1)
  labelDeleted: (name: string) => `Deleted label '${name}'`, // Settings → Labels → delete (added with labels)
  linkRemoved: (title: string) => `Removed link '${title}'`,
  attachmentRemoved: (name: string) => `Removed '${name}'`, // detail → Attachments → × (added with attachments)
  reminderCleared: () => `Reminder cleared`, // detail → Remind me → × (added with reminders) // detail → Links → remove (added with links)

   // --- status / lifecycle (no undo button) ---
  landedElsewhere: (column: string) => `Added to ${column}`, // "Added to Doing"
  repeatBackInTodo: (title: string) => `${title} is back in To do`, // "Groceries is back in To do"
  checkAllRejected: () => `Uncheck an item to reopen`, // "Doing → check all (rejected)"
  copied: () => `Copied`, // "Copied"

   // --- hard limits / storage failure ---
  titleTrimmed: () => `trimmed to 200 characters`, // "…trimmed to 200 characters"
  itemCap: () => `This list is full (500 items)`, // "Item cap reached"
  storageFailure: () => `Couldn't save changes. Export your board to keep it.`,

   // --- import / sync / backup ---
  corruptRecord: (n: number) => `${n} card${plural(n)} couldn't be read`, // "1 card couldn't be read"
  badImport: () => `That file isn't a board export.`, // "Import failed"
  importPreview: (from: number, to: number) =>
    `Replace current board (${from} cards) with file (${to} cards)?`, // "Import preview"
  backupReminder: (n: number) => `${n} cards and no backup. Export or turn on sync.`, // "Backup reminder"
  syncStalled: (day: string) => `Changes haven't synced since ${day}.`, // "Sync stalled"
  tokenRejected: () => `Token rejected`, // sync token refused by the server (added fix round 2)
  deletedElsewhere: () => `Card was deleted`, // "Another client deleted"

   // --- app lifecycle ---
  installOffer: () => `Install for offline use`, // "Install offered"
  updated: (version: string) => `Updated to ${version}`, // "Updated" — "Updated to v1.2"
};

/** Sign-in and Settings → Sync (added with login). */
export const syncCopy = {
  appName: 'Todos',
  username: 'Username',
  password: 'Password',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  signOut: 'Sign out',
  wrongCredentials: 'Wrong username or password',
  tooManyAttempts: 'Too many attempts. Try again in a few minutes.',
  unreachable: "Can't reach the server. Your board still works offline.",
  sync: 'Sync',
  signedInAs: (user: string) => `Signed in as ${user}`,
  signedInWithToken: 'Signed in on this device',
  synced: (when: string) => `Synced · ${when}`,
  syncing: 'Syncing…',
  offline: 'Offline',
  offlineSince: (when: string) => `Offline · last synced ${when}`,
  waiting: (n: number) => `${n} change${plural(n)} waiting`,
  failing: 'Sync failing',
  failingWith: (message: string) => `Sync failing: ${message}`,
  notSignedIn: 'Not signed in',
  localOnly: 'This device only',
  hintOffline: 'Offline', // top-bar hint after the counter
  hintWaiting: (n: number) => `Offline · ${n} waiting`,
  hintNotSynced: 'Not synced', // a server error while online: the banner has the detail
  hintOfflineAria: "Offline. Changes are saved on this device and will sync when you're back online.",
  hintNotSyncedAria: 'Not synced. Changes are saved on this device and will sync once the server answers.',
};

/** Reminders + notifications (added with reminders). */
export const remindCopy = {
  remindMe: 'Remind me',
  later: 'Later today',
  evening: 'This evening',
  tomorrow: 'Tomorrow 9:00',
  monday: 'Next Monday 9:00',
  pick: 'Pick date & time…',
  set: 'Set',
  clear: 'Clear reminder',
  repeat: 'Repeat',
  every: { '': 'Once', hour: 'Every hour', day: 'Daily', weekday: 'Weekdays', week: 'Weekly', month: 'Monthly' } as Record<string, string>,
  untilDone: 'Repeats until the card is done',
  quiet: 'Repeats until done · quiet 22:00\u2060–\u20608:00', // word joiners: the hours never break across lines
  reminded: (when: string) => `Reminded ${when}`,
  paused: (when: string) => `Paused · ${when}`, // pending reminder on a Someday card
  pausedAria: (when: string) => `Reminder paused, ${when}`,
  missed: (when: string) => `Missed ${when}`, // its time passed while the card was in Someday
  faceAria: (when: string) => `Reminder ${when}`,
  notifications: 'Notifications',
  instructions: 'Install the ntfy app and subscribe to this topic',
  copy: 'Copy',
  open: 'Open in ntfy',
  test: 'Send test',
  testSent: 'Test sent',
  testFailed: "Couldn't send the test",
  unavailable: 'Available once this device syncs with the server',
};

/** The Someday section at the bottom of To do (added with the divider). */
export const somedayCopy = {
  label: 'Someday',
  divider: (n: number) => `Someday · ${n}`,
  dropHint: 'Drag here to park for later',
  moveIn: 'Move to Someday',
  moveOut: 'Move out of Someday',
  show: 'Show Someday',
  hide: 'Hide Someday',
};

/** Card context menu (right-click) and the hover quick action (added with input-aware interactions). */
export const menuCopy = {
  moveTo: (column: string) => `Move to ${column}`,
  remind: 'Remind me',
  delete: 'Delete',
  menuAria: (title: string) => `Actions for ${title}`,
  more: 'More actions',
  quickAria: (action: string, title: string) => `${action}: ${title}`,
};

/** Attachments: the detail section, upload states, the lightbox and the card chip (added with attachments). */
export const attachCopy = {
  title: 'Attachments',
  add: 'Add files',
  drop: 'Drop files to attach',
  uploading: (pct: number) => `Uploading ${pct}%`,
  waiting: 'Waiting for connection',
  failed: 'Upload failed',
  tooLarge: 'Too large (25 MB at most)',
  retry: 'Retry',
  cancel: 'Cancel upload',
  remove: (name: string) => `Remove ${name}`,
  open: 'Open in new tab',
  download: 'Download',
  prev: 'Previous image',
  next: 'Next image',
  close: 'Close',
  count: (n: number) => `${n} attachment${plural(n)}`,
  image: (name: string) => `Image ${name}`,
};

/** Links in checklist items: the ⌘K popover (added with item links). */
export const linkCopy = {
  prompt: 'Link to',
  apply: 'Link',
  onlyWeb: 'Use an https:// or mailto: link',
};

/** Checklist reordering (added with item drag). */
export const itemCopy = {
  handle: (text: string) => `Reorder ${text}`,
  moved: (text: string, pos: number, total: number) => `${text}, moved to ${pos} of ${total}`,
};

/** Phone swipe actions (added with swipe). */
export const swipeCopy = {
  delete: 'Delete',
  start: 'Start',
  done: 'Done',
  reopen: 'Reopen',
  deleteAria: (title: string) => `Delete ${title}`,
  goAria: (action: string, title: string) => `${action}: ${title}`,
  deleteItemAria: (text: string) => `Delete item ${text}`,
};

/** Labels + links UI (added with labels). */
export const labelCopy = {
  labels: 'Labels',
  links: 'Links',
  addLabel: 'Add label',
  newLabel: 'New label',
  newLabelHint: 'Enter or Add creates and applies',
  add: 'Add',
  noLabels: 'No labels yet',
  filter: 'Labels',
  created: (name: string) => `Label '${name}' created`,
  filterAria: (n: number) => (n ? `Label filter, ${n} active` : 'Label filter'),
  clear: 'Clear',
  custom: 'Custom color',
  color: (name: string) => `Color for ${name}`,
  rename: (name: string) => `Rename ${name}`,
  remove: (name: string) => `Delete ${name}`,
  removeLink: (title: string) => `Remove link ${title}`,
  builtIn: 'built-in',
  more: (n: number) => `+${n}`,
  linkCount: (n: number) => `${n} link${plural(n)}`,
  openLink: (title: string) => `Open ${title} in a new tab`,
};

/** The view-only link: Settings → Share (owner) and what a viewer sees (added with sharing). */
/** Settings → Siri: the capture shortcuts for iPhone and Apple Watch. */
export const siriCopy = {
  title: 'Siri',
  explain: 'Say “Hey Siri, update my board”, then say what you want in one sentence: “call the plumber tomorrow at 9”, “add a checklist groceries with milk and eggs”, “add carrots to groceries”, “remind me about the dentist on Friday at 6”, “rename…”, “add a note to…”. Say “add some items to watch movie” and Siri asks which, then you dictate them. “Send to Todos” in the share sheet saves a video, page or link as a card to follow up on. Rename a shortcut in the Shortcuts app to change its phrase.',
  setup: 'Set up Siri',
  install: 'Install',
  installHint: 'Open each on your iPhone (or this Mac): it adds the shortcut to the Shortcuts app and syncs it to your other devices, including the Apple Watch for the Siri ones.',
  renew: 'New shortcuts',
  renewConfirm: 'Make new shortcuts? The ones installed now stop working until you install these.',
  confirmRenew: 'Make new',
  stop: 'Turn off',
  stopConfirm: 'Turn Siri off? The installed shortcuts stop adding todos.',
  confirmStop: 'Turn off',
  cancel: 'Cancel',
  noSigning: 'This server cannot build shortcut files (it needs macOS).',
  unreachable: "Can't reach the server. Siri setup needs a connection.",
  failed: "Couldn't change the Siri setup. Try again.",
  loading: 'Checking…',
};

export const shareCopy = {
  title: 'Share',
  explain: 'Anyone with the link can see the whole board, including notes, links and attachments, and cannot change anything.',
  create: 'Create view-only link',
  urlAria: 'View-only link',
  copy: 'Copy',
  stop: 'Stop sharing',
  stopConfirm: 'Stop sharing? The link stops working for everyone who has it.',
  rotate: 'New link',
  rotateConfirm: 'Make a new link? The current one stops working for everyone who has it.',
  confirmStop: 'Stop sharing',
  confirmRotate: 'Make new link',
  cancel: 'Cancel',
  unreachable: "Can't reach the server. Sharing needs a connection.",
  failed: "Couldn't change sharing. Try again.",
  loading: 'Checking…',
  pill: 'View only',
  pillHint: 'You can look, not change anything.',
  signIn: 'Sign in',
  back: 'Back to the board',
  goneTitle: 'This board is no longer shared',
  goneBody: 'The link was turned off or replaced. Ask the owner for a new one.',
  readOnlyError: 'This board is view only: nothing can be changed',
  emptyTodo: 'Nothing to do.',
};

export type Copy = typeof copy;
