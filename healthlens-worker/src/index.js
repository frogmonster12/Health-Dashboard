const ALLOWED_ORIGINS = [
  "https://health-dashboard.jhs-amarillo.workers.dev",
];

// During local dev, also allow localhost
const DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

// Max characters of lab text sent to the model.
// Llama 3.1 8B has ~8k token context; ~6000 chars is a safe ceiling.
const MAX_TEXT_CHARS = 6000;

const VALID_DOC_TYPES = [
  "blood_work",
  "lipid_panel",
  "testosterone",
  "estradiol",
  "dexa",
  "scale",
  "ctca",
  "metabolic",
  "cbc",
  "thyroid",
  "hormones",  // legacy — kept for backward compatibility
  "other",
];

// Fields privacy /redact replaces — no AI involved, pure string swap
const REDACT_FIELDS = [
  "patientName",
  "dob",
  "address",
  "physicianName",
  "facilityName",
];

// ─── LOGGING ─────────────────────────────────────────────────────────────────
// Stream live with: cd healthlens-worker && npx wrangler tail
// Logs never contain document text or patient data — only metadata.

function log(tag, msg, extra = {}) {
  const parts = [`[HL:${tag}]`, msg];
  if (Object.keys(extra).length) parts.push(JSON.stringify(extra));
  console.log(parts.join(" "));
}

// ─── CORS ────────────────────────────────────────────────────────────────────

function getAllowedOrigin(requestOrigin) {
  if (!requestOrigin) return null;
  const allowed = [...ALLOWED_ORIGINS, ...DEV_ORIGINS];
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}

function corsHeaders(requestOrigin) {
  const origin = getAllowedOrigin(requestOrigin) ?? ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body, status, requestOrigin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(requestOrigin),
    },
  });
}

function errorResponse(message, status, requestOrigin) {
  return jsonResponse({ ok: false, error: message }, status, requestOrigin);
}

// ─── PROMPT BUILDERS ─────────────────────────────────────────────────────────

function buildSchema() {
  return `{
  "documentType": "<one of: blood_work, lipid_panel, dexa, scale, ctca, metabolic, cbc, thyroid, hormones, other>",
  "drawDate": "<YYYY-MM-DD or null if not found>",
  "patientName": "<string or null>",
  "dob": "<string or null>",
  "address": "<string or null>",
  "physicianName": "<string or null>",
  "facilityName": "<string or null>",
  "markers": [
    {
      "name": "<biomarker name exactly as labeled>",
      "value": <number or null>,
      "unit": "<unit string or null>",
      "refLow": <number or null>,
      "refHigh": <number or null>,
      "flag": "<H, L, HH, LL, or null>"
    }
  ],
  "extractionConfidence": "<high, medium, or low>",
  "parseWarnings": ["<optional list of data quality notes>"]
}`;
}

function buildPrompt(documentType, textContent) {
  return `You are a medical data parser. Your only job is to extract structured data from laboratory and health documents. You must respond with JSON only, no explanation, no preamble, no markdown, no code fences.

Extract the following from the document text below. Do not interpret, summarize, or add clinical opinions. Only extract what is explicitly present in the text.

Required JSON schema:
${buildSchema()}

Rules:
- "value" must always be a number (never a string). If a value cannot be parsed as a number, use null.
- "refLow" and "refHigh" are the lower and upper bounds of the reference range as numbers, or null if not present or not numeric.
- "flag" is H (high), L (low), HH (critically high), LL (critically low), or null. Use what the document states; do not infer.
- "drawDate" is the date the sample was collected or the test was performed. Search the ENTIRE document — headers, footers, table cells, and body — for any of these labels: Collection Date, Draw Date, Date Collected, Date Drawn, Service Date, Date of Service, Specimen Date, Specimen Collection, Report Date, Lab Date, Accession Date, Date of Test, Date Ordered, Date Resulted, Resulted, Received. The date may appear in any format (MM/DD/YYYY, M/D/YY, YYYY-MM-DD, Month D YYYY, etc.) — convert it to YYYY-MM-DD. Use null ONLY if you have exhausted every part of the document and truly cannot find any date.
- "extractionConfidence" is "high" if most values were cleanly parsed, "medium" if some were ambiguous, "low" if the document was difficult to parse.
- If a field is not found in the document, use null.
- Do not add markers that are not explicitly present in the document text.

Document type hint: ${documentType}

Document text:
${textContent}`;
}

function buildStrictPrompt(documentType, textContent) {
  return `Extract laboratory data as JSON. Respond with a single valid JSON object and nothing else — no text before or after, no markdown, no backticks, no explanation.

Schema:
${buildSchema()}

Critical rules:
- Output must begin with { and end with }
- All string values must use double quotes
- Numbers must not be quoted
- Null fields must use the literal null (not "null")
- Do not include any field not listed in the schema

Document type: ${documentType}
Text:
${textContent}`;
}

// ─── AI CALL ─────────────────────────────────────────────────────────────────

async function callAI(env, prompt) {
  const response = await env.AI.run(MODEL, {
    messages: [
      {
        role: "system",
        content:
          "You are a medical data extraction tool. You output only valid JSON. Never add explanations, preamble, markdown formatting, or code fences.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    max_tokens: 2048,
    temperature: 0,
  });

  // Workers AI returns { response: string } for text models
  return response?.response ?? "";
}

// ─── JSON EXTRACTION ─────────────────────────────────────────────────────────

function extractJSON(raw) {
  // Try direct parse first
  try {
    return JSON.parse(raw.trim());
  } catch (_) {
    // no-op, fall through to extraction
  }

  // Strip markdown code fences if present
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch (_) {
    // no-op
  }

  // Find the first { ... } block that parses
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_) {
      // no-op
    }
  }

  return null;
}

// ─── SCHEMA NORMALIZATION ────────────────────────────────────────────────────

function normalizeMarker(m) {
  return {
    name: typeof m.name === "string" ? m.name.trim() : String(m.name ?? "Unknown"),
    value: typeof m.value === "number" ? m.value : null,
    unit: typeof m.unit === "string" ? m.unit.trim() : null,
    refLow: typeof m.refLow === "number" ? m.refLow : null,
    refHigh: typeof m.refHigh === "number" ? m.refHigh : null,
    flag: ["H", "L", "HH", "LL"].includes(m.flag) ? m.flag : null,
  };
}

function normalizeDocument(raw, documentType) {
  const markers = Array.isArray(raw.markers)
    ? raw.markers.filter((m) => m && typeof m === "object").map(normalizeMarker)
    : [];

  return {
    documentType: VALID_DOC_TYPES.includes(raw.documentType)
      ? raw.documentType
      : documentType,
    drawDate: typeof raw.drawDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.drawDate)
      ? raw.drawDate
      : null,
    patientName: typeof raw.patientName === "string" ? raw.patientName : null,
    dob: typeof raw.dob === "string" ? raw.dob : null,
    address: typeof raw.address === "string" ? raw.address : null,
    physicianName: typeof raw.physicianName === "string" ? raw.physicianName : null,
    facilityName: typeof raw.facilityName === "string" ? raw.facilityName : null,
    markers,
    extractionConfidence: ["high", "medium", "low"].includes(raw.extractionConfidence)
      ? raw.extractionConfidence
      : "low",
    parseWarnings: Array.isArray(raw.parseWarnings)
      ? raw.parseWarnings.filter((w) => typeof w === "string")
      : [],
  };
}

// ─── ROUTE: POST /analyze ────────────────────────────────────────────────────

async function handleAnalyze(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    log("analyze", "rejected: bad JSON body");
    return errorResponse("Request body must be valid JSON.", 400, origin);
  }

  const { documentType, textContent, fileName } = body ?? {};

  if (!documentType || typeof documentType !== "string") {
    log("analyze", "rejected: missing documentType");
    return errorResponse("Missing or invalid 'documentType'.", 400, origin);
  }
  if (!textContent || typeof textContent !== "string" || textContent.trim().length === 0) {
    log("analyze", "rejected: missing textContent", { docType: documentType });
    return errorResponse("Missing or empty 'textContent'.", 400, origin);
  }

  const truncated = textContent.slice(0, MAX_TEXT_CHARS);
  const wasTruncated = textContent.length > MAX_TEXT_CHARS;

  log("analyze", "start", {
    docType: documentType,
    file: fileName ?? "(unnamed)",
    textLen: truncated.length,
    truncated: wasTruncated,
  });

  // First attempt
  let raw;
  try {
    raw = await callAI(env, buildPrompt(documentType, truncated));
  } catch (err) {
    log("analyze", "AI call failed (attempt 1)", { error: err.message });
    return errorResponse("AI service unavailable. Please try again.", 503, origin);
  }

  let parsed = extractJSON(raw);

  // Retry once with stricter prompt if first parse failed
  if (!parsed) {
    log("analyze", "attempt 1 parse failed — retrying with strict prompt");
    let retryRaw;
    try {
      retryRaw = await callAI(env, buildStrictPrompt(documentType, truncated));
    } catch (err) {
      log("analyze", "AI call failed (attempt 2)", { error: err.message });
      return errorResponse("AI service unavailable on retry.", 503, origin);
    }
    parsed = extractJSON(retryRaw);
  }

  if (!parsed) {
    log("analyze", "FAILED: no valid JSON after 2 attempts", { docType: documentType });
    return errorResponse(
      "Could not extract structured data from this document. The AI model did not return valid JSON after two attempts.",
      422,
      origin
    );
  }

  const normalized = normalizeDocument(parsed, documentType);

  log("analyze", "success", {
    markers: normalized.markers.length,
    confidence: normalized.extractionConfidence,
    warnings: normalized.parseWarnings.length,
    truncated: wasTruncated,
  });

  if (wasTruncated) {
    normalized.parseWarnings.push(
      `Document was truncated to ${MAX_TEXT_CHARS} characters before analysis.`
    );
  }
  if (fileName) {
    normalized.sourceFile = typeof fileName === "string" ? fileName : null;
  }

  return jsonResponse({ ok: true, data: normalized }, 200, origin);
}

// ─── ROUTE: POST /redact ─────────────────────────────────────────────────────

async function handleRedact(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return errorResponse("Request body must be valid JSON.", 400, origin);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Request body must be a JSON object.", 400, origin);
  }

  // Deep copy so we never mutate the input representation
  const redacted = JSON.parse(JSON.stringify(body));

  for (const field of REDACT_FIELDS) {
    if (redacted[field] !== undefined && redacted[field] !== null) {
      redacted[field] = "[REDACTED]";
    }
  }

  log("redact", "done", { fields: REDACT_FIELDS.length });
  return jsonResponse({ ok: true, data: redacted }, 200, origin);
}

// ─── ROUTE: POST /log ─────────────────────────────────────────────────────────
// Receives unhandled JS errors from the frontend.
// View with: npx wrangler tail

async function handleLog(request, env, origin) {
  let body;
  try { body = await request.json(); } catch (_) { body = {}; }

  // Cap field lengths — never store, just log
  const type    = String(body.type    ?? "error"  ).slice(0, 60);
  const message = String(body.message ?? "(none)"  ).slice(0, 500);
  const source  = String(body.source  ?? ""        ).slice(0, 200);
  const stack   = String(body.stack   ?? ""        ).slice(0, 600);

  log("frontend", type, {
    message,
    source: source || undefined,
    stack:  stack  || undefined,
    line:   body.line ?? undefined,
    ts:     body.ts   ?? undefined,
  });

  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Only POST allowed on API routes
    if (request.method !== "POST") {
      return errorResponse("Method not allowed.", 405, origin);
    }

    if (path === "/analyze") {
      return handleAnalyze(request, env, origin);
    }

    if (path === "/redact") {
      return handleRedact(request, env, origin);
    }

    if (path === "/log") {
      return handleLog(request, env, origin);
    }

    log("router", `404 ${path}`);
    return errorResponse("Not found.", 404, origin);
  },
};
