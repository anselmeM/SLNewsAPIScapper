import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
// Vitest sets NODE_ENV=test. Keep the suite quiet and skip the pino-pretty
// transport (a worker thread per process) so parallel test files do not compete
// for CPU and the reporter output stays readable.
const isTest = process.env.NODE_ENV === 'test';

/**
 * Credential-bearing request headers that must never reach the logs.
 *
 * pino-http serialises the incoming request (headers included) on every request,
 * so without redaction an `Authorization: Bearer <API_KEY>` header — or a Clerk
 * session JWT / session cookie — would land in the log stream, and therefore in
 * the hosting provider's log retention. The list is exported so a unit test can
 * build a pino instance with the same configuration and prove the token never
 * appears, rather than trusting the option by inspection.
 */
export const LOG_REDACT_PATHS: string[] = ['req.headers.authorization', 'req.headers.cookie'];

/** pino redaction options for the pino-http request logger. */
export const LOG_REDACTION = { paths: LOG_REDACT_PATHS, censor: '[redacted]' };

const logger = pino({
  level: isTest ? 'silent' : process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  ...(!isProduction &&
    !isTest && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    }),
});

export default logger;
