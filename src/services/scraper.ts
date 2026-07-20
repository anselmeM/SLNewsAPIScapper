import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { prisma } from '../db.js';
import { SIERRA_LEONE_SOURCES, NewsSourceConfig } from '../config/sources.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const parser = new Parser({
  headers: { 'User-Agent': USER_AGENT },
});

function safeParseDate(dateStr?: string): Date {
  if (!dateStr) return new Date();
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date() : d;
}

function extractRealLink(rawLink: string): string {
  if (!rawLink.includes('%3C') && !rawLink.includes('<')) return rawLink;
  try {
    const decoded = decodeURIComponent(rawLink);
    const match = decoded.match(/href="([^"]+)"/);
    if (match) {
      const href = match[1];
      if (href.startsWith('/')) {
        return new URL(rawLink).origin + href;
      }
      return href;
    }
  } catch {
    // fall through to raw link
  }
  return rawLink;
}

function paragraphsFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const paragraphs: string[] = [];
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length > 40) paragraphs.push(text);
  });
  return paragraphs;
}

function firstImageFromHtml(html: string): string | null {
  const $ = cheerio.load(html);
  const src = $('img').first().attr('src');
  return src || null;
}

function getFeedContentHtml(item: any): string {
  return item['content:encoded'] || item.content || item.description || '';
}

function extractDescription(item: any): string | null {
  if (item.contentSnippet) {
    const trimmed = item.contentSnippet.trim();
    if (trimmed.length > 0) return trimmed.slice(0, 500);
  }
  if (item.description) {
    const stripped = item.description.replace(/<[^>]*>/g, '').trim();
    if (stripped.length > 0) return stripped.slice(0, 500);
  }
  return null;
}

async function findArticleImage(link: string, feedHtml: string): Promise<string | null> {
  if (feedHtml) {
    const src = firstImageFromHtml(feedHtml);
    if (src) {
      if (src.startsWith('http')) return src;
      try { return new URL(src, link).href; } catch { }
    }
  }

  try {
    const { data } = await axios.get(link, {
      timeout: 8000,
      headers: { 'User-Agent': USER_AGENT },
    });
    const $ = cheerio.load(data);
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) {
      if (ogImage.startsWith('http')) return ogImage;
      try { return new URL(ogImage, link).href; } catch { }
    }
  } catch { }

  return null;
}

async function scrapeFullContent(url: string, selector: string): Promise<string[]> {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': USER_AGENT },
    });
    const $ = cheerio.load(data);
    const paragraphs: string[] = [];

    $(selector).each((_, el) => {
      const text = $(el).text().trim();
      if (text) paragraphs.push(text);
    });

    return paragraphs;
  } catch (err) {
    console.error(`Failed parsing content for URL: ${url}`);
    return [];
  }
}

async function backfillArticleMeta(): Promise<void> {
  const counts = await prisma.article.count({
    where: { OR: [{ imageUrl: null }, { description: null }, { category: { equals: [] } }] },
  });
  if (counts === 0) return;

  console.log(`Backfilling ${counts} articles with missing metadata...`);

  const allArticles = await prisma.article.findMany({
    select: { id: true, link: true, imageUrl: true, description: true, category: true },
  });
  const linkMap = new Map(allArticles.map(a => [a.link, a]));

  for (const source of SIERRA_LEONE_SOURCES) {
    try {
      const feed = await parser.parseURL(source.feedUrl);
      for (const item of feed.items) {
        if (!item.link) continue;
        const link = extractRealLink(item.link);
        const existing = linkMap.get(link);
        if (!existing) continue;

        const updateData: any = {};

        if (!existing.imageUrl) {
          const feedHtml = getFeedContentHtml(item);
          const img = await findArticleImage(link, feedHtml);
          if (img) updateData.imageUrl = img;
        }

        if (!existing.description) {
          const desc = extractDescription(item);
          if (desc) updateData.description = desc;
        }

        if (existing.category.length === 0 && item.categories && item.categories.length > 0) {
          updateData.category = item.categories;
        }

        if (Object.keys(updateData).length > 0) {
          await prisma.article.update({ where: { id: existing.id }, data: updateData });
          console.log(`  [${existing.id}] ${item.title?.slice(0, 50)}`);
        }
      }
    } catch { }
  }
}

export async function runSierraLeoneIngestion() {
  console.log(`[${new Date().toISOString()}] Starting Sierra Leone Ingestion Cycle...`);

  await backfillArticleMeta();

  for (const source of SIERRA_LEONE_SOURCES) {
    console.log(`Checking feed: ${source.name}`);

    try {
      const feed = await parser.parseURL(source.feedUrl);

      for (const item of feed.items) {
        if (!item.link || !item.title) continue;

        const link = extractRealLink(item.link);

        const existing = await prisma.article.findUnique({
          where: { link }
        });

        if (!existing) {
          console.log(`-> Ingesting: ${item.title}`);
          let paragraphs = await scrapeFullContent(link, source.contentSelector);

          const feedHtml = getFeedContentHtml(item);

          // Fallback: use paragraphs from feed content
          if (paragraphs.length === 0 && feedHtml) {
            paragraphs = paragraphsFromHtml(feedHtml);
          }

          const imageUrl = await findArticleImage(link, feedHtml);
          const description = extractDescription(item);

          await prisma.article.create({
            data: {
              title: item.title,
              link: link,
              pubDate: safeParseDate(item.pubDate),
              author: item.creator || source.name,
              description: description,
              category: item.categories || [],
              imageUrl: imageUrl,
              paragraphs: paragraphs,
              source: source.name
            }
          });

          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } catch (feedError) {
      console.error(`Error reading feed for ${source.name}:`, feedError);
    }
  }

  console.log(`[${new Date().toISOString()}] Ingestion Cycle Complete.`);
}
