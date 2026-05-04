# Translator App MVP (Offline Prototype)

This is a no-build, offline translator-side prototype for the `translation_mvp` package format.

## What it does

1. Open translation package folder (contains `preview.pdf`, `segments.json`, `translations_template.json`).
2. Show PDF preview and clickable hotspot overlay from `line_rects`.
3. Show searchable/filterable segment list and editor.
4. Keep bidirectional navigation:
   - Click hotspot -> locate segment.
   - Click segment -> jump to page and highlight hotspot.
5. Save outputs together:
   - `translations.json` (includes `manual_hotspots` for import-side placement)
   - `translation_qc_report.txt` (control token consistency check)
   - `ai_manual_handoff.txt` (generated on save time, from marked `manual_handoff.ai_items`)
6. Card-mode quality helpers:
   - Per-card status chip with hover popover (`todo/translated/reviewed/skip`)
   - `Merge Next` / `Unmerge` flow (produces `merge_tail` status for tail rows)
   - Control-token hint bar with `Restore Missing` and `Reset Tokens`
7. Export annotated PDF with translated text overlaid on hotspots (copyable CJK text layer).
8. Manual hotspot creation: draw, move, resize, delete hotspots directly on the PDF preview; hotspots are included in `translations.json` for InDesign import.
9. AI Handoff tab: view and translate Illustrator/embedded asset items that require manual capture.

## Recommended workflow (translator)

1. **Translate normally in Target**
   - Typing valid text switches status to `translated` automatically.
   - Press `Enter` to jump to next row and keep focus in target input.

2. **If one sentence is split by source layout**
   - Click `Merge Next` on the current card.
   - Keep editing only the head card.
   - Tail rows become `merge_tail` (locked) until `Unmerge`.

3. **If you need to reset a row**
   - Click `Reset` (left of status chip).
   - Row goes back to `todo`.
   - If source has control tokens, default tokens are restored in target.

4. **Control token safety**
   - Control tokens are shown in gray in source/target.
   - If tokens are deleted accidentally, use `Restore Deleted` in token hint line.
   - Use `Reset Tokens` to restore default token-only content.

5. **Set final status from status chip popover**
   - `reviewed` is enabled only when target is valid and control tokens pass checks.
   - `merge_tail` is managed by merge actions (not manually selectable).

## Run

1. Open `translator_app/index.html` in a Chromium browser (Edge/Chrome).
2. Click `Open Package Folder`.
3. Select a package folder exported by `translation_mvp/export_translation_package.jsx`.
4. Translate and click `Save Outputs`.
5. This build is strict offline: local PDF.js assets are required before running.

## Automated checks

### In CI (recommended)

This repo includes:

- `npm run lint`: ESLint syntax/basic checks on `translator_app/app.js`
- `npm run test:smoke`: Playwright smoke test for `translator_app/index.html`
- `npm run check`: run both
- Check files location: `test/translator_app_checks/`

GitHub Actions workflow file:

- `.github/workflows/translator-app-check.yml`

### Local with Node.js

1. Install Node.js 20+
2. Run:
   - `cd test/translator_app_checks`
   - `npm install`
   - `npx playwright install --with-deps chromium`
   - `npm run check`

One-command alternative (PowerShell):

- `powershell -ExecutionPolicy Bypass -File test/translator_app_checks/run-checks.ps1`
- Optional: `-SkipInstall` and/or `-SkipBrowserInstall`

### Local without Node.js (Docker)

Run checks inside a Node container:

```bash
docker run --rm -v "$PWD:/work" -w /work/test/translator_app_checks node:20-bullseye bash -lc "npm install && npx playwright install --with-deps chromium && npm run check"
```

## Notes

- This prototype is designed for local/offline use.
- PDF preview now uses `PDF.js` and renders a single page into `<canvas>`.
- Hotspot mapping is tied to the same canvas viewport, so it moves/scales with the rendered page.
- If `segments.json` contains `line_rects_norm`, hotspots use normalized mapping directly (preferred path).
- Top bar supports zoom percentage input (`25`-`400`), and PDF + hotspots scale together.
- Strict offline mode uses local `vendor` files only:
  - required: `vendor/pdf.min.js`
  - optional for `file://`: `vendor/pdf.worker.min.js`
    - required only when served over `http://` / `https://`
  No CDN fallback is used.
- If `pdf.min.js` is missing, the app prompts whether to open download links.
- In `file://` mode, app defaults to PDF.js fake worker (single-thread) for compatibility.
- Hotspot alignment uses page geometry (`document.page_geometries`) when available.
- Old packages without `page_geometries` fall back to content-derived bounds (less precise).
- Source/target editor shows special control chars as visible tokens:
  - `{PAGE_CURRENT}`, `{PAGE_TOTAL}`, `[[CTRL_XXXX]]`
  App converts these tokens back to raw control chars when exporting `translations.json`.
- `merge_tail` rows are treated as merge-managed tails:
  - card input is locked
  - writeback clears tail paragraph content when safe to do so
- Hotspots are merged by merge-head ownership, so merged rows share one hotspot region.
- For production desktop packaging, this UI can be wrapped by Tauri.
