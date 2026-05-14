# HealthLens — Project Status
*Last updated: 2026-05-13*

---

## What was built (complete)

### Infrastructure
- **Cloudflare Worker** (`healthlens-worker/`) — deployed at `https://healthlens-worker.jhs-amarillo.workers.dev`
  - `POST /analyze` — accepts lab document text, calls Llama 3.1 8B, returns structured JSON. Retries once with a stricter prompt on parse failure.
  - `POST /redact` — pure string swap of PII fields, no AI.
  - `POST /log` — receives frontend JS errors and logs them via `console.log` (viewable with `npx wrangler tail`).
  - Structured logging throughout with `[HL:tag]` format.
  - Wrangler 4.x, Workers AI binding.

- **Cloudflare Pages** — deployed at `https://health-dashboard.jhs-amarillo.workers.dev`
  - Auto-deploys on push to `main` of GitHub repo `frogmonster12/Health-Dashboard`.
  - No build step — plain static files.

- **GitHub** — `https://github.com/frogmonster12/Health-Dashboard` (public)
  - Source of truth. `.gitignore` excludes `.claude/`, `node_modules/`, `.wrangler/`, `.env*`.

---

### Frontend (`healthlens-frontend/`)

#### Files
| File | Purpose |
|---|---|
| `index.html` | Shell — header, main `#view`, footer |
| `style.css` | All styles (~750 lines) — clinical dark-navy theme |
| `app.js` | State, upload screen, file cards, privacy modal, sample data, keyboard shortcuts |
| `rules.js` | Pure deterministic logic — flagging, severity, trend, chart config |
| `dashboard.js` | Dashboard view — tabs, charts, tables, privacy refresh |
| `exporter.js` | PDF export — jsPDF + html2canvas |

#### Upload screen
- Drag-and-drop zone (full-size → compact when files present)
- PDF.js client-side text extraction
- Per-file cards with: doc-type dropdown, status chip, remove button
- Document types: Blood Work / CMP, Lipid Panel, Testosterone, Estradiol (E2), DEXA Scan, Scale / Weight Log, CTCA / Imaging, Other
- **Testosterone** cards show extra dosage fields: "Test dosage" + "AI (aromatase inhibitor) dosage"
- **Estradiol (E2)** cards — no dosage fields
- Error state: Retry button + "Enter manually" button (opens type-specific form)
- Duplicate file warning via `window.confirm`
- When analysis completes: if any panel has no date, stays on upload screen and shows amber date picker in card. Button morphs to "View Dashboard →". If all dates present, auto-transitions.
- "Try with sample data →" button loads 7 demo panels (CMP ×3, Lipid ×3, CTCA ×1) bypassing the Worker.

#### Dashboard
- **Tabs**: Overview · Renal · Lipid · Hepatic · Hormones · Body Comp · Imaging
  - Tabs appear only when data for that category exists.
- **Overview**: Flagged marker cards (red=HIGH, blue=LOW, green=NORMAL) with severity badge and trend arrow.
- **Renal**: Dual-axis chart (Creatinine left, eGFR right) + data table.
- **Lipid**: Multi-line chart (LDL/HDL/Total Chol/Non-HDL) + Triglycerides chart + table.
- **Hepatic**: Multi-line enzymes chart (AST/ALT/Alk Phos) + table.
- **Hormones**: Dual-axis T + E2 chart with teal dashed vertical lines at dates where dosage data was entered. Labels (Test: X · AI: X) appear in dark pill above each line. Protocol on file banner below tabs. + table.
- **CBC**: Dual-axis Hgb/Hct chart + WBC chart + Platelets chart + full CBC table.
- **Thyroid**: TSH chart (amber) + Free T4/T3 multi-line + full thyroid table.
- **Body Comp**: DEXA composition chart + weight trend chart + tables.
- **Imaging**: CAC Score + LVEF stat cards + coronary findings + all markers table.
- Partial extraction notice (amber) shown on tabs when any contributing panel has `extractionConfidence === 'low'`.

#### Privacy
- Toggle in header: "Showing Personal Info" / "Info Hidden"
  - Confirmation modal required when going from hidden → shown.
  - Locked (disabled) during PDF export.
- Redacts: `patientName`, `dob`, `address`, `physicianName`, `facilityName`.
- Dashboard elements use `data-privacy` / `data-original` attributes — toggle triggers DOM swap, no re-render.
- PDF export: if privacy ON, calls `POST /redact` per panel before building PDF.

#### PDF Export
- jsPDF 2.5.1 + html2canvas 1.4.1, both from cdnjs.
- **Structure**: Cover page (header + flagged marker cards via html2canvas) → then one page per category (chart + data table together): Renal · Lipid · Hepatic · Hormones · Body Comp · Imaging · Other.
- Charts rendered off-screen via `chart.toBase64Image()`.
- Flagged marker cards rendered via html2canvas in an off-screen div.
- Table headers repeat on page breaks.
- Footer on every page: "HealthLens · No data is stored. Ever." + page X of Y.
- "source code ↗" link does NOT appear in PDF.

#### Other UX
- View transitions: 180ms fade+slide between upload ↔ dashboard.
- Keyboard shortcuts: `P` = privacy toggle, `E` = export PDF.
- Tooltips on privacy button (below) and export button (above) via `data-tip` CSS.
- Floating **Feedback** button (bottom-right) opens modal → composes mailto to `bugs.healthlens@gmail.com`.
- Global JS error handler (`window.onerror` + `window.onunhandledrejection`) ships errors to `/log` via `navigator.sendBeacon`.
- Footer text and link are teal-colored.

#### rules.js
- `flagValue(value, refLow, refHigh)` → `{ status, delta }`
- `getSeverity(delta)` → critical / moderate / mild / normal
- `getTrend(valuesArray, markerName)` → improving / worsening / stable (direction-aware per marker)
- `buildSummaryCards(allPanels)` → sorted flagged marker array
- `getChartConfig(markerName, dataPoints, options)` → Chart.js v4 config with reference range lines

---

## Config values that need updating if re-deploying

| File | Line | What to update |
|---|---|---|
| `healthlens-frontend/app.js` | 4 | `WORKER_URL` — set to deployed Worker URL |
| `healthlens-worker/src/index.js` | 2 | `ALLOWED_ORIGINS` — add Pages URL |
| `healthlens-frontend/index.html` | 41 | Footer GitHub href |
| `README.md` | 5 | Live site URL |

*All four are currently set to the live values for this deployment.*

---

## Known issues / watch list

1. **Dates still sometimes missing** — The Worker prompt was improved to search aggressively for dates (20+ label variants), but some PDFs (particularly scanned or non-standard lab formats) may still return `drawDate: null`. The UI handles this gracefully (user fills in date manually). If this is frequent, consider adding OCR preprocessing or a more targeted date-extraction pass.

2. **Duplicate protocol bar entries** — Deduplication by `(date | testDose | aiDose)` is in place, but if a user enters slightly different capitalisation or spacing for the same dose, both will show.

3. **Image-based PDFs** — pdf.js can't extract text from scanned/image PDFs. The UI shows a clear error message. No OCR is implemented.

4. **AI marker name variation** — Different labs label the same marker differently (e.g. "TESTOSTERONE, TOTAL, MALES (ADULT), IA" vs "Total Testosterone"). `getMarkerReadings` uses partial-match normalization which handles most cases, but the chart may create two separate series if names differ significantly.

5. **Single-panel trend arrows** — When only one document is uploaded, `getTrend` returns `'stable'` (needs ≥2 readings). Trend arrows on Overview cards show `→` which is accurate but could be clearer.

---

## Suggestions for next session

### High value / quick
- [x] **Reference range on multi-line charts** — DONE. Multi-line charts now color each data point red/blue/normal by flag status. Ref range + flag status appear in the hover tooltip for every series.
- [x] **CBC / Thyroid tabs** — DONE. Full tabs with charts, tables, and PDF export. CBC: Hgb/Hct dual-axis, WBC, Platelets. Thyroid: TSH, Free T4/T3.
- [x] **Goal lines on charts** — DONE. Every summary card on the Overview tab has a "Goal" input. Entering a value draws a green dashed goal line on the corresponding chart (all single-marker charts + dual-axis). Goals persist for the session and show in the PDF.
- [ ] **"Optimal" vs "Normal" flagging** — Lab reference ranges are population averages. Many users (especially TRT patients) want to know their values relative to optimal ranges, not just lab normal. Could add a secondary optional range shown in a different color.
- [ ] **Date range filter on dashboard** — When a user has 3+ years of data, a date range slider to focus charts on a specific period would be useful.
- [ ] **Trend arrow direction clarification** — Add a small legend or tooltip explaining that "↗ improving" means the value is trending toward optimal, not necessarily increasing.

### Medium effort
- [ ] **Multiple document upload at once with batch date entry** — Currently, each missing-date card requires individual input. A "Set date for all undated documents" field would be faster.
- [ ] **Mobile export** — jsPDF works on mobile but the result is occasionally misaligned because the off-screen html2canvas div uses fixed pixel widths. A pure-programmatic fallback (no html2canvas) would be more reliable on phones.

### Larger features
- [ ] **Clinician view** — A read-only shareable link that shows the dashboard in privacy-on mode by default, suitable for sending to a doctor. Could be implemented as a URL hash that encodes the panel data (compression + base64) — still no server storage.
- [ ] **Annotation notes** — Let the user add a free-text note to any data point (e.g. "started new medication"). Stored in JS memory alongside the result, included in PDF.
- [ ] **CSV / manual import** — Many users have historical lab data in spreadsheets. A CSV import path that maps columns to the normalized marker format would let them bring in data without re-uploading old PDFs.
- [ ] **AI interpretation toggle** — Currently the AI strictly extracts numbers. An optional "explain this panel" call (clearly labelled "AI summary, not medical advice") could add value for users who want context.

---

## How to resume

1. Read this file first.
2. The live app is at `https://health-dashboard.jhs-amarillo.workers.dev`
3. All source is at `https://github.com/frogmonster12/Health-Dashboard`
4. To watch live Worker logs: `cd healthlens-worker && npx wrangler tail`
5. To run locally: `cd healthlens-frontend && npx serve .` and set `WORKER_URL = 'http://localhost:8787'` in `app.js` line 4, then `cd healthlens-worker && npx wrangler dev` in a second terminal.
