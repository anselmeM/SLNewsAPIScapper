import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const total = await prisma.article.count();
  console.log(`Total articles: ${total}`);

  const bySource = await prisma.article.groupBy({
    by: ['source'],
    _count: true,
    orderBy: { _count: { source: 'desc' } },
  });
  for (const s of bySource) {
    console.log(`  ${s.source}: ${s._count} articles`);
  }

  // Latest 5 articles from Telegraph
  const latest = await prisma.article.findMany({
    where: { source: 'The Sierra Leone Telegraph' },
    orderBy: { pubDate: 'desc' },
    take: 5,
    select: { title: true, pubDate: true },
  });
  console.log('\nLatest 5 Telegraph articles:');
  for (const a of latest) {
    console.log(`  ${a.pubDate.toISOString().slice(0,10)} ${a.title?.slice(0,80)}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
