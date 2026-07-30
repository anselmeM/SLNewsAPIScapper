import { runSierraLeoneIngestion } from './services/scraper.js';
import logger from './logger.js';

const args = process.argv.slice(2);

async function main() {
  await runSierraLeoneIngestion();

  if (!args.includes('--scrape-only')) {
    await import('./server.js');
  }
}

main().catch((err) => {
  logger.fatal(err, 'Fatal error');
  process.exit(1);
});
