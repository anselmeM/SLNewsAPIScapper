# Sierra Leone News API Scraper

Aggregates articles from Sierra Leone's top news outlets — **The Sierra Leone Telegraph**, **Politico SL**, and **Concord Times** — via RSS feeds, stores them in PostgreSQL, and serves them through a REST API.

## Stack

- **Neon** — Serverless PostgreSQL
- **Render** — Hosting (web service + cron)
- **Prisma 7** — ORM
- **Express 5** — REST API
- **Cheerio + rss-parser** — Content scraping

## Quick Start

```bash
cp .env.example .env
# Fill in your Neon DATABASE_URL
npm install
npm run build
npx prisma db push
npm start          # API on port 3000
```

## API

| Endpoint | Description |
|---|---|
| `GET /api/news` | Latest articles (paginated, `?source=` filter) |
| `GET /api/news/:id` | Single article by ID |
| `GET /api/health` | Health check |

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Scrape then start API (TS, dev) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Start API from compiled JS |
| `npm run scrape` | Run scraper once (TS) |

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/anselmeM/SLNewsAPIScapper)

1. Click the button above, or on Render choose **New → Blueprint** and connect this repo
2. When prompted, paste your Neon `DATABASE_URL`
3. Tables are created automatically on first deploy (`prisma db push`)

The scraper cron runs hourly. The API auto-scales from `dist/server.js`.
