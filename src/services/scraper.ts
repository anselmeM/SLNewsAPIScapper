import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { PrismaClient } from '@prisma/client';
import { SIERRA_LEONE_SOURCES, NewsSourceConfig } from '../config/sources.js';

const prisma = new PrismaClient();
const parser = new Parser();

async function scrapeFullContent(url: string, selector: string): Promise<string[]> {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'SierraLeoneNewsAPI/1.0' }
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

        const existing = await prisma.article.findUnique({
          where: { link: item.link }
        });

        if (!existing) {
          console.log(`-> Ingesting: ${item.title}`);
          const paragraphs = await scrapeFullContent(item.link, source.contentSelector);

          await prisma.article.create({
            data: {
              title: item.title,
              link: item.link,
              pubDate: new Date(item.pubDate || Date.now()),
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
