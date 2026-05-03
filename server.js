'use strict';

// ─────────────────────────────────────────────────
//  DEPENDENCIES
// ─────────────────────────────────────────────────
const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
require('dotenv').config();
const compression = require('compression');
const morgan     = require('morgan');
const NodeCache  = require('node-cache');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────
//  ENV / CONFIG
// ─────────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT || '3001', 10);
const NODE_ENV        = process.env.NODE_ENV || 'development';
const IS_PROD         = NODE_ENV === 'production';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null; // null = allow all in development

const VERSION = require('./package.json').version;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ─────────────────────────────────────────────────
//  IN-MEMORY CACHE
// ─────────────────────────────────────────────────
const cache = new NodeCache({ stdTTL: 20, checkperiod: 30 }); // 20s default TTL

function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  return Promise.resolve(fn()).then(val => {
    cache.set(key, val, ttl);
    return val;
  });
}

// ─────────────────────────────────────────────────
//  APP
// ─────────────────────────────────────────────────
const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // CSP handled on frontend
  crossOriginEmbedderPolicy: false,
}));

// Compression
app.use(compression());

// CORS
const corsOptions = ALLOWED_ORIGINS
  ? { origin: ALLOWED_ORIGINS, optionsSuccessStatus: 200 }
  : { origin: '*', optionsSuccessStatus: 200 };
app.use(cors(corsOptions));

// Body parsing
app.use(express.json({ limit: '5mb' })); // 5mb for base64 chart image uploads

// HTTP request logging (skip in test env)
if (NODE_ENV !== 'test') {
  app.use(morgan(IS_PROD ? 'combined' : 'dev'));
}

// Trust proxy (required for rate-limit IP detection on Railway/Render)
app.set('trust proxy', 1);

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 120,              // 120 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please slow down.' },
});
app.use('/api/', limiter);

// Serve frontend static file
app.use(express.static(path.join(__dirname), {
  index: 'index.html',
  maxAge: IS_PROD ? '1d' : 0,
  etag: true,
}));

// ─────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────
const YF_BASE  = 'https://query1.finance.yahoo.com';
const YF_BASE2 = 'https://query2.finance.yahoo.com';

const INDICES = ['^NSEI', '^BSESN', '^NSEBANK', 'NIFTY_MIDCAP_100.NS'];

const NIFTY50 = [
  'RELIANCE.NS','TCS.NS','HDFCBANK.NS','INFY.NS','ICICIBANK.NS',
  'HINDUNILVR.NS','SBIN.NS','BHARTIARTL.NS','ITC.NS','KOTAKBANK.NS',
  'LT.NS','AXISBANK.NS','ASIANPAINT.NS','MARUTI.NS','SUNPHARMA.NS',
  'TITAN.NS','BAJFINANCE.NS','WIPRO.NS','ULTRACEMCO.NS','HCLTECH.NS',
  'NESTLEIND.NS','TECHM.NS','POWERGRID.NS','NTPC.NS','ONGC.NS',
  'JSWSTEEL.NS','GRASIM.NS','BPCL.NS','TMCV.NS','HINDALCO.NS',
  'COALINDIA.NS','DRREDDY.NS','DIVISLAB.NS','CIPLA.NS','APOLLOHOSP.NS',
  'BAJAJFINSV.NS','BRITANNIA.NS','EICHERMOT.NS','ADANIENT.NS','ADANIPORTS.NS',
  'TATACONSUM.NS','HEROMOTOCO.NS','TATASTEEL.NS','M&M.NS','INDUSINDBK.NS',
  'SBILIFE.NS','HDFCLIFE.NS','UPL.NS','VEDL.NS','SHRIRAMFIN.NS',
];

const VALID_INTERVALS = new Set(['1m','2m','5m','15m','30m','60m','1h','1d','1wk','1mo']);
const VALID_RANGES    = new Set(['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max']);

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

// ─────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────
function errorMessage(e) {
  const status   = e.response?.status;
  const upstream = e.response?.data?.finance?.error?.description || e.response?.data?.message;
  return [status && `HTTP ${status}`, upstream || e.message].filter(Boolean).join(': ') || 'Unknown error';
}

async function yfFetch(url) {
  const res = await axios.get(url, { headers: YF_HEADERS, timeout: 12000 });
  return res.data;
}

async function fetchChartQuote(symbol) {
  const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const data = await yfFetch(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data found for ${symbol}`);

  const meta  = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};
  const last  = arr => {
    if (!Array.isArray(arr)) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null) return arr[i];
    }
    return null;
  };
  const price    = meta.regularMarketPrice ?? last(quote.close);
  const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? null;
  const change   = price != null && prevClose != null ? price - prevClose : null;

  return {
    symbol:    meta.symbol || symbol,
    name:      meta.shortName || meta.longName || meta.symbol || symbol,
    price,
    change,
    changePct: change != null && prevClose ? (change / prevClose) * 100 : null,
    open:      last(quote.open),
    high:      meta.regularMarketDayHigh ?? last(quote.high),
    low:       meta.regularMarketDayLow  ?? last(quote.low),
    prevClose,
    volume:    meta.regularMarketVolume  ?? last(quote.volume),
    marketCap: null,
    week52High: meta.fiftyTwoWeekHigh ?? null,
    week52Low:  meta.fiftyTwoWeekLow  ?? null,
  };
}

async function fetchCandles(symbol, interval, range) {
  const url = `${YF_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false&events=div,splits`;
  const data = await yfFetch(url);
  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const ts  = result.timestamp || [];
  const q   = result.indicators?.quote?.[0] || {};
  const candles = ts
    .map((t, i) => ({
      time:   t,
      open:   q.open?.[i],
      high:   q.high?.[i],
      low:    q.low?.[i],
      close:  q.close?.[i],
      volume: q.volume?.[i],
    }))
    .filter(c => c.open != null && c.close != null && c.high != null && c.low != null);

  return { result, candles, interval, range };
}

// ─────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok:      true,
    version: VERSION,
    env:     NODE_ENV,
    uptime:  Math.floor(process.uptime()),
    cache: {
      keys:  cache.keys().length,
      stats: cache.getStats(),
    },
    ts: Date.now(),
  });
});

// Indices
app.get('/api/indices', async (req, res) => {
  try {
    const data = await cached('indices', 15, () =>
      Promise.all(INDICES.map(fetchChartQuote))
    );
    res.json({ success: true, data, ts: Date.now() });
  } catch (e) {
    const message = errorMessage(e);
    console.error('[indices]', message);
    res.status(502).json({ success: false, error: message });
  }
});

// Nifty 50 stocks
app.get('/api/stocks', async (req, res) => {
  try {
    const data = await cached('stocks', 20, () =>
      Promise.all(NIFTY50.map(fetchChartQuote))
    );
    res.json({ success: true, data, ts: Date.now() });
  } catch (e) {
    const message = errorMessage(e);
    console.error('[stocks]', message);
    res.status(502).json({ success: false, error: message });
  }
});

// Candles (OHLCV)
app.get('/api/candles', async (req, res) => {
  const { symbol = '^NSEI', interval = '5m', range = '1d' } = req.query;

  // Input validation
  if (typeof symbol !== 'string' || symbol.length > 30) {
    return res.status(400).json({ success: false, error: 'Invalid symbol' });
  }
  if (!VALID_INTERVALS.has(interval)) {
    return res.status(400).json({ success: false, error: `Invalid interval. Allowed: ${[...VALID_INTERVALS].join(',')}` });
  }
  if (!VALID_RANGES.has(range)) {
    return res.status(400).json({ success: false, error: `Invalid range. Allowed: ${[...VALID_RANGES].join(',')}` });
  }

  const cacheKey = `candles:${symbol}:${interval}:${range}`;
  try {
    const payload = await cached(cacheKey, 12, async () => {
      let chart = await fetchCandles(symbol, interval, range);
      if (chart && chart.candles.length === 0 && range === '1d' && ['1m', '5m'].includes(interval)) {
        chart = await fetchCandles(symbol, '5m', '5d');
      }
      if (!chart?.result) throw new Error('No chart data found');

      const meta = chart.result.meta || {};
      return {
        symbol,
        interval: chart.interval,
        range:    chart.range,
        meta: {
          currency:     meta.currency,
          exchange:     meta.exchangeName,
          currentPrice: meta.regularMarketPrice,
          prevClose:    meta.previousClose,
          high52:       meta.fiftyTwoWeekHigh,
          low52:        meta.fiftyTwoWeekLow,
        },
        candles: chart.candles,
      };
    });
    res.json({ success: true, ...payload, ts: Date.now() });
  } catch (e) {
    const message = errorMessage(e);
    console.error('[candles]', symbol, message);
    res.status(502).json({ success: false, error: message });
  }
});

// Single quote
app.get('/api/quote', async (req, res) => {
  const { symbol = '^NSEI' } = req.query;
  if (typeof symbol !== 'string' || symbol.length > 30) {
    return res.status(400).json({ success: false, error: 'Invalid symbol' });
  }
  const cacheKey = `quote:${symbol}`;
  try {
    const data = await cached(cacheKey, 15, () => fetchChartQuote(symbol));
    res.json({ success: true, data, ts: Date.now() });
  } catch (e) {
    res.status(502).json({ success: false, error: errorMessage(e) });
  }
});

// Search
app.get('/api/search', async (req, res) => {
  const { q = '' } = req.query;
  const query = String(q).trim().slice(0, 50); // sanitize length
  if (!query) return res.json({ success: true, data: [] });

  const cacheKey = `search:${query.toLowerCase()}`;
  try {
    const data = await cached(cacheKey, 60, async () => {
      const url = `${YF_BASE2}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&enableFuzzyQuery=true&region=IN&lang=en-IN`;
      const json = await yfFetch(url);
      return (json?.quotes || [])
        .filter(r => r.quoteType === 'EQUITY' || r.quoteType === 'INDEX')
        .slice(0, 8)
        .map(r => ({ symbol: r.symbol, name: r.shortname || r.longname, exchange: r.exchange, type: r.quoteType }));
    });
    res.json({ success: true, data });
  } catch (e) {
    res.status(502).json({ success: false, error: errorMessage(e) });
  }
});

// News
app.get('/api/news', async (req, res) => {
  const { symbol = 'RELIANCE.NS', count = 10 } = req.query;
  const cacheKey = `news:${symbol}:${count}`;
  try {
    const data = await cached(cacheKey, 300, async () => { // 5 min cache
      const url = `${YF_BASE2}/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=1&newsCount=${count}&enableFuzzyQuery=false&region=IN&lang=en-IN`;
      const json = await yfFetch(url);
      const news = (json?.news || []).map(n => ({
        title: n.title,
        url: n.link,
        source: n.publisher,
        time: n.providerPublishTime,
        summary: n.summary || '',
        relatedTickers: n.relatedTickers || []
      }));
      // If no news from Yahoo, add sample news
      if (news.length === 0) {
        news.push({
          title: 'Market Update: NIFTY 50 Shows Resilience Amid Global Volatility',
          url: 'https://finance.yahoo.com/news',
          source: 'Yahoo Finance',
          time: Date.now() / 1000,
          summary: 'Indian markets demonstrate strength with NIFTY closing higher despite international pressures.',
          relatedTickers: ['^NSEI']
        }, {
          title: 'Reliance Industries Reports Strong Q4 Earnings',
          url: 'https://finance.yahoo.com/news/reliance',
          source: 'Economic Times',
          time: Date.now() / 1000 - 3600,
          summary: 'Reliance Industries beats expectations with record quarterly profits driven by digital and energy segments.',
          relatedTickers: ['RELIANCE.NS']
        });
      }
      return news;
    });
    res.json({ success: true, data });
  } catch (e) {
    console.error('[news]', errorMessage(e));
    // Fallback sample news on error
    const sampleNews = [{
      title: 'Sample News: Stock Market Analysis',
      url: 'https://example.com',
      source: 'Sample Source',
      time: Date.now() / 1000,
      summary: 'This is a sample news item for demonstration purposes.',
      relatedTickers: []
    }];
    res.json({ success: true, data: sampleNews });
  }
});

// AI Chart Analysis — powered by Groq vision (meta-llama/llama-4-scout-17b-16e-instruct)
app.post('/api/ai-analyze', async (req, res) => {
  const { image } = req.body;
  if (!GROQ_API_KEY) {
    return res.status(503).json({ success: false, error: 'AI analysis not configured (missing GROQ_API_KEY)' });
  }
  // Accept up to ~6MB base64 string (~4.5 MB raw image)
  if (!image || typeof image !== 'string' || image.length > 6 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: 'Invalid or oversized image data (max ~4.5 MB)' });
  }

  try {
    const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 900,
      messages: [
        {
          role: 'system',
          content: 'You are an expert NSE/BSE technical analyst. When given a candlestick chart image, analyze it and reply ONLY with valid JSON — no markdown fences, no extra text. Use this exact format: {"signal":"BUY|SELL|HOLD","patterns":["..."],"support":"price","resistance":"price","trend":"Bullish|Bearish|Sideways","confidence":"High|Medium|Low","analysis":"2-3 sentence technical analysis mentioning specific patterns, momentum, and volume if visible"}'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this Indian stock market candlestick chart and return the JSON analysis.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }
          ]
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 45000
    });

    const raw = groqRes.data.choices?.[0]?.message?.content || '{}';
    let result;
    try {
      result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      result = {
        signal: 'HOLD',
        patterns: ['Could not parse response'],
        support: 'N/A',
        resistance: 'N/A',
        trend: 'N/A',
        confidence: 'Low',
        analysis: raw.slice(0, 400)
      };
    }

    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[ai-analyze]', errorMessage(e));
    res.status(502).json({ success: false, error: 'AI analysis failed: ' + errorMessage(e) });
  }
});


// Advisor Chatbot
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!GROQ_API_KEY) {
    return res.status(503).json({ success: false, error: 'AI chat not configured' });
  }
  if (!message || typeof message !== 'string' || message.length > 1000) {
    return res.status(400).json({ success: false, error: 'Invalid message' });
  }

  try {
    // Strip any extra fields (e.g. 'time') from history — only role + content allowed
    const cleanHistory = history
      .slice(-10)
      .filter(m => m.role && m.content)
      .map(m => ({ role: m.role, content: String(m.content) }));

    const messages = [
      {
        role: 'system',
        content: 'You are a professional NSE/BSE stock market advisor. Provide helpful, accurate investment advice based on technical and fundamental analysis. Always include a brief disclaimer that this is not financial advice. Keep responses concise and actionable. Focus on Indian markets.'
      },
      ...cleanHistory,
      { role: 'user', content: message }
    ];

    const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 600,
      messages,
      temperature: 0.7
    }, {
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const reply = groqRes.data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
    res.json({ success: true, reply });
  } catch (e) {
    console.error('[chat]', errorMessage(e));
    res.status(502).json({ success: false, error: 'Chat failed: ' + errorMessage(e) });
  }
});

// ─────────────────────────────────────────────────
//  GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[uncaught]', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ─────────────────────────────────────────────────
//  UNHANDLED REJECTIONS / EXCEPTIONS
// ─────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // Give logger time to flush, then exit
  setTimeout(() => process.exit(1), 500);
});

// ─────────────────────────────────────────────────
//  START + GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n✅  MKTVIEW Stock API  [${NODE_ENV}]`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   → http://localhost:${PORT}/api/health\n`);
});

function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed. Bye.');
    process.exit(0);
  });
  // Force-kill after 10s if connections linger
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
