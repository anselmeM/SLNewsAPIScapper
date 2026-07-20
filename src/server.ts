import express from 'express';
import cors from 'cors';
import { prisma } from './db.js';

const app = express();

app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY;

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.headers.authorization?.replace('Bearer ', '') || (req.query.api_key as string);
  if (!API_KEY || key === API_KEY) return next();
  res.status(401).json({ error: 'Unauthorized — provide a valid API key via Authorization header or ?api_key=' });
}

app.get('/', (_req, res) => {
  res.json({
    name: 'Sierra Leone News API',
    auth: API_KEY ? 'Requires api_key query param or Authorization: Bearer <key>' : 'Open (no API_KEY set)',
    endpoints: {
      news: '/api/news?limit=20&source=<name>',
      article: '/api/news/:id',
      health: '/api/health'
    }
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/news', requireApiKey, async (req, res) => {
  try {
    const { source, limit = 20 } = req.query;
    const queryOptions: any = {
      orderBy: { pubDate: 'desc' },
      take: Number(limit)
    };
    if (source) queryOptions.where = { source: String(source) };
    const articles = await prisma.article.findMany(queryOptions);
    res.json(articles);
  } catch {
    res.status(500).json({ error: "Failed to retrieve articles" });
  }
});

app.get('/api/news/:id', requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;
    const article = await prisma.article.findUnique({
      where: { id: Number(id) }
    });
    if (!article) return res.status(404).json({ error: "Article not found" });
    res.json(article);
  } catch {
    res.status(500).json({ error: "Failed to fetch article" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sierra Leone News API running on port ${PORT}`));

export default app;
