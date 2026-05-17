// gemini.js — AI insights only. Worker handles all parsing.
// The Gemini key is never sent to the Cloudflare Worker, never stored, and
// is cleared on refresh alongside all other session data.
// Load order: after dashboard.js (uses RENAL_SET etc. as globals), before app.js.

// gemini-flash-latest is Google's auto-updating alias for the current stable Flash model.
// Using the alias avoids breakage when Google retires a specific model generation.
// As of 2026-05-17 this resolves to Gemini 3 Flash (5 RPM / 20 RPD free tier).
// The single-call insight design preserves headroom: 1 call/render vs 7-8 previously.
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent';

// ── Key validation (format only — real validation happens on first API call) ───
function isValidKeyFormat(key) {
  return typeof key === 'string' && key.trim().length >= 20;
}

// ── Core fetch with 429 retry ─────────────────────────────────────────────────
// responseSchema: optional Gemini structured-output schema. When provided,
// generationConfig gains responseMimeType:"application/json" + responseSchema,
// constraining the model to emit bare JSON matching the schema at generation time.
async function _geminiCall(apiKey, prompt, maxTokens = 4096, responseSchema = null) {
  const reqBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
  };
  if (responseSchema) {
    reqBody.generationConfig.responseMimeType = 'application/json';
    reqBody.generationConfig.responseSchema   = responseSchema;
  }

  const _fetch = () => fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
  });

  let res = await _fetch();

  // On rate-limit, parse the suggested retry delay and add 0–2 s jitter to prevent
  // synchronized retry storms if multiple sessions all back off at the same time.
  if (res.status === 429) {
    const errBody = await res.json().catch(() => ({}));
    const msg     = errBody?.error?.message ?? '';
    const secs    = parseFloat(msg.match(/retry in (\d+\.?\d*)\s*s/i)?.[1] ?? '35');
    const jitter  = Math.floor(Math.random() * 2000);
    const wait    = Math.min(Math.ceil(secs * 1000) + 1000 + jitter, 70_000);
    await new Promise(r => setTimeout(r, wait));
    res = await _fetch(); // one retry
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = errBody?.error?.message ?? '';

    if (res.status === 404 && /is not found for api version/i.test(msg)) {
      throw new Error(
        'The configured Gemini model is no longer available. Google may have deprecated it. ' +
        'Check gemini.js for the model name.'
      );
    }
    if (res.status === 429 || /quota/i.test(msg)) {
      throw new Error(
        'Gemini API rate limit hit. Free-tier limits vary by current model — check ai.google.dev/pricing.'
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

// ── Insight context builder ───────────────────────────────────────────────────
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

// ── _updateTab ────────────────────────────────────────────────────────────────
// Writes insight text to state.insights and re-renders the active tab if the user
// is currently looking at it. Always writes something — empty/blank text becomes
// an error notice so the loading spinner never hangs.
function _updateTab(tabId, text) {
  const content = (text && text.trim()) ? text.trim() : '⚠ Insight unavailable: empty response';
  state.insights[tabId] = content;
  if (typeof _dash !== 'undefined' && _dash.activeTab === tabId
      && typeof renderActiveTab === 'function') {
    renderActiveTab();
  }
}

// ── generateInsights — exactly ONE Gemini call ────────────────────────────────
// Uses Gemini structured-output mode (responseSchema) so the model emits a single
// JSON object keyed by section. One call per dashboard render keeps free-tier
// headroom large regardless of how many tabs are detected.
async function generateInsights(panels) {
  state.insights = {};

  const tabIds = typeof detectTabs === 'function'
    ? detectTabs(panels).map(t => t.id).filter(id => id !== 'overview')
    : [];

  const sectionKeys = ['overview', ...tabIds];

  // Overview: panel-level summary (no raw marker data needed at this level)
  const overviewSummary = panels.map(p => ({
    type:         p.documentType,
    date:         p.drawDate,
    totalMarkers: (p.markers ?? []).length,
    flagged:      (p.markers ?? [])
      .filter(m => m.flag && m.flag !== null)
      .map(m => ({ name: m.name, value: m.value, unit: m.unit, flag: m.flag })),
  }));

  // Per-tab: marker readings for each detected tab's category set
  const sectionData = Object.fromEntries(
    tabIds.map(id => [id, _markerContext(panels, TAB_SETS[id]?.() ?? null)])
  );

  const tabSections = tabIds.map(id =>
    `${(TAB_NAMES[id] ?? id).toUpperCase()} DATA:\n${JSON.stringify(sectionData[id], null, 2)}`
  ).join('\n\n');

  const prompt = `You are a friendly health data assistant helping a patient understand their lab results.

Write plain-language commentary for each section listed below.

Tone guidelines:
- overview: 1-2 paragraphs. Holistic summary across all uploaded reports. Note what looks healthy and what might be worth discussing with their doctor. Be encouraging. No jargon. End on a positive, empowering note.
- Each tab section: 2-4 sentences. Summarize that section's markers conversationally. Mention any flagged values and whether values are trending better or worse across dates. No medical advice, no clinical jargon. Do not invent values or reference ranges not present in the data.

Required output sections: ${sectionKeys.join(', ')}

OVERVIEW DATA (all reports summary):
${JSON.stringify(overviewSummary, null, 2)}

${tabSections}`;

  // responseSchema forces the model to emit JSON matching this shape at generation
  // time — no markdown fences, no extra prose, every required key guaranteed present.
  const responseSchema = {
    type: 'object',
    properties: Object.fromEntries(sectionKeys.map(k => [k, { type: 'string' }])),
    required: sectionKeys,
  };

  try {
    const raw    = await _geminiCall(state.geminiKey, prompt, 4096, responseSchema);
    const parsed = JSON.parse(raw);
    for (const [key, value] of Object.entries(parsed)) {
      _updateTab(key, value);
    }
  } catch (err) {
    _updateTab('overview', `⚠ Insight unavailable: ${err.message}`);
  }
}
