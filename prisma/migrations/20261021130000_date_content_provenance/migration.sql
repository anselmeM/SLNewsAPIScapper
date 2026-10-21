-- Date/content provenance (P1-6).
--
-- Adds per-row provenance so consumers can tell whether a published date was
-- trusted, adjusted, or absent, and whether an article body came from the
-- publisher page, the feed payload, or nowhere. Existing rows keep working:
-- pubDateSource defaults to 'published' (the historical assumption),
-- contentSource stays NULL (legacy/unknown) and contentAttempts defaults to 0.
ALTER TABLE "Article" ADD COLUMN "pubDateSource" TEXT NOT NULL DEFAULT 'published';
ALTER TABLE "Article" ADD COLUMN "pubDateRaw" TEXT;
ALTER TABLE "Article" ADD COLUMN "contentSource" TEXT;
ALTER TABLE "Article" ADD COLUMN "contentAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Article" ADD COLUMN "lastContentAttemptAt" TIMESTAMP(3);
ALTER TABLE "Article" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Video" ADD COLUMN "publishedAtSource" TEXT NOT NULL DEFAULT 'published';
ALTER TABLE "Video" ADD COLUMN "publishedAtRaw" TEXT;
ALTER TABLE "Video" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Article_contentSource_idx" ON "Article"("contentSource");
