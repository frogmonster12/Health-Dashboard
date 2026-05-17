# HealthLens — Project Context
*For sharing with Claude or other AI assistants to resume work on this project.*
*Last updated: 2026-05-17 (Fix 1-3: parallel analyze, insight error handling, token cap)*

---

## What it is

HealthLens is a personal health document dashboard. Users drag-and-drop lab reports (blood work PDFs, DEXA scans, CTCA imaging, scale readings) into a browser page. The app extracts structured data, displays trend charts, flags out-of-range values, and exports a PDF report. Everything runs in the browser — no account, no server-side storage, no data retained after page close.

**Live site:** https://health-dashboard.jhs-amarillo.workers.dev
**GitHub:** https://github.com/frogmonster12/Health-Dashboard (public)

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML + CSS + JS, hosted on Cloudflare Pages |
| Backend | Cloudflare Worker (Wrangler 4.x) |
| Default AI parsing | Workers AI — `@cf/meta/llama-3.1-8b-instruct` |
| Optional AI parsing | Gemini Flash (via `gemini-flash-latest` auto-updating alias, direct browser → Gemini API, user's own key) |
| Charts | Chart.js 4.4.1 (cdnjs) |
| PDF export | jsPDF 2.5.1 + html2canvas 1.4.1 (cdnjs) |
| PDF extraction | pdf.js 3.11.174 (cdnjs) |

---

## Hard constraints (must be respected at all times)

1. **Zero persistence** — No localStorage, sessionStorage, cookies, IndexedDB, or server-side storage. Page refresh = total reset. All data lives in JS memory only.
2. **AI is for parsing only** (default path) — The Llama model extracts numbers from text. No summarization, no clinical interpretation. All flagging/trend logic is deterministic JS in `rules.js`.
3. **Gemini API key never touches the Worker** — When the user provides a Gemini key, calls go directly from the browser to the Gemini API. The Cloudflare Worker is completely bypassed.
4. **No auth** — The app is fully stateless.
5. **`logpush: false`** in `wrangler.toml` — Worker never logs request contents.

---

## File structure

```
Health Dashboard build/
├── README.md
├── CONTEXT.md               ← this file
├── PROJECT_STATUS.md        ← feature status and suggestions
├── .gitignore
├── healthlens-worker/
│   ├── wrangler.toml
│   ├── package.json
│   ├── package-lock.json
│   └── src/
│       └── index.js         ← Cloudflare Worker
└── healthlens-frontend/
    ├── index.html
    ├── style.css
    ├── rules.js             ← pure deterministic logic (no DOM, no fetch)
    ├── dashboard.js         ← dashboard view, charts, tab renderers
    ├── gemini.js            ← Gemini API integration (optional)
    ├── exporter.js          ← PDF export (jsPDF + off-screen Chart.js)
    └── app.js               ← state, upload screen, file cards, event wiring
```

---

## Worker API (`healthlens-worker/src/index.js`)

Deployed at `https://healthlens-worker.jhs-amarillo.workers.dev`

| Route | Purpose |
|---|---|
| `POST /analyze` | Accepts `{documentType, textContent, fileName}`, calls Llama 3.1 8B, returns `{ok, data: ExtractedDocument}` |
| `POST /redact` | Pure string swap — replaces PII fields with `[REDACTED]`, no AI |
| `POST /log` | Receives frontend JS errors, logs via `console.log` (view with `npx wrangler tail`) |

**Pre-flight check:** Before calling AI, the Worker tests `textContent` against `/\d+\.?\d*\s*(mg\/dL|g\/dL|...)/i`. If no lab values detected, returns immediately with `extractionWarning` and empty `markers[]`.

**ExtractedDocument schema:**
```javascript
{
  documentType, drawDate, patientName, dob, address, physicianName, facilityName,
  markers: [{ name, value, unit, refLow, refHigh, flag }],
  extractionConfidence, parseWarnings, extractionWarning?, sourceFile?
}
```

---

## Frontend architecture

### State (`app.js`)

```javascript
const state = {
  files: new Map(),       // id → FileEntry
  privacyMode: false,
  exporting: false,
  annotations: {},        // `${normName(name)}::${date}` → string
  geminiKey: '',          // Gemini API key (session only, never stored)
  insightsEnabled: false,
  insights: {},           // tabId → AI insight string
};
const userGoals = {};     // normName(markerName) → goal value (separate from state)
```

**FileEntry shape:**
```javascript
{ id, file, docType, phase, errorMsg, errorPhase, text, base64, result, showManual, testDose, aiDose }
// phase: 'extracting' | 'ready' | 'analyzing' | 'done' | 'error'
```

### Upload screen flow

1. User drops PDF → pdf.js extracts text → card shows "Extracting…"
2. User tags document type → "Analyze Documents" button enables
3. On Analyze: if `state.geminiKey` → call `callGeminiForParse()` in `gemini.js` directly; else → call `POST /analyze` on Worker. Files are analyzed in parallel (chunked in groups of 10 when using Gemini, to stay under the free-tier 15 req/min limit). Each card updates independently as its result arrives.
4. On completion: if any panels have no date → stay on upload with date picker; if all dated → auto-transition to dashboard

### Dashboard tabs

| Tab | Appears when |
|---|---|
| Overview | Always |
| Renal | Any renal marker detected (creatinine, eGFR, BUN, etc.) |
| Lipid | Any lipid marker detected (LDL, HDL, cholesterol, etc.) |
| Hepatic | Any hepatic marker detected (AST, ALT, Alk Phos, etc.) |
| Hormones | Any hormone marker detected (testosterone, estradiol, SHBG, etc.) |
| CBC | Any CBC marker detected (WBC, RBC, Hgb, Hct, etc.) |
| Thyroid | Any thyroid marker detected (TSH, Free T4, Free T3, etc.) |
| Body Comp | DEXA or scale panels present |
| Imaging | CTCA panels present |

### Key functions in `rules.js`

- `flagValue(value, refLow, refHigh)` → `{ status: 'HIGH'|'LOW'|'NORMAL', delta }`
- `getSeverity(delta, markerName?, value?)` → `'critical'|'moderate'|'mild'|'normal'`
  - Uses `MARKER_THRESHOLDS` config for CAC Score (absolute thresholds: mild≥1, moderate≥100, critical≥400)
- `getTrend(valuesArray, markerName)` → `'improving'|'worsening'|'stable'`
  - Uses `LOWER_IS_BETTER` / `HIGHER_IS_BETTER` sets for direction
- `buildSummaryCards(allPanels)` → sorted array of card objects
- `getChartConfig(markerName, dataPoints, options)` → Chart.js v4 config with ref lines and optional goal line

### Gemini integration (`gemini.js`)

- `isValidKeyFormat(key)` → boolean (length ≥ 20)
- `callGeminiForParse(apiKey, docType, textContent, fileName)` → ExtractedDocument (throws on error)
- `generateInsights(panels)` → updates `state.insights` concurrently per tab, triggers `renderActiveTab()` as each arrives. Failed insights render with `.insight-error` styling so the spinner never hangs.

When `state.geminiKey` is set and `state.insightsEnabled` is true:
- Dashboard renders with loading spinners in each tab's insight slot
- `generateInsights()` fires concurrently for all tabs + overview
- Each arriving insight replaces the spinner for that tab

### Goal lines (`userGoals`)

`userGoals` is a module-level object (not inside `state`). Every `.sc-goal-input` reads from and writes to `userGoals[normName(markerName)]`. When one input changes, all same-marker inputs on the page sync automatically. Goal lines appear on charts as green dashed lines.

### Annotation notes

Each data table row has a `✎` button. Clicking opens a modal to add/edit/delete a note. Notes live in `state.annotations` keyed as `${normName(name)}::${date}`. Notes appear in PDF exports as italic lines below the relevant table row.

### PDF export (`exporter.js`)

Structure: cover page → flagged marker cards → overview AI insight (if enabled) → one page per category (AI insight → chart → data table).

Uses programmatic jsPDF drawing for all content. Charts are captured off-screen via `chart.toBase64Image()`. No html2canvas in the main export path.

---

## Document types supported

`blood_work`, `lipid_panel`, `testosterone`, `estradiol`, `thyroid`, `cbc`, `dexa`, `scale`, `ctca`, `metabolic`, `hormones`, `other`

Special behavior:
- **Testosterone** cards show "Test dosage" + "AI (aromatase inhibitor) dosage" fields
- **Estradiol** cards — no dosage fields
- **DEXA** and **scale** feed the Body Comp tab together

---

## Privacy model

| Data | Where it goes |
|---|---|
| Uploaded PDF text | Client-side pdf.js extraction only |
| Extracted text | Sent to Cloudflare Worker `/analyze` (default) OR to Gemini API directly (if key provided) |
| Gemini API key | JS variable in browser tab only — never sent to Worker, never stored |
| Extracted lab data | Lives in `state.files` in JS memory — gone on refresh |
| Redacted PDF | `/redact` endpoint on Worker strips PII fields client-side before export |

---

## Config values (update after deploy)

| File | What to update |
|---|---|
| `healthlens-frontend/app.js` line 4 | `WORKER_URL` |
| `healthlens-worker/src/index.js` line 2 | `ALLOWED_ORIGINS` |
| `healthlens-frontend/index.html` line 41 | Footer GitHub href |
| `README.md` line 5 | Live site URL |

*All currently set to live values for the jhs-amarillo deployment.*

---

## Local development

```powershell
# Terminal 1 — Worker
cd "healthlens-worker"
npm install
npx wrangler dev
# Worker at http://localhost:8787

# Terminal 2 — Frontend (any static server)
cd "healthlens-frontend"
npx serve .
# Frontend at http://localhost:3000
# Set WORKER_URL = 'http://localhost:8787' in app.js line 4
```

Live Worker logs: `cd healthlens-worker && npx wrangler tail`

---

## Known issues / watch list

1. **Missing dates** — Some PDFs don't have machine-readable dates. UI shows a date picker in the done card. Improved prompt searches 20+ date label variants.
2. **AI marker name variation** — Labs use different names for the same marker (e.g. "TESTOSTERONE, TOTAL, MALES (ADULT), IA" vs "Total Testosterone"). `getMarkerReadings` uses partial matching which handles most cases.
3. **Scanned PDFs** — pdf.js can't extract text from image-based PDFs. Clear error shown, no OCR.
4. **Gemini insights in PDF** — Insights are session-only. If the page is refreshed between analysis and export, `state.insights` is empty and no insight blocks appear in the PDF.
5. **Gemini model deprecations** — Google retired 1.5 Flash in early 2026 and 2.0 Flash shuts down June 1, 2026. We use the `gemini-flash-latest` alias to track the current stable model automatically. If parsing starts failing with a 404, check Google's model availability page first before touching any code.
