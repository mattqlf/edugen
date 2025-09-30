// Simple web server for Fly.io: serves index.html and provides /api endpoints.
// Env: PORT, GEMINI_API_KEY, MANIM_SERVICE_URL

import express from 'express';
import cors from 'cors';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Increase JSON limit to accommodate sharing with embedded data URLs
app.use(express.json({ limit: '50mb' }));

// Basic security headers (relaxed CSP to allow inline scripts in index.html)
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"
  );
  next();
});

// CORS: restrict to same-origin by default; loosen if you need cross-origin
app.use(cors({ origin: false }));

// API health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Share API ---
// Accepts a JSON payload containing the current markdown and embedded assets (as data URLs)
// and stores it on disk under SHARE_DIR/<id>.json. Returns a share URL.
// Default SHARE_DIR uses the OS temp directory to ensure write access when running as non-root.
const SHARE_DIR = process.env.SHARE_DIR || path.join(os.tmpdir(), 'edugen-shares');
async function ensureShareDir() {
  try { await fs.mkdir(SHARE_DIR, { recursive: true }); } catch {}
}
function makeId(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function reqBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  return `${proto}://${host}`;
}

app.post('/api/share', async (req, res) => {
  try {
    const { md, images, videos, interactive, sizes } = req.body || {};
    if (typeof md !== 'string') return res.status(400).json({ error: 'Missing `md` (string)' });
    // Basic shape checks; assets are optional
    const payload = {
      md,
      images: images && typeof images === 'object' ? images : {},
      videos: videos && typeof videos === 'object' ? videos : {},
      interactive: interactive && typeof interactive === 'object' ? interactive : {},
      sizes: sizes && typeof sizes === 'object' ? sizes : {},
      createdAt: new Date().toISOString(),
      version: 1,
    };
    await ensureShareDir();
    // Generate unique id; avoid collisions
    let id = makeId(10);
    for (let i = 0; i < 5; i++) {
      try {
        await fs.access(path.join(SHARE_DIR, `${id}.json`));
        id = makeId(10);
      } catch {
        break; // does not exist
      }
    }
    await fs.writeFile(path.join(SHARE_DIR, `${id}.json`), JSON.stringify(payload), 'utf8');
    const url = `${reqBaseUrl(req)}/s/${id}`;
    res.status(200).json({ id, url });
  } catch (e) {
    console.error('share error', e);
    res.status(500).json({ error: 'Failed to create share', details: String(e?.message || e) });
  }
});

// Serves the JSON share payload
app.get('/s/:id.json', async (req, res) => {
  try {
    const file = path.join(SHARE_DIR, `${req.params.id}.json`);
    const data = await fs.readFile(file, 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch (e) {
    res.status(404).json({ error: 'Share not found' });
  }
});

// Server-side Gemini text generation
app.post('/api/gen-text', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing `prompt` (string)' });
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Server misconfigured: GEMINI_API_KEY not set' });

    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: 'gemini-2.0-flash-001',
      contents: prompt,
    });
    const text = (result?.text || '').toString();
    res.status(200).json({ text });
  } catch (e) {
    console.error('gen-text error', e);
    res.status(500).json({ error: 'Text generation failed', details: String(e?.message || e) });
  }
});

// Server-side image generation via Google AI Images API
app.post('/api/gen-image', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing `prompt` (string)' });
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: 'Server misconfigured: GEMINI_API_KEY not set' });

    const ai = new GoogleGenAI({ apiKey: key });
    const response = await ai.models.generateImages({
      model: 'imagen-4.0-generate-001',
      prompt,
      config: { numberOfImages: 1 }
    });
    const img = response?.generatedImages?.[0];
    const b64 = img?.image?.imageBytes;
    if (!b64) return res.status(502).json({ error: 'No image bytes in response', body: response });
    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', buf.length);
    res.status(200).send(buf);
  } catch (e) {
    console.error('gen-image error', e);
    res.status(500).json({ error: 'Image generation failed', details: String(e?.message || e) });
  }
});

// Server-side video generation via Google AI Videos API
app.post('/api/gen-video', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing `prompt` (string)' });
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: 'Server misconfigured: GEMINI_API_KEY not set' });

    const ai = new GoogleGenAI({ apiKey: key });
    let operation = await ai.models.generateVideos({
      model: 'veo-3.0-generate-001',
      prompt,
    });
    const started = Date.now();
    const timeoutMs = 5 * 60 * 1000; // 5 minutes
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    while (!operation?.done) {
      if (Date.now() - started > timeoutMs) return res.status(504).json({ error: 'Video generation timed out', last: operation });
      await delay(8000);
      operation = await ai.operations.getVideosOperation({ operation });
    }
    const uri = operation?.response?.generatedVideos?.[0]?.video?.uri;
    if (!uri) return res.status(502).json({ error: 'No video uri in operation result', body: operation });
    const signedUri = uri + (uri.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
    const vr = await fetch(signedUri);
    if (!vr.ok) {
      const text = await vr.text();
      return res.status(502).json({ error: 'Video download failed', status: vr.status, body: text });
    }
    const buf = Buffer.from(await vr.arrayBuffer());
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', buf.length);
    res.status(200).send(buf);
  } catch (e) {
    console.error('gen-video error', e);
    res.status(500).json({ error: 'Video generation failed', details: String(e?.message || e) });
  }
});
// Proxy to Manim render service
app.post('/api/manim-proxy', async (req, res) => {
  const target = process.env.MANIM_SERVICE_URL;
  if (!target) return res.status(500).json({ error: 'MANIM_SERVICE_URL not configured' });
  try {
    const r = await fetch(target.replace(/\/$/, '') + '/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: 'Upstream manim error', status: r.status, body: safeJson(text) });
    }
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Length', buf.length);
    res.status(200).send(buf);
  } catch (e) {
    console.error('manim-proxy error', e);
    res.status(502).json({ error: 'Failed to reach manim service', details: String(e?.message || e) });
  }
});

// Proxy to Asymptote render service
app.post('/api/asy-proxy', async (req, res) => {
  const target = process.env.MANIM_SERVICE_URL; // reuse same service hosting /asy
  if (!target) return res.status(500).json({ error: 'MANIM_SERVICE_URL not configured' });
  try {
    const r = await fetch(target.replace(/\/$/, '') + '/asy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {})
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: 'Upstream asymptote error', status: r.status, body: safeJson(text) });
    }
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Length', buf.length);
    res.status(200).send(buf);
  } catch (e) {
    console.error('asy-proxy error', e);
    res.status(502).json({ error: 'Failed to reach asymptote service', details: String(e?.message || e) });
  }
});

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// Share viewer route
app.get('/s/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'share.html'));
});

// Serve the SPA (index.html at root)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Optional: serve any other static assets in root (none right now)
app.use(express.static(__dirname, { extensions: ['html'] }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Web server listening on http://localhost:${PORT}`);
});
