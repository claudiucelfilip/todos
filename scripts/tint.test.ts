import assert from 'node:assert/strict';
import { BACKGROUNDS, resolveBackground } from '../src/lib/backgrounds';
import { pageTarget, rubberBand } from '../src/lib/phone-paging';
assert.equal(resolveBackground('dark').name, 'Night');
assert.equal(resolveBackground('sky').name, 'Sky');
assert.equal(resolveBackground('system', undefined, true).name, 'Night');
assert.equal(resolveBackground('dark', 'Peach').mode, 'light');
assert.equal(resolveBackground('light', 'unknown' as never).name, 'Leaf');
assert.equal(resolveBackground('light', 'White').name, 'White');
assert.equal(new Set(BACKGROUNDS.map(b => b.name)).size, 9);
assert.equal(pageTarget(1, -330, -.6, 321, 3), 2, 'short same-direction flick advances');
assert.equal(pageTarget(1, -312, .6, 321, 3), 0, 'right flick advances');
assert.equal(pageTarget(1, -330, .6, 321, 3), 1, 'reversed velocity uses projected resting position');
assert.equal(pageTarget(1, -400, 0, 321, 3), 1, 'short slow drag returns');
assert.equal(pageTarget(1, -510, 0, 321, 3), 2, 'long slow drag advances');
assert.equal(pageTarget(0, 80, 1, 321, 3), 0, 'first-page boundary');
assert.equal(pageTarget(2, -900, -2, 321, 3), 2, 'last-page boundary');
assert.equal(pageTarget(0, -1500, -3, 321, 5), 1, 'at most one page');
assert.equal(rubberBand(0, 321), 0);
assert(rubberBand(200, 321) < 200);
assert(rubberBand(10000, 321) < 321 / 2);
console.log('Tint background and phone paging checks passed');
const { readFileSync } = await import('node:fs');
const { runInNewContext } = await import('node:vm');
const startup = readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)![1];
for (const snapshot of [null, { canvas: '#e4ffbf', header: '#70d900' }, { canvas: 'invalid', header: 'url(bad)' }]) {
  const properties: Record<string, string> = {};
  const painted = { style: { background: '', setProperty(k: string, v: string) { properties[k] = v; } } };
  const meta = { content: '' };
  runInNewContext(startup, { localStorage: { getItem: () => JSON.stringify(snapshot) }, navigator: { standalone: false }, document: { documentElement: painted, querySelector: () => meta } });
  const valid = snapshot?.canvas.startsWith('#');
  assert.equal(properties['--page'], valid ? snapshot!.canvas : '#cceeff');
  assert.equal(meta.content, valid ? snapshot!.header : '#007eea');
}
console.log('Studio first paint uses validated cached colors');
const { contrastRatio } = await import('../src/lib/labels');
const blend = (front: number[], back: number[], alpha: number) => back.map((v,i)=>Math.round(front[i]*alpha+v*(1-alpha)));
const rgb = (hex: string) => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
const hex = (color:number[]) => '#'+color.map(v=>v.toString(16).padStart(2,'0')).join('');
const css = readFileSync('src/styles/tint.css', 'utf8');
const token = (mode: string, name: string) => {
 const start=css.indexOf(`[data-theme="tint-${mode}"] {`);
 return css.slice(start,css.indexOf('}',start)).match(new RegExp(`--${name}:([^;]+)`))![1];
};
const rgba = (value: string, palette: typeof BACKGROUNDS[number]['palette'], ink: number[]) => {
 if(value.startsWith('rgba(')) return value.match(/[\d.]+/g)!.map(Number);
 const color=value.includes('--material-tint') ? rgb(palette.light) : value.includes('--theme-shade') ? rgb(palette.shade) : ink;
 return [...color, Number(value.match(/\/\s*([.\d]+)/)![1])];
};
let minimum=21;
for(const bg of BACKGROUNDS){
 const ink=bg.mode === 'light' ? blend(rgb(bg.palette.shade),rgb('#060b08'),.30) : rgb('#ffffff');
 for(const stop of bg.gradient.match(/#[0-9a-f]{6}/g)!){
  const layer=rgba(token(bg.mode,'surface'), bg.palette, ink);
  const card=blend(layer.slice(0,3),rgb(stop),layer[3]);
  const wellLayer=rgba(token(bg.mode,'seg-well'), bg.palette, ink);
  const well=blend(wellLayer.slice(0,3),card,wellLayer[3]);
  for(const [surface,name] of [[card,'placeholder'],[well,'muted']] as [number[],string][]){
   const color=rgba(token(bg.mode,name), bg.palette, ink);
   const ratio=contrastRatio(hex(blend(ink,surface,color[3])),hex(surface));
   minimum=Math.min(minimum,ratio);
   assert(ratio>=4.5, `${bg.name} ${stop} ${name} text contrast ${ratio}`);
  }
 }
}
console.log(`Card hints and well text pass 4.5:1 across all gradient stops (minimum ${minimum.toFixed(2)}:1)`);
