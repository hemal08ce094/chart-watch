# Chart Watch

Tracks where Hemal Modi's apps sit on Apple's App Store top charts (Paid and Free, top 200 per category plus the overall chart) for iPhone, iPad, Apple Watch, Mac and Apple Vision Pro, across 41 storefronts. It also checks app pages for Editors' Choice and "Featured In" stories.

- **Scheduled:** `.github/workflows/scan.yml` runs a full scan every 2 hours, commits `state.json` and `web/status.json`, and publishes `web/` to GitHub Pages: the dashboard (`index.html`) and a compact widget (`widget.html`).
- **Local, live:** `python3 server.py`, then open http://localhost:8787 (widget at `/widget`). It keeps re-scanning and shows progress as it goes.
- **One scan:** `python3 server.py --once` writes `web/status.json` and exits.

A full scan reads about 3,500 pages and takes 45–50 minutes, paced so Apple doesn't rate-limit it. Settings: `DEVELOPER_ID`, `PORT`, `REST_MINUTES` (local mode only).

Today-tab features aren't visible on public pages; App Store Connect → Featuring shows those.
