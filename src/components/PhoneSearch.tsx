// §11.21 phone search: the same rows as the desktop results, replacing the tab content under the field.
import { useStore } from '../hooks/useStore';
import { searchMatches } from '../lib/search';
import type { Card } from '../lib/types';
import { SearchRow, countLine, emptyLine } from './SearchPop';

/** Notes first, then To do, Doing, Done: the order Enter's "first result" follows. */
export const searchRank = (c: Card) => (c.kind === 'note' ? 0 : c.status === 'todo' ? 1 : c.status === 'doing' ? 2 : 3);

export default function PhoneSearch({
  query,
  onOpen,
}: {
  query: string;
  onOpen(id: string): void;
}) {
  const store = useStore();
  const matched = query.trim()
    ? store.cards.filter((c) => !c.archivedAt && searchMatches(c, query, store.labels)).sort((a, b) => searchRank(a) - searchRank(b))
    : [];
  return (
    <section className="phone-search-layer" aria-label="Search results" role="listbox">
      {!query.trim() ? null : matched.length ? (
        <>
          <p className="mono search-pop-count">{countLine(matched.length, query)}</p>
          <div className="phone-search-results">{matched.map((c, i) => (
            <SearchRow key={c.id} card={c} query={query} on={i === 0} onPick={onOpen} />
          ))}</div>
        </>
      ) : (
        <p className="phone-search-empty">{emptyLine(query)}</p>
      )}
    </section>
  );
}
