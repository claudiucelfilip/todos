import { contrastRatio } from '../src/lib/labels';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { studioThemes, studioPatterns, resolveStudioTheme } from '../shared/appearance.mjs';
import { accountStore } from '../shared/accounts.mjs';
import { applyStudioAppearance, tone } from '../src/lib/appearance';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-appearance-'));
try {
  const accounts = accountStore(dir, 'owner');
  const cache = new Map<string, string>();
  const properties = new Map<string, string>();
  const root = { setAttribute(k: string, v: string) { this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v; }, removeAttribute(k: string) { delete this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]; }, dataset: {} as Record<string, string>, style: { background: '', colorScheme: '', setProperty(k: string, v: string) { properties.set(k, v); } } };
  const meta = { setAttribute(_key: string, value: string) { properties.set('meta', value); } };
  Object.assign(globalThis, { document: { documentElement: root, querySelector: () => meta }, localStorage: { getItem: (k: string) => cache.get(k), setItem: (k: string, v: string) => cache.set(k, v) } });
  assert.equal(studioThemes.length, 10);
  assert.equal(studioPatterns.length, 8);
  for (const theme of studioThemes) {
    for (const pattern of studioPatterns) {
      const saved = accounts.preferences('owner', { studioTheme: theme.id, studioPattern: pattern.id });
      applyStudioAppearance(saved);
      assert.equal(root.dataset.material, theme.id);
      assert.equal(root.dataset.pattern, pattern.id);
      assert.equal(properties.get('--studio-accent'), theme.accent);
      assert(contrastRatio(properties.get('--editor-completion-accent')!, theme.editor) >= 4.5);
      assert.equal(properties.get('--studio-pattern-mask'), pattern.mask);
      assert.equal(properties.get('meta'), theme.header);
      const ink = properties.get('--editor-neutral')!.split(' ').map(Number);
      assert(ink.every(c => tone(theme.editor) === 'dark' ? c >= 224 && c <= 255 : c >= 0 && c <= 31));
    }
  }
  const before = accounts.user('owner').preferences;
  assert.deepEqual(accounts.preferences('owner', { studioTheme: 'invalid', studioPattern: 'invalid' }), before);
  assert.deepEqual(accountStore(dir, 'owner').user('owner').preferences, before, 'preferences survive a server restart');
  applyStudioAppearance();
  assert.equal(root.dataset.material, 'ink-pool-blue', 'local cached appearance survives without a query string');
  assert.equal(resolveStudioTheme('sky-lemon').id, 'sky-lemon', 'the saved current theme remains available');
  assert.equal(resolveStudioTheme('aubergine').id, 'violet-chartreuse', 'unpublished theme choices migrate to an available palette');
  root.setAttribute('data-ios-standalone', '');
  applyStudioAppearance({ studioTheme: 'sky-lemon' });
  assert.equal(root.style.background, resolveStudioTheme('sky-lemon').header, 'installed iOS backdrop follows the header');
  root.removeAttribute('data-ios-standalone');
  cache.set('todos:appearance:v1:local', 'null');
  applyStudioAppearance();
  assert.equal(root.dataset.material, 'sky-lemon', 'invalid cache safely falls back');
  console.log('All ten themes and eight patterns apply, persist, and reject invalid preferences');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

const { menuPosition } = await import('../src/lib/menu-position');
Object.assign(globalThis, { window: { innerWidth: 390, innerHeight: 844, visualViewport: null } });
const bottomMenu = menuPosition({ top: 800, bottom: 828, right: 380 }, { width: 280, height: 320 });
assert.equal(bottomMenu.top, 476, 'near-bottom menu opens above its trigger');
assert.equal(bottomMenu.left, 98, 'menu respects the right viewport inset');
const tallMenu = menuPosition({ top: 30, bottom: 58, right: 30 }, { width: 700, height: 1000 });
assert.equal(tallMenu.top, 12);
assert.equal(tallMenu.left, 12);
assert.equal(tallMenu.maxHeight, 820);
assert.equal(tallMenu.overflowY, 'auto');
console.log('Floating menus flip and scroll inside the viewport');
