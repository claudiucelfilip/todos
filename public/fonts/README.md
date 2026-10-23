# Design fonts

Unmodified WOFF2 files downloaded from the URLs returned by the [Google Fonts stylesheet](https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600&family=JetBrains+Mono:wght@400;500&display=optional) on 2026-10-02. [sources.json](sources.json) records each URL, SHA-256, size and variable axes. All subsets from the existing request are retained.

- [Instrument Sans](https://github.com/google/fonts/tree/main/ofl/instrumentsans): weights 400–700; [SIL Open Font License 1.1](instrument-sans-OFL.txt).
- [Bricolage Grotesque](https://github.com/ateliertriay/bricolage): weights 500–600, optical size 12–96; [SIL Open Font License 1.1](bricolage-grotesque-OFL.txt).
- [JetBrains Mono](https://github.com/jetbrains/jetbrainsmono): weights 400–500; [SIL Open Font License 1.1](jetbrains-mono-OFL.txt).

The font-face declarations use variable files, normal style, the original Unicode subsets and `font-display: swap`. Latin faces are preloaded. Vite copies these assets into the production build; the existing service worker precaches WOFF2 files for offline use.
