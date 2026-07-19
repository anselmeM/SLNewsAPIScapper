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

## Deploy (Render)

1. Push to GitHub
2. On Render, choose **Blueprint** deploy — it reads `render.yaml`
3. Set `DATABASE_URL` env var to your Neon connection string
4. Run `npx prisma db push` after first deploy

The scraper cron runs hourly. The API auto-scales from `dist/server.js`.
