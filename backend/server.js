/**
 * STRATEGOS — Backend API Server
 * ─────────────────────────────────────────────────────────────
 * Securely proxies:
 *   POST /api/claude     → Anthropic Claude API (AI content)
 *   GET  /api/markets    → Aggregates live market data
 *   GET  /api/health     → Health check
 *
 * Run:  node server.js
 * Prod: pm2 start server.js --name strategos
 */

import express        from 'express';
import cors           from 'cors';
import rateLimit      from 'express-rate-limit';
import helmet         from 'helmet';
import fetch          from 'node-fetch';
import dotenv         from 'dotenv';
import { fileURLToPath } from 'url';
import path           from 'path';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;

// ─── SECURITY ─────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));

// CORS — allow your frontend domain
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5500')
  .split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

// ─── RATE LIMITING ─────────────────────────────────────────────
// Claude endpoint — max 20 req/min per IP (prevents abuse)
const claudeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Markets endpoint — max 120 req/min (30s refresh for many users)
const marketsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many market requests.' }
});

// ─── CACHE ─────────────────────────────────────────────────────
// Simple in-memory cache to avoid hammering external APIs
const cache = new Map();
function getCache(key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > ttlMs) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

// ─── ROUTE: HEALTH CHECK ───────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    service: 'STRATEGOS Intelligence API'
  });
});

// ─── ROUTE: CLAUDE PROXY ───────────────────────────────────────
app.post('/api/claude', claudeLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const { prompt, maxTokens = 1200, useWebSearch = true } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid prompt.' });
  }
  if (prompt.length > 4000) {
    return res.status(400).json({ error: 'Prompt too long (max 4000 chars).' });
  }

  try {
    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: Math.min(maxTokens, 2000),
      messages: [{ role: 'user', content: prompt }]
    };

    // Attach web search tool when requested
    if (useWebSearch) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error('Anthropic API error:', upstream.status, err);
      return res.status(upstream.status).json({ error: 'Upstream API error.', detail: err });
    }

    const data = await upstream.json();

    // Extract only text blocks — never expose tool use blocks to client
    const textContent = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    res.json({ text: textContent, usage: data.usage });

  } catch (err) {
    console.error('Claude proxy error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─── ROUTE: LIVE MARKET DATA ───────────────────────────────────
app.get('/api/markets', marketsLimiter, async (req, res) => {
  const CACHE_TTL = 25 * 1000; // 25 seconds
  const cached = getCache('markets', CACHE_TTL);
  if (cached) return res.json({ ...cached, cached: true });

  const results = {};
  const errors  = [];

  // Helper: safe fetch with timeout
  async function safeFetch(url, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return await r.json();
    } catch(e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // ── CRYPTO: Binance (no key) ──────────────────────────────
  const cryptoSymbols = ['BTCUSDT', 'ETHUSDT'];
  await Promise.allSettled(cryptoSymbols.map(async sym => {
    try {
      const data = await safeFetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`);
      const id = sym.replace('USDT', '');
      results[id] = {
        price: parseFloat(data.lastPrice),
        pct:   parseFloat(data.priceChangePercent),
        high:  parseFloat(data.highPrice),
        low:   parseFloat(data.lowPrice),
        vol:   parseFloat(data.volume)
      };
    } catch(e) { errors.push(`${sym}: ${e.message}`); }
  }));

  // ── FOREX: Frankfurter (ECB, no key) ─────────────────────
  try {
    const fx = await safeFetch('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,CHF');
    if (fx.rates) {
      results.EURUSD = { price: +(1 / fx.rates.EUR).toFixed(5), pct: null };
      results.GBPUSD = { price: +(1 / fx.rates.GBP).toFixed(5), pct: null };
      results.USDJPY = { price: +fx.rates.JPY.toFixed(3),       pct: null };
      results.USDCHF = { price: +fx.rates.CHF.toFixed(5),       pct: null };
    }
  } catch(e) { errors.push(`FX: ${e.message}`); }

  // ── METALS: metals.live (no key) ─────────────────────────
  try {
    const metals = await safeFetch('https://metals.live/api/latest');
    if (metals.gold)   results.GOLD   = { price: metals.gold,   pct: metals.gold_change_percent   || null };
    if (metals.silver) results.SILVER = { price: metals.silver, pct: metals.silver_change_percent || null };
  } catch(e) {
    errors.push(`Metals: ${e.message}`);
    // Fallback — use known recent values
    results.GOLD   = results.GOLD   || { price: 4652.04, pct: 2.07, fallback: true };
    results.SILVER = results.SILVER || { price: 75.752,  pct: 4.02, fallback: true };
  }

  // ── EQUITIES: Yahoo Finance ───────────────────────────────
  const equities = {
    'NDX':  '%5ENDX',   // Nasdaq 100
    'DJI':  '%5EDJI',   // Dow Jones
    'GSPC': '%5EGSPC',  // S&P 500
    'VIX':  '%5EVIX',   // VIX Fear Index
  };
  await Promise.allSettled(Object.entries(equities).map(async ([id, sym]) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2d`;
      const data = await safeFetch(url);
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) {
        const price = meta.regularMarketPrice;
        const prev  = meta.chartPreviousClose || meta.previousClose;
        results[id] = {
          price,
          pct: prev ? +((price - prev) / prev * 100).toFixed(2) : null,
          prev
        };
      }
    } catch(e) { errors.push(`${id}: ${e.message}`); }
  }));

  // ── OIL: Alpha Vantage free tier (no key needed for commodity) ─
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BZ%3DF?interval=1d&range=2d';
    const data = await safeFetch(url);
    const meta = data?.chart?.result?.[0]?.meta;
    if (meta) {
      const price = meta.regularMarketPrice;
      const prev  = meta.chartPreviousClose;
      results.BRENT = {
        price,
        pct: prev ? +((price - prev) / prev * 100).toFixed(2) : null
      };
    }
  } catch(e) { errors.push(`Brent: ${e.message}`); }

  const payload = {
    data:      results,
    timestamp: new Date().toISOString(),
    errors:    errors.length ? errors : undefined,
    cached:    false
  };

  setCache('markets', payload);
  res.json(payload);
});

// ─── SERVE FRONTEND (production) ──────────────────────────────
// When deployed, serve the HTML file from this same server
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │   STRATEGOS Intelligence API            │
  │   Running on http://localhost:${PORT}       │
  │   Environment: ${process.env.NODE_ENV || 'development'}              │
  └─────────────────────────────────────────┘
  `);
});
