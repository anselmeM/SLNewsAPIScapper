-- Search/performance indexes.
--
-- pg_trgm is needed for the GIN trigram indexes below, which back the current
-- case-insensitive `contains` predicates (ILIKE '%term%') used by the article
-- and video routes. CREATE EXTENSION must run before any gin_trgm_ops index.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes for ILIKE '%term%' search (title/description/summary).
-- Prisma cannot model non-default index operator classes (gin_trgm_ops), so
-- these exist only in this migration; do not drop them on `prisma migrate dev`.
CREATE INDEX IF NOT EXISTS "Article_title_trgm_idx" ON "Article" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Article_description_trgm_idx" ON "Article" USING GIN ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Video_title_trgm_idx" ON "Video" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Video_description_trgm_idx" ON "Video" USING GIN ("description" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Video_channelTitle_trgm_idx" ON "Video" USING GIN ("channelTitle" gin_trgm_ops);

-- Composite indexes mirroring the @@index additions in schema.prisma.
-- Filtered feed queries: source/channel + date range.
CREATE INDEX IF NOT EXISTS "Article_source_pubDate_idx" ON "Article"("source", "pubDate");
CREATE INDEX IF NOT EXISTS "Article_pubDate_id_idx" ON "Article"("pubDate", "id");
CREATE INDEX IF NOT EXISTS "Video_channelTitle_publishedAt_idx" ON "Video"("channelTitle", "publishedAt");
CREATE INDEX IF NOT EXISTS "Video_publishedAt_id_idx" ON "Video"("publishedAt", "id");

-- GIN indexes for array `hasSome` category filters (Prisma @@index type: Gin).
CREATE INDEX IF NOT EXISTS "Article_category_idx" ON "Article" USING GIN ("category");
CREATE INDEX IF NOT EXISTS "Video_category_idx" ON "Video" USING GIN ("category");
