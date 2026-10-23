# fixtures/sequence.md — scripted acceptance sequence

The §16 validator loads `fixtures/board.json` via `window.kanban` / Import → Replace
**before each grouped scenario below**. Each step is an **action** and the **expected
`window.kanban.list()` output**. `list()` returns `KanbanCardView` — only the fields a
step asserts are shown; unchanged fixture cards are marked `…`. Every user-visible message
must match §15.1 verbatim. Run on **both layouts** (iPhone 12 / Pixel 6a; MacBook Air
1180 + 1440 px). Notation: `[x]` = checked, `` = unchecked; `done[]` / `remaining[]` are
the checked / unchecked item titles.

Fixture board (from `board.json`), the starting `list()`:

```
Renew passport           todo   remaining[p1..p5]   done[]
Idea: weekly review      todo   remaining[]          (plain)
Fix bike brakes          todo   remaining[]          notes:"…"
Read Thinking in Systems doing  remaining[Ch2, Ch3]  done[Ch1]
Groceries                doing  remaining[Bread, Rice, Cereal, Tomatoes, Olive oil]  done[Milk, Eggs]  repeat:true
Plan Lisbon trip         doing  remaining[Find accommodation] done[Book flights]
Book dentist             done   done[]               completedAt
Return library books     done   done[]               completedAt
```

(Groceries: 7 items — Milk + Eggs checked, 2 of 7, per the fixture.)

---

## A. Capture and checklists (§659, 661, 663, 665) — reset to fixture first

**A1.** Type `Milk` in the To-do composer.
- Expected: Add button visible; **no** card added yet.

**A2.** Press `Enter`.
- Expected: **no** card (line break only); composer still focused.

**A3.** Tap **Add** (or ⌘Enter on desktop).
- Expected `list()` (new card, To do, no items):
  ```
  ...
  Milk                 todo   remaining[]  done[]
  ```
  Composer clear and still focused.

**A4.** Reset. Type `Groceries⏎Eggs⏎- Spinach⏎[x] Lemons`, tap **Add**.
- Expected `list()`:
  ```
  Groceries            doing  remaining[Eggs, Spinach]  done[Lemons]
  ```
  Title `Groceries`; items **Eggs, Spinach** (unchecked, top → bottom), **Lemons** checked;
  derived to Doing (1 of 3 checked).

**A5.** Reset. Switch the mode toggle to **Notes** first, then type the same text and **Add**.
- Expected `list()`:
  ```
  Groceries            todo   remaining[]  notes:"Eggs
  - Spinach
  [x] Lemons"
  ```
  Plain card (no items), status stays To do.

**A6.** Pasting three lines inserts text, no cards until **Add**. Whitespace-only `Enter`
creates nothing and shakes the field. (UI assertion, no `list()` change.)

---

## B. Checklist status transitions (§679–685) — reset to fixture first

**B1.** Open **Renew passport** (To do, 0/5 checked). Check **p1**.
- Expected `list()`:
  ```
  Renew passport        doing   remaining[p2..p5]  done[p1]
  ```
  Detail stays open; card moved **To do → Doing**.

**B2.** On the same card, check **p2..p5** (all 5 checked).
- Expected `list()`:
  ```
  Renew passport        done    remaining[]        done[p1..p5]  completedAt<set>
  ```
  Moving to the **last** check sets `completedAt`.

**B3.** Uncheck **p3** on the Done card.
- Expected `list()`:
  ```
  Renew passport        doing   remaining[p3]      done[p1,p2,p4,p5]  completedAt:null
  ```
  Uncheck from Done → **Doing**.

**B4.** Tap **Uncheck all** (or `uncheck('Renew passport', '*')`).
- Expected `list()`:
  ```
  Renew passport        todo    remaining[p1..p5]  done[]           completedAt:null
  ```
  Uncheck all resets the list to **To do**; `completedAt` cleared. (Unchecking the
  remaining items one by one instead leaves the card in **Doing** — it was started, §6.)

**B5.** Reset. Open **Book dentist** (Done, plain). Commit `Eggs⏎` to add an item.
- Expected `list()`:
  ```
  Book dentist          doing   remaining[Eggs]    done[]           completedAt:null
  ```
  Adding an item to a Done checklist card moves it to **Doing** and shows 0/1.

**B6.** Toggle the circle on **Groceries** (Doing): first tap checks **all** → Done; tap
again unchecks **all**.
- Expected after first tap:
  ```
  Groceries             done     remaining[]        done[all 7]
  ```
  After tap:
  ```
  Groceries             todo     remaining[all 7]   done[]
  ```

---

## C. Board operations (§699–709) — reset to fixture first

**C1.** Drag **Renew passport** (plain To do) to **Done**.
- Expected `list()`:
  ```
  Renew passport        done     done[]            completedAt<set>
  ```
  Lands **at the top** of Done (by completion time).

**C2.** Drag a **fully-check**ed checklist card into Doing → **rejected**, springs back,
header shakes (no `list()` change). Drag an **unchecked** one into Doing → **accepted**.

**C3.** Reorder within To do, reload → new order persists. Done cannot be reordered; it is
sorted by completion time.

**C4.** Delete a card → **Undo** toast for 5 s. Expected `list()` omits the card;
**Undo** (or Cmd+Z during the toast) restores card, items, status and position.
Toast copy per §15.1.

**C5.** **Duplicate** `Groceries`.
- Expected `list()` (both, To do):
  ```
  Groceries             todo
  Groceries (copy)      todo    remaining[Milk,Eggs,Bread,Rice,Cereal,Tomatoes,Olive oil]  done[]
  ```
  The copy sits **immediately below the original**, in **To do**, all items **unchecked**.
  Detail switches to the copy. §15.1 copy applies.
  *(Note: the fixture `Groceries` is Doing with repeat:true and 2 checked; its duplicate is a
  fresh To do "Groceries (copy)" with every item unchecked.)*

**C6.** **Copy as text** puts the Markdown form on the clipboard.

---

## D. Retention / archive (§711)

**D1.** Done cards older than the retention setting are archived on launch; an
**`N archived`** link, **Archive view**, **Restore** and **Delete** all work; **Archive all**
has Undo.

---

## E. First-launch seed (§4.5, §866)

**E1.** Fresh storage → board opens with **only** the Welcome card: title `Welcome. Tap me.`;
three unchecked items (`Check this item (it moves to Doing)`,
`Check this one too (all done → Done)`, `Delete this card whenever you like`).
Expected `list()`:
  ```
  Welcome. Tap me.      todo    remaining[3 items]  done[]
  ```
**E2.** Delete the Welcome card. Next launch → **clean empty board, no re-seed**
(`list()` is empty).

---

## F. Repeat card reaching Done (§130)

**F1.** Fully check **Groceries** (repeat:true) so it lands in **Done**.
- Expected `list()`:
  ```
  Groceries             done      remaining[]  done[all 7]
  Groceries             todo      remaining[all 7]  done[]   repeat:true
  ```
  An **unchecked** `repeat:true` copy reappears in **To do**, entering 240 ms after the
  completion pulse.
