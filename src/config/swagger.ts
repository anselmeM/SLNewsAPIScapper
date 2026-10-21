import { existsSync } from 'node:fs';
import path from 'node:path';
import swaggerJsdoc from 'swagger-jsdoc';

/**
 * Shared description of the credentials every protected route accepts: the
 * static `API_KEY` bearer token the SLNews app sends today, or — when
 * `CLERK_SECRET_KEY` is configured — a Clerk session JWT on the same header.
 */
export const AUTH_DESCRIPTION =
  'Static API key (API_KEY), or a Clerk session JWT when CLERK_SECRET_KEY is configured — either as `Authorization: Bearer <token>`.';

/**
 * Where swagger-jsdoc should read operation JSDoc from.
 *
 * In development and tests the TypeScript sources are present; the production
 * image ships only the compiled `dist/` output, so the spec would silently be
 * empty there unless it falls back to the emitted JavaScript (tsc preserves the
 * JSDoc comments). `existsSync` makes the choice deterministic at startup.
 *
 * Glob strings are forward-slashed so the same pattern works on Windows and on
 * the Linux production image.
 */
export function resolveApiGlobs(baseDir: string = process.cwd()): string[] {
  const toGlob = (dir: string, extension: 'ts' | 'js') => `${dir.split(path.sep).join('/')}/*.${extension}`;
  const srcRoutes = path.join(baseDir, 'src', 'routes');
  if (existsSync(srcRoutes)) return [toGlob(srcRoutes, 'ts')];
  return [toGlob(path.join(baseDir, 'dist', 'routes'), 'js')];
}

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Sierra Leone News API',
      version: '1.0.0',
      description: 'Aggregated news articles from Sierra Leone news outlets',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Local' },
      { url: 'https://sl-news-api.onrender.com', description: 'Production' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: AUTH_DESCRIPTION,
        },
      },
    },
  },
  apis: resolveApiGlobs(),
};

export const swaggerSpec = swaggerJsdoc(options);

// The two business endpoints carry their own prose in route JSDoc, and the
// route files are outside this change's write scope, so the auth note is
// appended to their operation descriptions here instead. Payload contracts are
// untouched — this only adds documentation.
const AUTH_NOTE = `Authentication: ${AUTH_DESCRIPTION}`;
type OperationDocs = { description?: string };
const specPaths = (swaggerSpec as { paths?: Record<string, { get?: OperationDocs }> }).paths ?? {};

for (const path of ['/api/news', '/v1/news']) {
  const operation = specPaths[path]?.get;
  if (!operation) continue;
  operation.description = operation.description ? `${operation.description}\n\n${AUTH_NOTE}` : AUTH_NOTE;
}
