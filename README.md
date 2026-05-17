# HealthLens

HealthLens lets you upload blood work, DEXA scans, imaging results, and weight logs and instantly see trend charts, flagged values, and a shareable PDF report. Everything runs directly in your browser — no account, no server, no data ever stored.

**Live site:** https://health-dashboard.jhs-amarillo.workers.dev

**Source:** https://github.com/frogmonster12/Health-Dashboard

---

## Optional: Gemini API Key

HealthLens works without any API key. If you want faster, higher-accuracy parsing and optional AI-generated insights, you can provide a free Gemini API key.

**Without a key:** Documents are parsed by the Cloudflare Worker using Llama 3.1 8B. This is the default experience and works for all document types.

**With a key (parsing only):** PDF text is sent directly from your browser to the Gemini 2.0 Flash API. The Worker is bypassed entirely. The Cloudflare Worker never sees your key.

**With a key + AI Insights enabled:** After all documents are analyzed, Gemini generates a 2–4 sentence plain-language synopsis for each tab (Renal, Lipid, Hepatic, etc.) and a 1–2 paragraph holistic overview. Insights appear inline on the dashboard and in the exported PDF. All insights are labeled "AI-generated analysis" with a disclaimer that they are not medical advice.

**Getting a free key:** Visit [aistudio.google.com](https://aistudio.google.com) → Get API key. The free tier is sufficient for personal use.

**Privacy:** Your API key is stored only as a JavaScript variable in your browser tab. It is never sent to the Cloudflare Worker, never written to localStorage, and disappears when you close or refresh the page — the same as all other data in HealthLens.

---

## Why you can trust this

There is no database behind HealthLens. When you drop a PDF onto the page, the text is sent to a Cloudflare Worker only long enough to pull out numbers — the Worker does not log requests, does not write anything to disk, and discards everything the moment it sends a response back. When you close the tab or refresh, every number you uploaded is gone. The privacy toggle redacts your name, date of birth, and doctor's name from both the screen and any PDF you export, and can call the server to confirm the redaction before exporting.

The "source code ↗" link in the footer points to this repository — the exact code running on the live site. You are welcome to read every line.

---

## Local development

### Frontend

No build step required — it is plain HTML, CSS, and JavaScript.

```bash
# Any static file server works. Example with the npm `serve` package:
cd "healthlens-frontend"
npx serve .
# Open http://localhost:3000
```

While developing locally, point the Worker URL at your local Worker instance:

```js
// healthlens-frontend/app.js  — line 4
const WORKER_URL = 'http://localhost:8787';
```

### Worker

```bash
cd "healthlens-worker"
npm install

# Authenticate with Cloudflare (opens browser once)
npx wrangler login

# Start local dev server (binds Workers AI automatically)
npx wrangler dev
# Worker available at http://localhost:8787
```

---

## Deploy

### 1. Deploy the Worker

```bash
cd "healthlens-worker"
npx wrangler deploy
```

Wrangler prints the deployed URL, e.g. `https://healthlens-worker.your-account.workers.dev`.

Open `healthlens-worker/src/index.js`, add your Cloudflare Pages URL to `ALLOWED_ORIGINS`, then redeploy:

```js
const ALLOWED_ORIGINS = [
  'https://healthlens.pages.dev',      // add your Pages URL here
  'https://your-custom-domain.com',    // optional custom domain
];
```

```bash
npx wrangler deploy
```

### 2. Update the frontend config

In `healthlens-frontend/app.js`, set the Worker URL:

```js
const WORKER_URL = 'https://healthlens-worker.your-account.workers.dev';
```

### 3. Deploy the frontend via Cloudflare Pages

1. The repo is already at https://github.com/frogmonster12/Health-Dashboard
2. In the Cloudflare dashboard → Pages → Create a project → Connect to Git.
3. Set **root directory** to `healthlens-frontend`.
4. Set **build command** to nothing (leave blank).
5. Set **output directory** to `/` (or leave blank).
6. Deploy. Every subsequent push to `main` auto-deploys.

---

## A note on the public repository

This GitHub repository is the exact code running on the live site. Nothing is minified, bundled, or obfuscated before deployment. The Cloudflare Pages build step is intentionally blank — what you see in the repo is what runs in your browser.
