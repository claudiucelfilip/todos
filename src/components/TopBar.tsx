import Rooms from './Rooms';
import { GearIcon, MoreIcon } from './Icons';
import { currentAccount } from '../lib/account';
// §4.1 board header: "Board", mono date, mono counter (+ offline hint), search (§4.4), settings.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useStore } from '../hooks/useStore';
import { useDropdownPresence } from '../hooks/useDropdownPresence';
import { searchMatches } from '../lib/search';
import { LabelFilter } from './Labels';
import { passesNotesFilter } from '../lib/labels';
import SearchPop from './SearchPop';
import { sync, useSyncStatus } from '../lib/sync-boot';
import { offlineHint, type OfflineHint } from '../lib/sync-line';
import { springAnimate } from '../lib/motion';
import { SPRINGS } from '../lib/spring';
import { instantMotion } from '../lib/presence';
import { ViewOnlyPill } from './ReadOnly';

/** "· Offline · 2 waiting" after the counter; fades out on the snappy spring once sync is back. */
function SyncHint() {
  const hint = offlineHint(useSyncStatus());
  const key = hint ? `${hint.kind}|${hint.label}` : '';
  const [shown, setShown] = useState<OfflineHint | null>(hint);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (hint) {
      el?.getAnimations().forEach((a) => a.cancel()); // back offline mid-fade
      setShown(hint);
      return;
    }
    if (!el || instantMotion()) {
      setShown(null);
      return;
    }
    const a = springAnimate(el, SPRINGS.snappy, (p) => ({ opacity: String(1 - p) }));
    a.onfinish = () => setShown(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // Synced is the quiet default: a cloud with a check, the word only in the tooltip.
  if (!shown)
    return (
      <span className="topbar-synced" role="img" aria-label="Synced" title="Synced">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M7 18h10a4 4 0 0 0 .8-7.9A6 6 0 0 0 6.3 9.2 4.5 4.5 0 0 0 7 18z" />
          <path d="m9.5 13.5 2 2 3.5-3.5" />
        </svg>
      </span>
    );
  return (
    <span
      ref={ref}
      className="mono topbar-sync"
      role="status"
      aria-label={shown.aria}
      title={shown.aria}
      data-testid="sync-hint"
      data-kind={shown.kind}
    >
      <span aria-hidden>·</span>
      <svg
        viewBox="0 0 24 24"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M7 18h10a4 4 0 0 0 .8-7.9A6 6 0 0 0 6.3 9.2 4.5 4.5 0 0 0 7 18z" />
        <path d="M3 3l18 18" />
      </svg>
      <span aria-hidden>{shown.label}</span>
    </span>
  );
}

interface Props {
  query: string;
  onQueryChange(q: string): void;
  onOpenAssistant(): void;
  onOpenSettings(): void;
  onOpenArchive(): void;
  phone: boolean;
  searchOpen: boolean;
  onSearchOpenChange(v: boolean): void;
  view?: 'board' | 'notes';
  onViewChange?(v: 'board' | 'notes'): void;
  /** Enter or a click on a search result opens that card. */
  onOpenCard?(id: string): void;
  /** §11.20.7: the sparkle shows the selected look while the assistant is open. */
  assistantOpen?: boolean;
}

const STALE_MS = 3 * 86400000;
export const SEARCH_ROWS = 6; // §11.21: up to six results

export default function TopBar({
  query,
  onQueryChange,
  onOpenAssistant,
  onOpenSettings,
  onOpenArchive,
  phone,
  searchOpen,
  onSearchOpenChange,
  view = 'board',
  onViewChange,
  onOpenCard,
  assistantOpen = false,
}: Props) {
  const store = useStore();
  const { cards, counts, labels, readOnly } = store;
  // §11.11: the Board and Notes each keep their own filter.
  const labelFilter = view === 'notes' ? store.notesFilter : store.labelFilter;
  const setLabelFilter = view === 'notes' ? store.setNotesFilter : store.setLabelFilter;
  const { open } = counts();
  const now = new Date();
  // v5 §1: Notes holds every note and every open to do; Inbox = unlabelled notes.
  const inGrid = cards.filter((c) => !c.archivedAt && !c.draft);
  const gridCount = inGrid.length;
  const shownCount = inGrid.filter((c) => passesNotesFilter(c, store.notesFilter, labels)).length;
  const inbox = cards.filter((c) => !c.archivedAt && c.kind === 'note' && !(c.labels ?? []).length);
  const stale = inbox.filter((c) => now.getTime() - Date.parse(c.createdAt) > STALE_MS).length;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuPresence = useDropdownPresence(menuOpen);
  const barRef = useRef<HTMLElement>(null);
  // Phone ··· menu: any tap outside it closes it; the menu and its Labels sheet are portalled, so they count as inside.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.('.phone-menu-anchor, .phone-more-menu, .labels-menu')) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation(); // Esc closes the menu and nothing under it
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen]);
  const moreAnchor = useRef<HTMLDivElement>(null);
  const syncStatus = useSyncStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  const searchBox = useRef<HTMLDivElement>(null);
  // Results in the phone list's order: notes, then To do, Doing, Done.
  const rank = (c: (typeof cards)[number]) => (c.kind === 'note' ? 0 : c.status === 'todo' ? 1 : c.status === 'doing' ? 2 : 3);
  const results = query.trim()
    ? cards.filter((c) => !c.archivedAt && searchMatches(c, query, labels)).sort((a, b) => rank(a) - rank(b))
    : [];
  const [hit, setHit] = useState(0);
  const [searchFocused, setSearchFocused] = useState(false);
  const searchPresence = useDropdownPresence(searchFocused && !!query.trim());
  const lastSearch = useRef({ query, results });
  if (query.trim()) lastSearch.current = { query, results };
  useEffect(() => setHit(0), [query]);
  const openResult = (id: string) => {
    onOpenCard?.(id);
    if (!phone) inputRef.current?.blur();
  };

  useEffect(() => {
    if (phone && searchOpen) inputRef.current?.focus();
  }, [phone, searchOpen]);

  const search = (
    <div className={`topbar-search${query ? ' active' : ''}`} ref={searchBox}>
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m17.5 17.5 4 4" />
      </svg>
      <input
        ref={inputRef}
        className="search-input"
        type="search"
        placeholder="Search"
        aria-label="Search cards"
        data-testid="search"
        value={query}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => onQueryChange(e.target.value)}
        onFocus={() => setSearchFocused(true)}
        onBlur={() => setSearchFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault(); // closes the results; the panel stays (§11.24.1)
            onQueryChange('');
            (e.target as HTMLInputElement).blur();
            if (phone) onSearchOpenChange(false);
          }
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && results.length && !phone) {
            e.preventDefault();
            const n = Math.min(results.length, SEARCH_ROWS);
            setHit((h) => (h + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            const c = results[Math.min(hit, results.length - 1)];
            if (c) openResult(c.id);
          }
        }}
      />
      {query || (phone && searchOpen) ? (
        <>
          <button
            type="button"
            className="search-clear"
            aria-label="Clear search"
            onClick={() => onQueryChange('')}
          >
            ×
          </button>
        </>
      ) : (
        !phone && <kbd className="mono search-kbd">⌘K</kbd>
      )}
    </div>
  );

  const viewSwitch = onViewChange && (
    <div className="view-switch seg" role="radiogroup" aria-label="View" style={{ ['--n' as string]: 2, ['--i' as string]: view === 'board' ? 0 : 1 }}>
      {(['board', 'notes'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={view === v}
          className={view === v ? 'on' : ''}
          data-testid={`view-${v}`}
          title={v === 'board' ? 'Board · ⌘1' : 'Notes · ⌘2'}
          onClick={() => onViewChange(v)}
        >
          {v === 'board' ? 'Board' : 'Notes'}
          {!phone && v === 'notes' && stale > 0 && (
            <span className="mono view-stale" title={`${stale} in Inbox older than 3 days`}>
              {stale}
            </span>
          )}
        </button>
      ))}
      <span className="seg-thumb" aria-hidden />
    </div>
  );
  const notesTitle = (
    <h1>
      Notes <span>{shownCount === gridCount ? gridCount : `${shownCount} of ${gridCount}`}</span>
    </h1>
  );
  const notesMeta = (
    <span className="topbar-meta">
      {inbox.length > 0 && (
        <span className="mono topbar-counter" title="Unlabelled notes from Siri, the share sheet and the composer">
          {inbox.length} in Inbox
        </span>
      )}
      <SyncHint />
    </span>
  );
  const date = (
    <h1>
      {now.toLocaleDateString('en-GB', { weekday: 'long' })}{' '}
      <span>
        {now.getDate()} {now.toLocaleDateString('en-GB', { month: 'short' })}
      </span>
    </h1>
  );
  const meta = (
    <span className="topbar-meta">
      <span className="mono topbar-counter" data-count="open">
        {open} open
      </span>
      <SyncHint />
    </span>
  );

  return (
    <header
      ref={barRef}
      className={`topbar${phone ? ' topbar-phone' : ''}${phone && searchOpen ? ' search-open' : ''}`}
    >
      <div className="topbar-row">
        {!phone && <Rooms onOpenSettings={onOpenSettings} />}
        {!phone && viewSwitch}
        <div className="topbar-title">
          {phone && currentAccount() ? <Rooms onOpenSettings={onOpenSettings} /> : view === 'notes' ? notesTitle : date}
          {readOnly && <ViewOnlyPill />}
          {!phone && (view === 'notes' ? notesMeta : meta)}
        </div>

        {phone && viewSwitch}
        {!phone && search}
        {!phone && searchPresence.mounted && (
          <SearchPop anchor={searchBox.current} matches={lastSearch.current.results} query={lastSearch.current.query} active={hit} closing={searchPresence.closing} onPick={openResult} onClose={() => setSearchFocused(false)} />
        )}
        {!phone && (
          <LabelFilter
            columnMode={view === 'board'}
            labels={labels}
            active={labelFilter}
            onChange={setLabelFilter}
            phone={false}
            onOpenSettings={onOpenSettings}
          />
        )}

        <div className="topbar-actions">
          {!readOnly && currentAccount() && (
            <button type="button" className={`assistant-launch iconbtn${assistantOpen ? ' on' : ''}`} onClick={onOpenAssistant} aria-label="Open assistant" aria-pressed={assistantOpen} title="Assistant">
              <svg viewBox="0 0 24 24" width={phone ? 18 : 20} height={phone ? 18 : 20} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden><path d="M12 3c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8z" /></svg>
            </button>
          )}
          {phone && (
            <LabelFilter columnMode={view === 'board'} labels={labels} active={labelFilter} onChange={setLabelFilter} phone onOpenSettings={onOpenSettings} />
          )}
          {phone && (
            <button
              type="button"
              className="iconbtn"
              aria-label={searchOpen ? 'Hide search' : 'Search'}
              aria-pressed={searchOpen}
              onClick={() => {
                if (searchOpen) {
                  onQueryChange('');
                  onSearchOpenChange(false);
                  return;
                }
                // iOS opens the keyboard only for a focus inside the tap itself: render the field now, focus it here.
                flushSync(() => onSearchOpenChange(true));
                inputRef.current?.focus();
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m17.5 17.5 4 4" />
              </svg>
            </button>
          )}
          {phone ? (
            <div className="phone-menu-anchor" ref={moreAnchor}>
              <button
                type="button"
                className="iconbtn"
                aria-label="More options"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <MoreIcon />
              </button>
              {menuPresence.mounted && createPortal(
                // Portalled out of the glass bar so the menu's own blur works (§11.12).
                <div className="phone-more-menu" role="menu" data-closing={menuPresence.closing || undefined} aria-hidden={menuPresence.closing || undefined} style={{ top: Math.round((moreAnchor.current?.getBoundingClientRect().bottom ?? 40) + 8) }}>
                  <p className="rooms-menu-date">{now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}</p>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="phone-labels"
                    onClick={() => {
                      // §11.20.4: the menu closes and Labels opens as a bottom sheet (the bar's own Labels control).
                      setMenuOpen(false);
                      barRef.current?.querySelector<HTMLButtonElement>('.topbar-actions > .label-filter [data-testid="label-filter"]')?.click();
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
                      <path d="M3 5h18l-7 8v6l-4 2v-8z" />
                    </svg>
                    {labelFilter.length ? `Labels · ${labelFilter.length}` : 'Labels'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="settings"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenSettings();
                    }}
                  >
                    Settings
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenArchive();
                    }}
                  >
                    Archive
                  </button>
                  {syncStatus.signedIn && !readOnly && (
                    <button type="button" role="menuitem" onClick={() => void sync.signOut()}>
                      Sign out
                    </button>
                  )}
                </div>,
                document.querySelector('.app') ?? document.body,
              )}
            </div>
          ) : (
            <button
              type="button"
              className="iconbtn"
              onClick={onOpenSettings}
              aria-label="Settings"
              title="Settings"
              data-testid="settings"
            >
              <GearIcon />
            </button>
          )}
        </div>
      </div>

      {phone && searchOpen && (
        <div className="topbar-row topbar-row-search">
          {search}
          <button
            type="button"
            className="search-cancel"
            onClick={() => {
              onQueryChange('');
              onSearchOpenChange(false);
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </header>
  );
}
