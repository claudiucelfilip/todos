import { boardColumns, DEFAULT_BOARD_LABELS } from './lib/board-columns';
import { isQuiet, quietFor } from './lib/seen';
import { displayTitle } from '../shared/notes.mjs';
import PhoneSearch from './components/PhoneSearch';
import { useCallback, useEffect, useRef, useState } from 'react';
import { actions, isReadOnly, useStore } from './hooks/useStore';
import { applyTheme, useSystemThemeObserver } from './hooks/useTheme';
import { usePhone } from './hooks/useLayout';
import { useKeyboardInset } from './hooks/useKeyboardInset';
import { useKeyboardNav } from './hooks/useKeyboardNav';
import { installKanbanAPI } from './lib/kanban-api';
import { nonceSeen, parseIntent, type Intent } from './lib/intents';
import { copy } from './lib/copy';
import { bootSync, sync, useSyncStatus } from './lib/sync-boot';
import { uploads } from './lib/uploads';
import { currentAccount, currentRoom } from './lib/account';
import LoginScreen from './components/LoginScreen';
import { UnsharedScreen } from './components/ReadOnly';
import { guardKanbanAPI } from './lib/readonly';
import type { Card, CardStatus } from './lib/types';
import Board from './components/Board';
import Composer from './components/Composer';
import NotesView from './components/NotesView';
import PhonePanes from './components/PhonePanes';
import PhoneNotesPane from './components/PhoneNotesPane';
import { usePhoneViewSlide } from './hooks/usePhoneViewSlide';
import type { PhoneColumn } from './components/PhoneNav';
import AssistantPanel from './components/AssistantPanel';
import TopBar from './components/TopBar';
import Banners from './components/Banners';
import InstallCard from './components/InstallCard';
import CardDetailPanel from './components/CardDetailPanel';
import SettingsPanel from './components/SettingsPanel';
import ArchiveView from './components/ArchiveView';
import Toast from './components/Toast';
import ShortcutSheet from './components/ShortcutSheet';
import './styles/labels.css';
import './styles/remind.css';
import './styles/files.css';
import './styles/share.css';
import './styles/board.css';
import './styles/detail.css';
import './styles/chrome.css';
import './styles/app.css';
import './styles/notes.css';
import './styles/material.css';
import './styles/composer.css';

installKanbanAPI();
guardKanbanAPI(); // view-only link: its write methods throw

const COLS: CardStatus[] = ['todo', 'doing', 'done'];
const VERSION_KEY = 'kept.version';
const VIEW_KEY = 'kept.view'; // v5 §1: Board on launch; a switch to Notes lasts the session
const ACTIVE_CARD_KEY = 'kept.phoneCard';
const phoneCardKey = () => `${ACTIVE_CARD_KEY}:${currentAccount()?.user || 'local'}:${currentRoom()?.id || 'personal'}`;
type View = 'board' | 'notes';

function readView(): View {
  try {
    if (/^#\/?notes$/.test(location.hash)) return 'notes';
    return sessionStorage.getItem(VIEW_KEY) === 'notes' ? 'notes' : 'board';
  } catch {
    return 'board';
  }
}

// ---- hash routing: #card/<id> opens a card, #todo|#doing|#done is the phone column ----
function readRoute(): { cardId: string | null; column: string | null } {
  const h = location.hash.replace(/^#\/?/, '');
  const m = h.match(/^card\/([^/?]+)/);
  if (m) return { cardId: decodeURIComponent(m[1]), column: null };
  if (h.startsWith('label/')) return { cardId: null, column: decodeURIComponent(h.slice(6)) };
  if (COLS.includes(h as CardStatus)) return { cardId: null, column: h as CardStatus };
  return { cardId: null, column: null };
}

function writeRoute(
  cardId: string | null,
  column: string,
  phone: boolean,
  push: boolean,
): void {
  const next = cardId ? `#card/${encodeURIComponent(cardId)}` : phone ? (COLS.includes(column as CardStatus) ? `#${column}` : `#label/${encodeURIComponent(column)}`) : '';
  const url = location.pathname + location.search + next;
  if (location.hash === next || (next === '' && location.hash === '')) return;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

/** §14.2 — apply one intent through window.kanban. Returns the affected card id. */
function applyIntent(intent: Intent, setQuery: (q: string) => void): string | null {
  const k = window.kanban;
  if (!k) return null;
  if (isReadOnly() && intent.kind !== 'find') return null; // a view-only link only searches
  if (intent.kind === 'find') {
    setQuery(intent.q);
    window.dispatchEvent(new CustomEvent('kanban:find'));
    return null;
  }
  if (intent.kind === 'pair') {
    // F2/F4: a paired device starts with the shared board — drop a lone local Welcome seed first.
    actions.dropSeed();
    void sync.signIn(intent.token);
    return null;
  }
  if (nonceSeen(intent.nonce)) return null;
  try {
    switch (intent.kind) {
      case 'add': {
        const c = k.addCard(intent.text);
        if (intent.status && intent.status !== c.status) k.setStatus(c.id, intent.status);
        return c.id;
      }
      case 'add-items':
        return k.addItems(resolveTarget(intent.card), intent.text).id;
      case 'check':
        return k.check(resolveTarget(intent.card), intent.items).id;
      case 'uncheck':
        return k.uncheck(resolveTarget(intent.card), intent.items).id;
      case 'status':
        return k.setStatus(resolveTarget(intent.card), intent.status).id;
    }
  } catch (err) {
    actions.showToast((err as Error).message);
  }
  return null;
}

/** Title targeting: ambiguous titles pick the newest non-done card (§14.2). */
function resolveTarget(idOrTitle: string): string {
  const k = window.kanban!;
  const q = idOrTitle.trim().toLowerCase();
  const matches = k.list().filter((c) => c.id === idOrTitle || c.title.trim().toLowerCase() === q);
  if (matches.length <= 1) return idOrTitle;
  const open = matches.filter((c) => c.status !== 'done');
  const pool = open.length ? open : matches;
  pool.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  actions.showToast(`Added to ‘${pool[0].title}’ (${matches.length} cards match)`);
  return pool[0].id;
}

/** Web Share Target (GET) lands in the query string; fold it into the add intent. */
function shareToIntent(): Intent | null {
  const p = new URLSearchParams(location.search);
  const text = [p.get('title'), p.get('text'), p.get('url')]
    .filter((s) => s && s.trim())
    .join('\n');
  if (!text) return null;
  history.replaceState(null, '', location.pathname + location.hash);
  return { kind: 'add', text };
}

/** "Loading…" only when the board takes noticeably long; a normal launch never shows it. */
function DelayedLoading() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 1200);
    return () => clearTimeout(t);
  }, []);
  return show ? <p className="loading mono">Loading…</p> : null;
}

export default function App() {
  const store = useStore();
  const phone = usePhone();
  const syncStatus = useSyncStatus();
  useKeyboardInset();

  const initial = useRef((() => {
    const route = readRoute();
    if (phone && !location.hash && !isReadOnly()) {
      try { route.cardId = localStorage.getItem(phoneCardKey()); } catch { /* storage blocked */ }
    }
    return route;
  })());
  // F2: the load-time intent is read once, synchronously, before any route rewrite can clear the hash.
  const pendingIntent = useRef<Intent | null>(parseIntent(location.hash) ?? shareToIntent());
  const [detailCardId, setDetailCardId] = useState<string | null>(initial.current.cardId);
  const [column, setColumn] = useState<string>(initial.current.column ?? 'todo');
  const [view, setViewState] = useState<View>(readView);
  const viewRef = useRef(view);
  const initialBoard = useRef(false);
  useEffect(() => {
    if (!store.ready || initialBoard.current) return;
    initialBoard.current = true;
    if (viewRef.current === 'board') actions.setLabelFilter(DEFAULT_BOARD_LABELS);
  }, [store.ready]);
  const setView = useCallback((v: View, resetBoard = true) => {
    if (v === 'board' && resetBoard) actions.setLabelFilter(DEFAULT_BOARD_LABELS);
    viewRef.current = v;
    setViewState(v);
    try {
      sessionStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage blocked */
    }
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<string[]>([]); // v6 §5: the parents walked through to the open card
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantFocus, setAssistantFocus] = useState<string | null>(null); // §12.2: the card it is about
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [, tickDay] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  // D4: one history entry per open; switching cards replaces it, so Esc/back always closes.
  const pushed = useRef(false);

  useEffect(() => {
    if (store.ready) applyTheme(store.settings.theme, store.settings.background, store.settings);
  }, [store.ready, store.settings.theme, store.settings.background, store.settings.studioTheme, store.settings.studioPattern]);
  useSystemThemeObserver(() => {
    if (store.ready && !store.settings.background && store.settings.theme === 'system') applyTheme('system', undefined, store.settings);
  });

  const detailCard: Card | null = detailCardId
    ? (store.cards.find((c) => c.id === detailCardId) ?? null)
    : null;

  // iOS can reopen a suspended app at its start URL instead of its last card URL.
  useEffect(() => {
    if (!phone || !store.ready || store.readOnly) return;
    try {
      if (detailCard && !detailCard.draft) localStorage.setItem(phoneCardKey(), detailCard.id);
      else localStorage.removeItem(phoneCardKey());
    } catch { /* storage blocked */ }
  }, [phone, store.ready, store.readOnly, detailCard, detailCardId]);

  // ---- open / close with history entries so back closes the detail (§7.3, §15) ----
  const openCard = useCallback(
    (id: string, _restore = false) => {
      if (detailCardId === id) return;
      if (detailCardId && detailCardId !== id) store.discardBlank(detailCardId);
      setAssistantOpen(false); // §12.1: the assistant and the detail panel share one slot
      if (!detailCardId) returnFocus.current = document.activeElement as HTMLElement | null;
      setCrumbs([]);
      setDetailCardId(id);
      setSelectedId(id);
      const push = !detailCardId && !readRoute().cardId;
      writeRoute(id, column, phone, push);
      if (push) pushed.current = true;
    },
    [column, phone, detailCardId],
  );

  const closeDetail = useCallback(() => {
    if (!detailCardId) return;
    store.discardBlank(detailCardId);
    setDetailCardId(null);
    if (pushed.current && readRoute().cardId) {
      pushed.current = false;
      history.back();
    } else {
      pushed.current = false;
      writeRoute(null, column, phone, false);
    }
  }, [detailCardId, column, phone]);

  // §12.1: opening the assistant replaces the detail panel; a selected or open card becomes its context.
  const openAssistant = (cardId: string | null = selectedId) => {
    setAssistantFocus(cardId && store.cards.some((c) => c.id === cardId) ? cardId : null);
    if (detailCardId) closeDetail();
    setAssistantOpen(true);
  };

  const changeColumn = useCallback(
    (s: string) => {
      setColumn(s);
      if (!detailCardId) writeRoute(null, s, phone, false);
    },
    [detailCardId, phone],
  );

  // Phone order: Board columns, optional archived results, then Notes.
  const [phoneArchived, setPhoneArchived] = useState(false);
  const composerTarget = useRef<string | null>(null);
  const phoneTab = (t: PhoneColumn) => {
    setPhoneArchived(t === 'archived');
    if (t === 'notes') return setView('notes');
    setView('board', false);
    if (t !== 'archived') changeColumn(t);
  };
  const selectedColumns = boardColumns(store.labels, store.labelFilter).map((c) => c.status);
  const boardTabs = selectedColumns.length ? selectedColumns : ['board-empty'];
  const phoneIndex = phoneArchived ? boardTabs.length : Math.max(0, boardTabs.indexOf(column));
  useEffect(() => {
    const id = composerTarget.current;
    if (!id) return;
    const card = store.cards.find((c) => c.id === id);
    if (card?.draft) return;
    composerTarget.current = null;
    if (card && view === 'board' && column !== 'todo') changeColumn('todo');
  }, [store.cards, view, column, changeColumn]);
  const appRef = useRef<HTMLDivElement>(null);
  const viewSlide = usePhoneViewSlide(appRef);
  useEffect(() => {
    if (store.ready && !boardTabs.includes(column)) changeColumn(boardTabs[0]);
  }, [store.ready, store.labelFilter, column]);

  // Back / forward and external hash changes (intents).
  useEffect(() => {
    const onPop = () => {
      const r = readRoute();
      if (!r.cardId) pushed.current = false;
      setDetailCardId(r.cardId);
      if (r.column) setColumn(r.column);
      const intent = parseIntent(location.hash);
      if (intent && store.ready) {
        const id = applyIntent(intent, setQuery);
        writeRoute(id, column, phone, false);
        if (id) setDetailCardId(id);
      }
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
    };
  }, [store.ready, column, phone]);

  // Intents present at load (URL or shared text) apply once the board is ready.
  useEffect(() => {
    if (!store.ready) return;
    bootSync();
    if (!isReadOnly()) void uploads.init(); // files queued offline upload once the device is back
    const intent = pendingIntent.current;
    pendingIntent.current = null;
    if (!intent) {
      writeRoute(detailCardId, column, phone, false);
      return;
    }
    const id = applyIntent(intent, setQuery);
    writeRoute(id, column, phone, false);
    if (id) setDetailCardId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.ready]);

  // A find intent opens the phone search field.
  useEffect(() => {
    const fn = () => {
      if (phone) setSearchOpen(true);
    };
    window.addEventListener('kanban:find', fn);
    return () => window.removeEventListener('kanban:find', fn);
  }, [phone]);

  // Phone column in the URL when the layout flips.
  useEffect(() => {
    if (!detailCardId && !pendingIntent.current) writeRoute(null, column, phone, false);
  }, [phone]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Card was deleted" when the open card vanished through another tab (§15).
  const lastType = useRef('');
  useEffect(() => {
    const fn = (e: Event) => {
      lastType.current = (e as CustomEvent).detail?.type ?? '';
    };
    window.addEventListener('kanban:change', fn);
    return () => window.removeEventListener('kanban:change', fn);
  }, []);
  useEffect(() => {
    if (detailCardId && store.ready && !detailCard) {
      // A deep link can arrive before the first server snapshot fills the cache.
      if (detailCardId === initial.current.cardId && !sync.hasSnapshot) return;
      if (lastType.current === 'reload') actions.showToast(copy.deletedElsewhere());
      setDetailCardId(null);
      writeRoute(null, column, phone, false);
    }
  }, [detailCard, detailCardId, store.ready, column, phone, syncStatus.syncedAt]);

  // §12 live region: announce column moves, deletions and undo availability.
  const statuses = useRef(new Map<string, CardStatus>());
  useEffect(() => {
    const fn = (e: Event) => {
      const d = (e as CustomEvent).detail as { type?: string; card?: Card } | undefined;
      const card = d?.card;
      if (card) {
        const prev = statuses.current.get(card.id);
        if (prev && prev !== card.status)
          setAnnouncement(`${displayTitle(card)} moved to ${label(card.status)}`);
        if (d?.type === 'delete') setAnnouncement(`Deleted ${displayTitle(card)}. Undo available`);
      }
      statuses.current = new Map(
        actions
          .column('todo')
          .concat(actions.column('doing'), actions.column('done'))
          .map((c) => [c.id, c.status]),
      );
    };
    window.addEventListener('kanban:change', fn);
    return () => window.removeEventListener('kanban:change', fn);
  }, []);

  // The desktop detail panel insets from the header (§8); publish its height.
  useEffect(() => {
    const el = document.querySelector('header');
    if (!el) return;
    const set = () =>
      document.documentElement.style.setProperty(
        '--header-h',
        `${el.getBoundingClientRect().height}px`,
      );
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [store.ready, phone]);

  // Relative dates refresh at local midnight (§15).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const arm = () => {
      const now = new Date();
      const next =
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() -
        now.getTime() +
        500;
      t = setTimeout(() => {
        tickDay((v) => v + 1);
        arm();
      }, next);
    };
    arm();
    return () => clearTimeout(t);
  }, []);

  // "Updated to vX" once per new version (§13.1).
  useEffect(() => {
    const seen = localStorage.getItem(VERSION_KEY);
    if (seen && seen !== __APP_VERSION__) {
      window.dispatchEvent(
        new CustomEvent('kanban:updated', { detail: { version: 'v' + __APP_VERSION__ } }),
      );
    }
    localStorage.setItem(VERSION_KEY, __APP_VERSION__);
  }, []);

  // A sync can quiet motion for a moment; the user acting again (a press or a key) brings it back,
  // so their own panel resize or view slide still animates (e2e journey 18).
  useEffect(() => {
    const wake = () => {
      if (isQuiet()) quietFor(0);
    };
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
    return () => {
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('keydown', wake, true);
    };
  }, []);

  const dialogOpen = (assistantOpen && phone) || settingsOpen || archiveOpen || shortcutsOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (!e.shiftKey && e.key.toLowerCase() === 'k' && !phone) {
        // ⌘K finds from any view or focus (the board's keyboard nav only runs on the Board).
        e.preventDefault();
        (document.querySelector('[data-testid=search]') as HTMLInputElement | null)?.focus();
        return;
      }
      if (!e.shiftKey && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        setView(e.key === '1' ? 'board' : 'notes');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, phone]);
  useKeyboardNav({
    enabled: !phone && view === 'board',
    selectedId,
    setSelectedId,
    openCardId: detailCardId,
    openCard,
    closeDetail,
    focusSearch: () =>
      (document.querySelector('[data-testid=search]') as HTMLElement | null)?.focus(),
    showShortcuts: () => setShortcutsOpen(true),
    dialogOpen,
  });

  const goCrumb = (i: number) => {
    const id = crumbs[i];
    setCrumbs(crumbs.slice(0, i));
    setDetailCardId(id);
    setSelectedId(id);
    writeRoute(id, column, phone, false);
  };

  // §11.24.1: one Esc for the whole app, wherever focus is. Order: open menu → focused field (blur)
  // → breadcrumb back → panel → selection. Anything that handled Esc itself calls preventDefault.
  const esc = useRef({ detailCardId, crumbs, selectedId, assistantOpen, dialogOpen, closeDetail, goCrumb });
  esc.current = { detailCardId, crumbs, selectedId, assistantOpen, dialogOpen, closeDetail, goCrumb };
  useEffect(() => {
    let relaying = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.shiftKey || e.defaultPrevented || e.isComposing || relaying) return;
      const s = esc.current;
      if (s.dialogOpen) return; // Settings, Archive and the shortcut sheet close themselves
      // An open menu closes first, even with focus outside it: relay the Esc to the topmost one.
      const floats = Array.from(document.querySelectorAll<HTMLElement>(ESC_FLOATS)).reverse();
      for (const el of floats) {
        const relay = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        relaying = true;
        el.dispatchEvent(relay);
        relaying = false;
        if (relay.defaultPrevented) return e.preventDefault();
      }
      const active = document.activeElement as HTMLElement | null;
      if (isTextField(e.target as Element) || isTextField(active)) {
        if (isTextField(active)) active!.blur();
        return e.preventDefault();
      }
      if (s.detailCardId) {
        e.preventDefault();
        if (s.crumbs.length) s.goCrumb(s.crumbs.length - 1);
        else s.closeDetail();
      } else if (s.assistantOpen) {
        setAssistantOpen(false);
      } else if (s.selectedId) {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Adding a card while searching clears the query (§4.4).
  useEffect(() => {
    const fn = (e: Event) => {
      if ((e as CustomEvent).detail?.type === 'create' && query) setQuery('');
    };
    window.addEventListener('kanban:change', fn);
    return () => window.removeEventListener('kanban:change', fn);
  }, [query]);

  // No session: nothing but the login (the cached board stays hidden until the server answers).
  if (syncStatus.needsLogin) return <LoginScreen />;
  // The view link was turned off: never an editable (empty) board.
  if (syncStatus.unshared) return <UnsharedScreen />;
  // The cached board loads from IndexedDB in a few ms: paint nothing until it is there, so the first
  // frame is the whole board (no empty header rolling its counters, no "Loading…" flash).
  if (!store.ready) return <DelayedLoading />;
  const notes = (
    <NotesView
      query={phone ? query : ''}
      openCardId={detailCard?.id ?? null}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onOpenCard={openCard}
      phone={phone}
      panel={detailCard ? 'open' : 'closed'}
    />
  );
  const board = (
    <Board
      onShowNotes={() => setView('notes')}
      query={phone ? query : ''}
      openCardId={detailCard?.id ?? null}
      detailVisible={!!detailCard}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onOpenCard={openCard}
      phone={phone}
      column={column}
      onColumnChange={changeColumn}
      onOpenArchive={() => setArchiveOpen(true)}
      phoneTab={view === 'notes' ? 'notes' : phoneArchived ? 'archived' : column}
      onPhoneTab={phoneTab}
    />
  );

  return (
    <div
      ref={appRef}
      className={`app${phone ? ' phone' : ' desktop'}`}
      data-detail-open={detailCard ? 'true' : undefined}
      data-view={view}
    >
      <TopBar
        query={query}
        onQueryChange={setQuery}
        onOpenAssistant={() => (assistantOpen ? setAssistantOpen(false) : openAssistant())}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenArchive={() => setArchiveOpen(true)}
        phone={phone}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        view={view}
        onViewChange={setView}
        onOpenCard={openCard}
        assistantOpen={!!assistantOpen && !store.readOnly}
      />
      <Banners />

      {!store.ready ? (
        <DelayedLoading />
      ) : !phone ? (
        // §11.14: both views stay mounted side by side and slide; the hidden one is inert.
        <div className="panes" data-view={view}>
          <div className="panes-track">
            <div className="pane pane-board" {...(view === 'board' ? {} : { inert: '', 'aria-hidden': true })}>
              {board}
            </div>
            <div className="pane pane-notes" {...(view === 'notes' ? {} : { inert: '', 'aria-hidden': true })}>
              {notes}
            </div>
          </div>
        </div>
      ) : (
        <>
          <PhoneNotesPane active={view === 'notes' && !searchOpen} onDrag={(dx) => viewSlide.drag('notes', dx)} onPrevious={(commit, velocity) => viewSlide.release(commit, () => phoneTab(boardTabs[boardTabs.length - 1]), velocity)}>
            {notes}
          </PhoneNotesPane>
          <PhonePanes active={view === 'board' && !searchOpen} index={phoneIndex} onIndex={(i) => phoneTab([...boardTabs, 'archived'][i])} onAfterLastDrag={(dx) => viewSlide.drag('board', dx)} onAfterLastEnd={(commit, velocity) => viewSlide.release(commit, () => phoneTab('notes'), velocity)}>
            {board}
          </PhonePanes>
        </>
      )}

      {!store.readOnly && !detailCard && !assistantOpen && !(phone && searchOpen) && (
        <Composer
          phone={phone}
          view={view}
          column={column}
          onExpand={(card) => {
            composerTarget.current = view === 'board' && ['doing', 'done'].includes(column) ? card.id : null;
            openCard(card.id);
          }}
        />
      )}
      {phone && searchOpen && <PhoneSearch query={query} onOpen={openCard} />}
      {detailCard && (
        <CardDetailPanel
          card={detailCard}
          startAtEnd={!!detailCard.draft}
          phone={phone}
          onClose={closeDetail}
          onOutsideClose={() => {
            store.discardBlank(detailCard.id);
            setDetailCardId(null);
            setSelectedId(null);
            pushed.current = false;
            writeRoute(null, column, phone, false);
          }}
          onAskAssistant={!store.readOnly ? () => openAssistant(detailCard.id) : undefined}
          onOpenCard={(id) => {
                  setCrumbs([]);
            setDetailCardId(id);
            setSelectedId(id);
            writeRoute(id, column, phone, false);
          }}
          crumbs={crumbs}
          onOpenChild={(id) => {
            setCrumbs((c) => [...c, detailCard.id]);
            setDetailCardId(id);
            setSelectedId(id);
            writeRoute(id, column, phone, false);
          }}
          onCrumb={goCrumb}
          returnFocusTo={returnFocus.current}
        />
      )}

      {!store.readOnly && assistantOpen && (
        <AssistantPanel
          phone={phone}
          focusId={assistantFocus}
          onClearFocus={() => setAssistantFocus(null)}
          onClose={() => setAssistantOpen(false)}
          onOpenCard={openCard}
          onReveal={(card) => {
            if (phone && view === 'board' && card.status !== column) changeColumn(card.status);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onOpenArchive={() => {
            setSettingsOpen(false);
            setArchiveOpen(true);
          }}
          phone={phone}
        />
      )}
      {archiveOpen && (
        <ArchiveView
          onClose={() => setArchiveOpen(false)}
          onOpenCard={(id) => {
            setArchiveOpen(false);
            openCard(id);
          }}
          phone={phone}
        />
      )}
      {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}

      <InstallCard />
      <Toast phone={phone} />

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/** Menus and popovers an Esc closes before anything else (§11.24.1). */
const ESC_FLOATS = '.phone-more-menu:not([data-closing]), .dt-menu:not([data-closing]), .label-pop:not([data-closing]), .labels-menu:not([data-closing])';
const isTextField = (el: Element | null) =>
  !!el?.matches?.('textarea, select, [contenteditable="true"], input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=color])');

function label(s: CardStatus): string {
  return s === 'todo' ? 'To do' : s === 'doing' ? 'Doing' : 'Done';
}
