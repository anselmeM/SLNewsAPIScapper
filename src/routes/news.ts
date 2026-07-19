import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

router.get('/', async (req: Request, res: Response) => {
  try {
    const { source, limit = 20 } = req.query;
    const queryOptions: any = {
      orderBy: { pubDate: 'desc' },
      take: Number(limit)
    };

    if (source) {
      queryOptions.where = { source: String(source) };
    }

    const articles = await prisma.article.findMany(queryOptions);
    res.json(articles);
  } catch (error) {
    res.status(500).json({ error: "Failed to retrieve articles" });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const article = await prisma.article.findUnique({
      where: { id: Number(id) }
    });

    if (!article) return res.status(404).json({ error: "Article not found" });
    res.json(article);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch article" });
  }
});

export default router;
