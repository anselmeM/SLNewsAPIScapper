import { runSierraLeoneIngestion } from './services/scraper.js';

runSierraLeoneIngestion()
  .then(() => {
    console.log('Scrape cycle finished.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Scrape failed:', err);
    process.exit(1);
  });
