# Product screenshots

[← Product overview](../../README.md)

Captured from a local production build on 22 October 2026 with an isolated demo workspace. All notes and checklists are sample content. No personal boards, accounts, attachments or agent conversations are included.

The desktop captures use a 1440 × 960 viewport; the phone captures use a 402 × 874 viewport. Black & Laser Lime and Ice & Cherry are built-in Todos palettes. The Editorial board is a saved custom flow created through Settings.

To refresh the screenshots from the current source:

```bash
npm ci
npm run build
node scripts/readme-screenshots.mjs
```

The script uses the installed Playwright Chromium browser, starts a temporary server, seeds its sample content, saves eight JPEGs here, and removes the temporary data when finished. It checks that each page fits its viewport and has no uncaught page errors. Capture time and viewport details are recorded in [capture.json](capture.json).

If Chromium is not already installed for Playwright, install it before running the capture:

```bash
./node_modules/.bin/playwright install chromium
```
