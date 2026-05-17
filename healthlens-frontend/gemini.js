// gemini.js — Direct Gemini API integration.
// All calls go from the browser to the Gemini API using the user's own key.
// The key is never sent to the Cloudflare Worker, never stored, and is cleared on refresh.
// Load order: after dashboard.js (uses RENAL_SET etc. as globals), before app.js.

// gemini-flash-latest is Google's auto-updating alias for the current stable Flash model.
// Using the alias instead of a pinned version (e.g. gemini-1.5-flash, gemini-2.0-flash)
// means the app won't break when Google retires a specific model generation.
// Base path v1beta is correct for this alias as of 2026.
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

// ── Key validation (format only — real validation happens on first API call) ───
function isValidKeyFormat(key) {
  return typeof key === 'string' && key.trim().length >= 20;
}

// ── Core fetch with 429 retry ─────────────────────────────────────────────────
async function _geminiCall(apiKey, prompt, maxTokens = 4096) {
  const _fetch = () => fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
    }),
  });

  let res = await _fetch();

  // On rate-limit, parse the suggested retry delay and wait exactly that long
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const msg  = body?.error?.message ?? '';
    const secs = parseFloat(msg.match(/retry in (\d+\.?\d*)\s*s/i)?.[1] ?? '35');
    const wait = Math.min(Math.ceil(secs * 1000) + 1000, 70_000); // cap at 70 s
    await new Promise(r => setTimeout(r, wait));
    res = await _fetch(); // one retry
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message ?? '';

    if (res.status === 404 && /is not found for api version/i.test(msg)) {
      throw new Error(
        'The configured Gemini model is no longer available. Google may have deprecated it. ' +
        'Check gemini.js for the model name.'
      );
    }
    if (res.status === 429 || /quota/i.test(msg)) {
      throw new Error(
        'Gemini API rate limit hit. Free tier is 15 requests/minute and 250/day. ' +
        'Wait a minute and retry, or remove the API key to fall back to the default parser.'
      );
    }
    if (res.status === 400 && /API_KEY_INVALID/i.test(msg)) {
      throw new Error(
        'Gemini API key is invalid or revoked. Check the key in Google AI Studio.'
      );
    }
    throw new Error(`Gemini API error: ${msg || res.status}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ── JSON extraction (mirrors Worker logic) ────────────────────────────────────
function _extractJSON(raw) {
  try { return JSON.parse(raw.trim()); } catch (_) {}
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s !== -1 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) {} }
  return null;
}

// ── Schema normalization (matches Worker's normalizeDocument) ─────────────────
function _normalizeDoc(raw, documentType, fileName) {
  const markers = Array.isArray(raw.markers)
    ? raw.markers.filter(m => m && typeof m === 'object').map(m => ({
        name:     typeof m.name  === 'string'  ? m.name.trim() : String(m.name ?? 'Unknown'),
        value:    typeof m.value === 'number'   ? m.value  : null,
        unit:     typeof m.unit  === 'string'   ? m.unit.trim()  : null,
        refLow:   typeof m.refLow  === 'number' ? m.refLow  : null,
        refHigh:  typeof m.refHigh === 'number' ? m.refHigh : null,
        flag:     ['H','L','HH','LL'].includes(m.flag) ? m.flag : null,
      }))
    : [];

  const VALID = ['blood_work','lipid_panel','testosterone','estradiol','dexa','scale',
                 'ctca','metabolic','cbc','thyroid','hormones','other'];
  return {
    documentType:         VALID.includes(raw.documentType) ? raw.documentType : documentType,
    drawDate:             typeof raw.drawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.drawDate)
                            ? raw.drawDate : null,
    patientName:          typeof raw.patientName   === 'string' ? raw.patientName   : null,
    dob:                  typeof raw.dob            === 'string' ? raw.dob           : null,
    address:              typeof raw.address        === 'string' ? raw.address       : null,
    physicianName:        typeof raw.physicianName  === 'string' ? raw.physicianName : null,
    facilityName:         typeof raw.facilityName   === 'string' ? raw.facilityName  : null,
    markers,
    extractionConfidence: ['high','medium','low'].includes(raw.extractionConfidence)
                            ? raw.extractionConfidence : 'low',
    parseWarnings:        Array.isArray(raw.parseWarnings)
                            ? raw.parseWarnings.filter(w => typeof w === 'string')
                            : [],
    sourceFile:           typeof fileName === 'string' ? fileName : null,
  };
}

// ── Parse prompt (same schema as Worker) ──────────────────────────────────────
function _parsePrompt(documentType, textContent) {
  return `You are a medical data parser. Respond with JSON only — no explanation, no preamble, no markdown, no code fences.

Extract from the document text below. Return exactly this schema:
{
  "documentType": "<blood_work|lipid_panel|testosterone|estradiol|dexa|scale|ctca|metabolic|cbc|thyroid|hormones|other>",
  "drawDate": "<YYYY-MM-DD or null>",
  "patientName": "<string or null>",
  "dob": "<string or null>",
  "address": "<string or null>",
  "physicianName": "<string or null>",
  "facilityName": "<string or null>",
  "markers": [{ "name": "", "value": <number|null>, "unit": "<string|null>", "refLow": <number|null>, "refHigh": <number|null>, "flag": "<H|L|HH|LL|null>" }],
  "extractionConfidence": "<high|medium|low>",
  "parseWarnings": []
}

Rules:
- value must always be a number or null.
- drawDate: search the entire document for Collection Date, Draw Date, Service Date, etc. Format as YYYY-MM-DD. Use null only if truly absent.
- Do not add markers not explicitly present in the document.
- If no lab values with numeric results are found, return empty markers array. Do not invent values.
- CAC Score unit is "Agatston" if the document does not specify one.

Document type hint: ${documentType}

Document text:
${textContent.slice(0, 8000)}`;
}

// ── Parse via Gemini (returns same shape as callWorker) ───────────────────────
// Throws on error so analyzeFile() can catch it uniformly.
async function callGeminiForParse(apiKey, docType, textContent, fileName) {
  let raw;
  try {
    raw = await _geminiCall(apiKey, _parsePrompt(docType, textContent));
  } catch (err) {
    throw new Error(`Gemini parsing failed: ${err.message}`);
  }

  let parsed = _extractJSON(raw);

  // Retry once with a stricter instruction if first attempt didn't return JSON
  if (!parsed) {
    try {
      const raw2 = await _geminiCall(apiKey,
        `Return ONLY a valid JSON object matching the schema. No text before or after.\n\n${_parsePrompt(docType, textContent)}`
      );
      parsed = _extractJSON(raw2);
    } catch (_) {}
  }

  if (!parsed) {
    throw new Error('Gemini did not return valid JSON after two attempts.');
  }

  return _normalizeDoc(parsed, docType, fileName);
}

// ── Insight context builders ──────────────────────────────────────────────────
function _markerContext(panels, nameSet) {
  if (typeof getMarkerReadings !== 'function') return [];
  const map = getMarkerReadings(panels, nameSet);
  return [...map.values()].map(s => ({
    name:    s.name,
    unit:    s.unit || '',
    refLow:  s.refLow,
    refHigh: s.refHigh,
    readings: s.readings.slice(-6).map(r => ({
      date:  r.date ?? 'unknown',
      value: r.value,
      flag:  flagValue(r.value, s.refLow, s.refHigh).status,
    })),
  }));
}

const TAB_SETS = {
  renal:    () => typeof RENAL_SET    !== 'undefined' ? RENAL_SET    : null,
  lipid:    () => typeof LIPID_SET    !== 'undefined' ? LIPID_SET    : null,
  hepatic:  () => typeof HEPATIC_SET  !== 'undefined' ? HEPATIC_SET  : null,
  hormones: () => typeof HORMONE_SET  !== 'undefined' ? HORMONE_SET  : null,
  cbc:      () => typeof CBC_SET      !== 'undefined' ? CBC_SET      : null,
  thyroid:  () => typeof THYROID_SET  !== 'undefined' ? THYROID_SET  : null,
};

const TAB_NAMES = {
  renal:    'kidney / renal function',
  lipid:    'lipid panel (cholesterol and triglycerides)',
  hepatic:  'liver function (hepatic markers)',
  hormones: 'hormone levels (testosterone and estradiol)',
  cbc:      'complete blood count (CBC)',
  thyroid:  'thyroid function',
  bodycomp: 'body composition (DEXA scan and weight)',
  imaging:  'cardiac imaging (CAC score and coronary findings)',
};

function _tabInsightPrompt(tabId, panels) {
  const nameSet   = TAB_SETS[tabId]?.() ?? null;
  const markers   = _markerContext(panels, nameSet);
  const tabName   = TAB_NAMES[tabId] ?? tabId;

  return `You are a friendly health data assistant helping a patient understand their lab results.

Write a 2-4 sentence plain-language synopsis of the ${tabName} data shown below.
- Be conversational and encouraging.
- Mention any values outside the normal range.
- If multiple dates are present, comment on the trend.
- Do not give medical recommendations. Do not use clinical jargon.
- Do not invent values or reference ranges not shown in the data.

Lab data (JSON):
${JSON.stringify(markers, null, 2)}

Write your synopsis now (2-4 sentences, plain language):`;
}

function _overviewPrompt(panels) {
  const summary = panels.map(p => ({
    type:       p.documentType,
    date:       p.drawDate,
    totalMarkers: (p.markers ?? []).length,
    flagged:    (p.markers ?? []).filter(m => m.flag && m.flag !== null).map(m => ({
      name:  m.name,
      value: m.value,
      unit:  m.unit,
      flag:  m.flag,
    })),
  }));

  return `You are a friendly health data assistant helping a patient understand their health picture.

Write a 1-2 paragraph holistic overview for someone who has uploaded multiple health reports.
- Be encouraging and conversational. Focus on the big picture.
- Acknowledge what looks healthy and any areas that might be worth a conversation with their doctor.
- If trends are visible across dates, mention them.
- Do not give specific medical advice or recommend treatments.
- Do not use clinical jargon. End on a positive, empowering note.

Reports summary (JSON):
${JSON.stringify(summary, null, 2)}

Write your holistic overview (1-2 paragraphs):`;
}

// ── Generate all insights — fires after dashboard renders ─────────────────────
// Updates state.insights as each response arrives and re-renders the active tab.
async function generateInsights(panels) {
  state.insights = {};

  const tabIds = typeof detectTabs === 'function'
    ? detectTabs(panels).map(t => t.id).filter(id => id !== 'overview')
    : [];

  function _updateTab(tabId, text) {
    if (!text) return;
    state.insights[tabId] = text;
    // Re-render only if the user is currently looking at this tab
    if (typeof _dash !== 'undefined' && _dash.activeTab === tabId
        && typeof renderActiveTab === 'function') {
      renderActiveTab();
    }
  }

  const work = [
    _geminiCall(state.geminiKey, _overviewPrompt(panels), 1024)
      .then(t => _updateTab('overview', t.trim()))
      .catch(err => _updateTab('overview', `⚠ Insight unavailable: ${err.message}`)),
    ...tabIds.map(id =>
      _geminiCall(state.geminiKey, _tabInsightPrompt(id, panels), 1024)
        .then(t => _updateTab(id, t.trim()))
        .catch(err => _updateTab(id, `⚠ Insight unavailable: ${err.message}`))
    ),
  ];

  await Promise.allSettled(work);
}
