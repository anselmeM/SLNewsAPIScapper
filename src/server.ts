import express from 'express';
import cors from 'cors';
import { prisma } from './db.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({
    name: 'Sierra Leone News API',
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

app.get('/api/news', async (req, res) => {
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

app.get('/api/news/:id', async (req, res) => {
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
