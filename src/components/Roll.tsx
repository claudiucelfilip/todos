// §11.6 / §11.7 digit roll: for each changed character the old one slides up
// and out while the new one slides in from below (160 ms). Reduced motion
// swaps instantly (index.css neutralises the transforms).
import { useEffect, useRef, useState } from 'react';
import { isQuiet } from '../lib/seen';

export default function Roll({ value, className }: { value: string | number; className?: string }) {
  const text = String(value);
  const prev = useRef(text);
  const [from, setFrom] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (prev.current === text) return;
    if (isQuiet()) {
      prev.current = text; // a silent board load: show the number, no roll
      return;
    }
    setFrom(prev.current);
    prev.current = text;
    setTick((t) => t + 1);
    const t = setTimeout(() => setFrom(null), 180);
    return () => clearTimeout(t);
  }, [text]);

  const width = Math.max(text.length, from?.length ?? 0);
  const chars = text.padStart(width, ' ');
  const old = (from ?? text).padStart(width, ' ');
  return (
    <span className={`roll ${className ?? ''}`} aria-label={text} data-testid="roll">
      {Array.from(chars).map((ch, i) => {
        const changed = from !== null && old[i] !== ch;
        return (
          <span key={`${i}-${changed ? tick : 'stable'}`} className={`roll-slot${changed ? ' roll-changed' : ''}`} aria-hidden>
            {changed && <span className="roll-old">{old[i] === ' ' ? ' ' : old[i]}</span>}
            <span className="roll-new">{ch === ' ' ? ' ' : ch}</span>
          </span>
        );
      })}
    </span>
  );
}
