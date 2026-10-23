// A row that a swipe already slid off-screen must not get a presence exit (it would be
// re-mounted in place for a frame and then fade: a visible snap-back).
const slid = new Map<string, number>();

export function markSlidOut(id: string): void {
  slid.set(id, Date.now());
}

export function slidOutRecently(id: string): boolean {
  const t = slid.get(id);
  if (t === undefined) return false;
  if (Date.now() - t > 1500) {
    slid.delete(id);
    return false;
  }
  return true;
}
