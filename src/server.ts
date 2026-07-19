import express from 'express';
import cors from 'cors';
import newsRoutes from './routes/news';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/news', newsRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sierra Leone News API running on port ${PORT}`));

export default app;
