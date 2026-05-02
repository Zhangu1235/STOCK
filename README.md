# MKTVIEW — NSE/BSE Stock Terminal

Live Indian stock market dashboard with AI candle chart analysis.

## Features
- Live NIFTY 50, SENSEX, BANKNIFTY, MIDCAP prices
- All 50 NIFTY stocks with price, % change, market cap
- Real OHLCV candlestick charts (TradingView Lightweight Charts)
- Timeframes: 1M · 5M · 15M · 1H · 1D · 1W
- Sector heatmap
- Scrolling ticker strip
- Symbol search
- AI candle analysis via Groq (Llama 4 Scout vision)

## Stack
- Backend : Node.js + Express (Yahoo Finance proxy)
- Frontend : Vanilla HTML/CSS/JS + Lightweight Charts v4
- AI       : Groq API (free, Llama 4 Scout vision model)

---

## SETUP

### 1. Backend

```bash
npm install
npm start
# Server runs on http://localhost:3001
```

To run with auto-reload during development:
```bash
npm run dev
```

### 2. Frontend

Just open the file in a browser:
```bash
start index.html   # Windows
```

> The frontend talks to `http://localhost:3001` by default.
> To deploy, change the `API` constant at the top of index.html to your backend URL.

---

## API Endpoints (backend)

| Endpoint | Description |
|---|---|
| GET /api/indices | NIFTY, SENSEX, BANKNIFTY, MIDCAP live |
| GET /api/stocks | All 50 NIFTY stocks with full data |
| GET /api/candles | OHLCV candles `?symbol=RELIANCE.NS&interval=5m&range=1d` |
| GET /api/quote | Single stock quote `?symbol=TCS.NS` |
| GET /api/search | Symbol search `?q=reliance` |
| GET /api/health | Health check |

### Candle intervals + ranges
| Interval | Valid Ranges |
|---|---|
| 1m | 1d |
| 5m | 1d, 5d |
| 15m | 5d, 1mo |
| 1h | 1mo, 3mo |
| 1d | 1y, 2y, 5y |
| 1wk | 5y, max |

---

## AI Candle Analysis (Groq)

1. Get a free Groq API key at https://console.groq.com
2. Click **AI SCAN** tab in the dashboard
3. Upload any candlestick chart screenshot (PNG/JPG/WEBP)
4. Paste your Groq API key
5. Click **⚡ ANALYZE CHART**

The AI (Llama 4 Scout vision) returns:
- BUY / SELL / HOLD signal with confidence
- Detected candlestick patterns
- Support & resistance levels
- Trend direction
- 2-3 sentence technical analysis

---

## Deploy to Production

### Backend (Railway / Render)
```bash
# Push this project folder to Railway or Render
# Set PORT environment variable if needed
# Both offer free tiers
```

### Frontend (Vercel / Netlify)
```bash
# Deploy index.html as a static site
# Update the API constant in index.html to your backend URL:
# const API = 'https://your-backend.railway.app';
```

---

## Notes
- Yahoo Finance data may be delayed 15-20 min during market hours
- For real-time sub-second data, upgrade to Upstox/Zerodha Kite API
- Never expose the Groq API key in production — move it to the backend
- Data is for educational purposes only — not financial advice
