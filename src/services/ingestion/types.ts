import type { DedupeIndex } from '../dedupe.js';

export interface IngestionOptions {
  /** Absolute epoch-ms timestamp after which no new source/page/channel starts. */
  deadlineAt?: number;
  /** Test seam: skip the post-ingestion image sweep so mocks stay focused. */
  skipImageBackfill?: boolean;
}

export interface FeedItem {
  link?: string;
  title?: string;
  pubDate?: string;
  creator?: string;
  content?: string;
  contentSnippet?: string;
  description?: string;
  categories?: string[];
  [key: string]: unknown;
}

export interface ExistingArticleMeta {
  id: number;
  link: string;
  imageUrl: string | null;
  description: string | null;
  category: string[];
  source: string;
  paragraphs: string[];
  contentSource: string | null;
  contentAttempts: number;
}

/** A feed item plus its deduplication key and guaranteed title, resolved once per source. */
export interface PendingItem {
  item: FeedItem;
  link: string;
  title: string;
}

/** Shared per-run budget for bounded content repairs (feeds + sweep). */
export interface ContentRepairContext {
  deadlineAt: number;
  startedAt: number;
  repairs: number;
}

/** Mutable budgets and deadline shared by every phase of one ingestion run. */
export interface IngestionRunContext {
  deadlineAt: number;
  startedAt: number;
  imageFetches: number;
  contentRepairs: ContentRepairContext;
}

export type FeedDedupeIndex = DedupeIndex;
