import { useRef, type RefObject } from 'react';
import { PAGE_SPRING } from '../lib/phone-paging';
import { instantMotion } from '../lib/presence';
import { progressVelocity, springKeyframes } from '../lib/spring';

type View = 'board' | 'notes';
type Panes = { app: HTMLDivElement; board: HTMLElement; notes: HTMLElement };

function offset(el: HTMLElement): number {
  const transform = getComputedStyle(el).transform;
  return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
}

export function usePhoneViewSlide(appRef: RefObject<HTMLDivElement | null>) {
  const start = useRef<{ view: View; board: number; notes: number; width: number; els: Panes } | null>(null);
  const settling = useRef<Animation[] | null>(null);
  const panes = (): Panes | null => {
    const app = appRef.current;
    const board = app?.querySelector<HTMLElement>('.phone-panes');
    const notes = app?.querySelector<HTMLElement>('.phone-notes-pane');
    return app && board && notes ? { app, board, notes } : null;
  };
  const drag = (view: View, distance: number) => {
    const els = start.current?.view === view ? start.current.els : panes();
    if (!els) return;
    if (!start.current || start.current.view !== view) {
      const board = offset(els.board), notes = offset(els.notes);
      settling.current?.forEach(animation => animation.cancel());
      settling.current = null;
      start.current = { view, board, notes, width: innerWidth, els };
      els.app.dataset.viewDragging = view;
    }
    const dx = view === 'board' ? Math.max(-start.current.width, Math.min(0, distance)) : Math.min(start.current.width, Math.max(0, distance));
    els.board.style.transform = `translate3d(${Math.round(start.current.board + dx)}px,0,0)`;
    els.notes.style.transform = `translate3d(${Math.round(start.current.notes + dx)}px,0,0)`;
  };
  const release = (commit: boolean, onCommit: () => void, velocity = 0) => {
    const gesture = start.current;
    if (!gesture) return;
    start.current = null;
    const { els, width } = gesture;
    const fromBoard = offset(els.board), fromNotes = offset(els.notes);
    const targetView = commit ? (gesture.view === 'board' ? 'notes' : 'board') : gesture.view;
    const toBoard = targetView === 'board' ? 0 : -width;
    const toNotes = targetView === 'notes' ? 0 : width;
    if (commit) onCommit();
    let boardAnimation: Animation | null = null;
    const finish = () => {
      if (!settling.current || (boardAnimation && settling.current[0] !== boardAnimation)) return;
      settling.current = null;
      delete els.app.dataset.viewDragging;
      els.board.style.removeProperty('transform');
      els.notes.style.removeProperty('transform');
    };
    if (instantMotion() || Math.abs(toBoard - fromBoard) < 1) {
      settling.current = [];
      finish();
      return;
    }
    const v = Math.max(-6, Math.min(6, progressVelocity(velocity * Math.sign(toBoard - fromBoard), toBoard - fromBoard)));
    const spring = { ...PAGE_SPRING, velocity: v };
    const animate = (el: HTMLElement, from: number, to: number) => {
      el.style.transform = `translate3d(${to}px,0,0)`;
      const { keyframes, ms } = springKeyframes(spring, p => ({ transform: `translate3d(${Math.round(from + (to - from) * p)}px,0,0)` }));
      return el.animate(keyframes, { duration: ms, easing: 'linear' });
    };
    boardAnimation = animate(els.board, fromBoard, toBoard);
    const notesAnimation = animate(els.notes, fromNotes, toNotes);
    settling.current = [boardAnimation, notesAnimation];
    boardAnimation.onfinish = finish;
  };
  return { drag, release };
}
