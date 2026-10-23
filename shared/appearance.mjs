export const studioThemes = [
  { id: 'sky-lemon', name: 'Sky & Lemon', canvas: '#cceeff', header: '#007eea', card: '#e8f8ff', editor: '#f4ff24', accent: '#f4ff24', ink: '#10314c' },
  { id: 'violet-chartreuse', name: 'Violet & Chartreuse', canvas: '#241248', header: '#7738ff', card: '#3b2168', editor: '#cbff00', accent: '#cbff00', ink: '#faf3ff' },
  { id: 'indigo-hot-pink', name: 'Indigo & Hot Pink', canvas: '#17183f', header: '#4d35e9', card: '#29265c', editor: '#ff338f', accent: '#ff338f', ink: '#f5f0ff' },
  { id: 'ice-cherry', name: 'Ice & Cherry', canvas: '#e0f8f5', header: '#bd124c', card: '#f1fffc', editor: '#65e5ce', accent: '#65e5ce', ink: '#173b42' },
  { id: 'black-laser-lime', name: 'Black & Laser Lime', canvas: '#0b1013', header: '#1b272c', card: '#1a242a', editor: '#baff00', accent: '#baff00', ink: '#f1ffef' },
  { id: 'royal-blue-acid-green', name: 'Royal Blue & Acid Green', canvas: '#10245e', header: '#2457ff', card: '#243c83', editor: '#a6ff00', accent: '#a6ff00', ink: '#f2f7ff' },
  { id: 'grape-signal-yellow', name: 'Grape & Signal Yellow', canvas: '#2d124b', header: '#883bd1', card: '#461e68', editor: '#fff000', accent: '#fff000', ink: '#faf1ff' },
  { id: 'lime-deep-violet', name: 'Lime & Deep Violet', canvas: '#e4ffbf', header: '#70d900', card: '#f4ffe0', editor: '#6c25ef', accent: '#6c25ef', ink: '#24441b' },
  { id: 'signal-red-ice', name: 'Signal Red & Ice', canvas: '#e7f5ff', header: '#f1193f', card: '#f8fcff', editor: '#66e4ff', accent: '#66e4ff', ink: '#16354c' },
  { id: 'ink-pool-blue', name: 'Ink & Pool Blue', canvas: '#101a26', header: '#20364f', card: '#1e2d40', editor: '#00bcff', accent: '#00bcff', ink: '#edf7ff' },
];

export const legacyThemeIds = {
  'one-dark': 'ink-pool-blue',
  'hoth': 'sky-lemon',
  'aubergine': 'violet-chartreuse',
  'choco-mint': 'black-laser-lime',
  'gruvbox-light': 'lime-deep-violet',
  'solarized': 'ice-cherry',
};

export const resolveStudioTheme = id => studioThemes.find(theme => theme.id === (legacyThemeIds[id] || id)) || studioThemes[0];

const svgMask = (path, width, height) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${path}" stroke="black" fill="none"/></svg>`)}")`;
export const studioPatterns = [
  { id: 'dots', name: 'Dots', mask: 'radial-gradient(circle,#000 1px,transparent 1px)', size: '12px 12px' },
  { id: 'grid', name: 'Fine grid', mask: 'linear-gradient(#000 1px,transparent 1px),linear-gradient(90deg,#000 1px,transparent 1px)', size: '20px 20px' },
  { id: 'crosses', name: 'Crosses', mask: svgMask('M5 8h6M8 5v6',16,16), size: '16px 16px' },
  { id: 'diagonal', name: 'Diagonal', mask: 'repeating-linear-gradient(135deg,#000 0 1px,transparent 1px 14px)', size: 'auto' },
  { id: 'waves', name: 'Waves', mask: svgMask('M-8 8Q0 0 8 8T24 8T40 8',32,16), size: '32px 16px' },
  { id: 'hexagons', name: 'Hexagons', mask: svgMask('M7 0h14l7 12-7 12H7L0 12z',28,24), size: '28px 24px' },
  { id: 'checker', name: 'Micro checker', mask: 'conic-gradient(#000 25%,transparent 0 50%,#000 0 75%,transparent 0)', size: '8px 8px' },
  { id: 'plain', name: 'Plain', mask: 'none', size: 'auto' },
];
