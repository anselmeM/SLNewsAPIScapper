/**
 * Ingestion facade.
 *
 * The run is composed from bounded phases under `./ingestion/`:
 *  - `feed`     — RSS pass, dedupe, metadata/content backfill
 *  - `backfill` — image sweep and missing-content repair sweep
 *  - `sitemap`  — Telegraph sitemap fallback
 *  - `run`      — deadline, shared budgets and phase orchestration
 *
 * This module keeps the historical import path stable for routes, tests and the
 * scheduler while the implementation is split by responsibility.
 */
export type { IngestionOptions } from './ingestion/types.js';

export { runSierraLeoneIngestion } from './ingestion/run.js';
export { backfillImages } from './ingestion/backfill.js';
export { firstPageImage } from './ingestion/content.js';
export { parseSitemapUrls } from './ingestion/sitemap.js';
export { runSierraLeoneVideoIngestion } from './video-scraper.js';
