import 'dotenv/config';
import { assertRuntimeEnv } from './config/env.js';
import { runSierraLeoneIngestion } from './services/scraper.js';
import logger from './logger.js';

// The scrape worker needs the database but never serves HTTP, so missing API
// credentials must not block a scheduled ingestion run.
assertRuntimeEnv({ requireApiCredentials: false });

runSierraLeoneIngestion()
  .then(() => {
    logger.info('Scrape cycle finished');
    process.exit(0);
  })
  .catch((err) => {
    logger.fatal(err, 'Scrape failed');
    process.exit(1);
  });
