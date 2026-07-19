import { runSierraLeoneIngestion } from './services/scraper.js';
import app from './server.js';

const PORT = process.env.PORT || 3000;
const args = process.argv.slice(2);

async function main() {
  await runSierraLeoneIngestion();

  if (!args.includes('--scrape-only')) {
    app.listen(PORT, () => {
      console.log(`Sierra Leone News API running on port ${PORT}`);
    });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
