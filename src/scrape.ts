import 'dotenv/config';
import { runSierraLeoneIngestion } from './services/scraper.js';
import logger from './logger.js';

runSierraLeoneIngestion()
  .then(() => {
    logger.info('Scrape cycle finished');
    process.exit(0);
  })
  .catch((err) => {
    logger.fatal(err, 'Scrape failed');
    process.exit(1);
  });
