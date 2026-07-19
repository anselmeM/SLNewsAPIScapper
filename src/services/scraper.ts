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

// Some feeds (e.g. Politico SL) embed a URL-encoded HTML anchor in <link>
// instead of a plain URL. Decode and extract the real href when detected.
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

export async function runSierraLeoneIngestion() {
  console.log(`[${new Date().toISOString()}] Starting Sierra Leone Ingestion Cycle...`);

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

          // Fallback: use full article HTML embedded in the feed itself
          if (paragraphs.length === 0) {
            const feedContent = (item as any)['content:encoded'] || item.content || '';
            if (feedContent) paragraphs = paragraphsFromHtml(feedContent);
          }

          await prisma.article.create({
            data: {
              title: item.title,
              link: link,
              pubDate: safeParseDate(item.pubDate),
              author: item.creator || source.name,
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
