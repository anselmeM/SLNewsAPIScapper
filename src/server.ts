import express from 'express';
import cors from 'cors';
import newsRoutes from './routes/news.js';

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

app.use('/api/news', newsRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sierra Leone News API running on port ${PORT}`));

export default app;
