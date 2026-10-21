import 'dotenv/config';
import { assertRuntimeEnv } from './config/env.js';
import { runSierraLeoneIngestion } from './services/scraper.js';
import logger from './logger.js';

const args = process.argv.slice(2);

async function main() {
  // Combined entrypoint: `--scrape-only` never starts the HTTP server, so it only
  // needs the database; the default mode also requires production API credentials.
  assertRuntimeEnv({ requireApiCredentials: !args.includes('--scrape-only') });

  await runSierraLeoneIngestion();

  if (!args.includes('--scrape-only')) {
    await import('./server.js');
  }
}

main().catch((err) => {
  logger.fatal(err, 'Fatal error');
  process.exit(1);
});
