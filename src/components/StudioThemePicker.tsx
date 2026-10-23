import type { CSSProperties, KeyboardEvent } from 'react';
import { studioThemes, studioPatterns, resolveStudioTheme } from '../../shared/appearance.mjs';
import { useStore } from '../hooks/useStore';
import { surfaceInk, themeCompletionAccents, tone } from '../lib/appearance';

function arrowSelect(event: KeyboardEvent<HTMLButtonElement>, ids: string[], current: string, select: (id: string) => void) {
  const direction = ['ArrowRight','ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 0;
  if (!direction) return;
  event.preventDefault();
  const next = (ids.indexOf(current) + direction + ids.length) % ids.length;
  select(ids[next]);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
}

export default function StudioThemePicker() {
  const { settings, updateSettings } = useStore();
  const theme = resolveStudioTheme(settings.studioTheme || document.documentElement.dataset.material).id;
  const pattern = settings.studioPattern || document.documentElement.dataset.pattern || 'dots';
  const chooseTheme = (id: string) => updateSettings({ studioTheme: id, studioPattern: pattern });
  const choosePattern = (id: string) => updateSettings({ studioTheme: theme, studioPattern: id });
  return <section className="settings-group studio-appearance" aria-label="Appearance">
    <h3>Themes</h3>
    <div className="studio-theme-options" role="radiogroup" aria-label="Theme">
      {studioThemes.map(t => { const accent = themeCompletionAccents(t); return <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} tabIndex={theme === t.id ? 0 : -1} aria-label={t.name} onClick={() => chooseTheme(t.id)} onKeyDown={e => arrowSelect(e,studioThemes.map(t => t.id),theme,chooseTheme)}>
        <span className="studio-mini" aria-hidden="true" style={{ '--mini-canvas': t.canvas, '--mini-header': t.header, '--mini-card': t.card, '--mini-editor': t.editor, '--mini-paint-blend': tone(t.canvas) === 'dark' ? 'plus-lighter' : 'multiply', '--mini-paint-strength': tone(t.canvas) === 'dark' ? 'var(--glass-paint-dark)' : 'var(--glass-paint-light)', '--mini-ink': `rgb(${surfaceInk(t.canvas)})`, '--mini-neutral': surfaceInk(t.canvas), '--mini-header-neutral': surfaceInk(t.header), '--mini-editor-neutral': surfaceInk(t.editor), '--mini-completion': accent.board, '--mini-editor-completion': accent.editor } as CSSProperties}>
          <span className="studio-mini-bar"><i/><i/><i/></span>
          <span className="studio-mini-cards">{['todo','doing','done','done','todo','doing'].map((state, i) => <i key={i}>
            <span className={`mini-state ${state}`}>{state === 'done' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m5 12 5 5 9-10" /></svg>}</span>
            <span className="mini-title"/><span className="mini-copy"/><span className="mini-foot"/>
          </i>)}</span>
          <span className="studio-mini-editor"><span className="mini-editor-top"><i/><i/></span><span className="mini-editor-title"/><span className="mini-editor-chips"><i/><i/><i/></span><span className="mini-editor-body"><i/><i/></span><span className="mini-editor-check"/><span className="mini-editor-footer"/></span>
        </span>
        <span className="studio-theme-name">{t.name}<span aria-hidden="true">{theme === t.id ? '✓' : ''}</span></span>
      </button>; })}
    </div>
    <h3>Pattern</h3>
    <div className="studio-pattern-options" role="radiogroup" aria-label="Pattern">
      {studioPatterns.map(p => <button key={p.id} type="button" role="radio" aria-checked={pattern === p.id} tabIndex={pattern === p.id ? 0 : -1} aria-label={p.name} onClick={() => choosePattern(p.id)} onKeyDown={e => arrowSelect(e,studioPatterns.map(p => p.id),pattern,choosePattern)}>
        <span className="studio-pattern-sample" aria-hidden="true" style={{ '--studio-pattern-mask': p.mask, '--studio-pattern-size': p.size, '--sample-opacity': p.id === 'plain' ? 0 : p.id === 'checker' ? .14 : .3 } as CSSProperties}/>
        <span>{p.name}</span>
      </button>)}
    </div>
  </section>;
}
