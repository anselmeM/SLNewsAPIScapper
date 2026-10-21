import 'dotenv/config';
import { prisma } from '../db.js';
import { KNOWN_SCOPES, SCOPES, generateApiKey, hashApiKey, parseScopes, type Scope } from '../auth/apiKeys.js';

/**
 * Customer API key administration.
 *
 * Run through the package scripts (tsx):
 *   npm run keys:create -- --name "Acme News" --scopes v1:read [--expires-at 2027-01-01T00:00:00Z]
 *   npm run keys:list
 *   npm run keys:revoke -- --id 3
 *
 * Keys are stored hashed; the raw `slk_...` value is printed exactly once at
 * creation time and cannot be recovered afterwards.
 */

const USAGE = `Usage:
  api-keys.ts create --name <name> --scopes <scope[,scope...]> [--expires-at <ISO date-time>]
  api-keys.ts list
  api-keys.ts revoke --id <numeric id>

Scopes: ${KNOWN_SCOPES.join(', ')}`;

class CliError extends Error {}

interface ParsedFlags {
  flags: Map<string, string>;
  error?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      return { flags, error: `Unexpected argument: ${arg}` };
    }
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex > 2) {
      flags.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
      continue;
    }
    const name = arg.slice(2);
    const value = args[index + 1];
    if (name.length === 0) return { flags, error: `Invalid flag: ${arg}` };
    if (value === undefined || value.startsWith('--')) {
      return { flags, error: `Missing value for --${name}` };
    }
    flags.set(name, value);
    index++;
  }
  return { flags };
}

function fail(message: string): never {
  throw new CliError(message);
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.trim() === '') fail(`--${name} is required`);
  return value.trim();
}

function parseExpiresAt(raw: string | undefined): Date | null {
  if (raw === undefined) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) fail(`--expires-at is not a valid ISO date-time: ${raw}`);
  if (date.getTime() <= Date.now()) fail('--expires-at must be in the future');
  return date;
}

function parseScopesFlag(raw: string): Scope[] {
  const scopes = parseScopes(raw);
  if (scopes.length === 0) fail('--scopes must contain at least one scope');
  for (const scope of scopes) {
    if (!KNOWN_SCOPES.includes(scope as Scope)) {
      fail(`Unknown scope "${scope}". Valid scopes: ${KNOWN_SCOPES.join(', ')}`);
    }
  }
  return scopes as Scope[];
}

function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function formatDate(value: Date | null | undefined): string {
  return value ? value.toISOString() : '-';
}

/** Checked after argument validation, so bad args report the real problem. */
function requireDatabaseUrl(): void {
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set');
}

async function createKey(args: string[]): Promise<void> {
  const { flags, error } = parseFlags(args);
  if (error) fail(error);

  const name = requireFlag(flags, 'name');
  const scopes = parseScopesFlag(requireFlag(flags, 'scopes'));
  const expiresAt = parseExpiresAt(flags.get('expires-at'));
  requireDatabaseUrl();

  const rawKey = generateApiKey();
  const record = await prisma.apiKey.create({
    data: { name, keyHash: hashApiKey(rawKey), scopes, expiresAt },
    select: { id: true, name: true, scopes: true, expiresAt: true },
  });

  console.log(`Created customer API key #${record.id} (${record.name})`);
  console.log(`Scopes: ${record.scopes.join(', ')}`);
  console.log(`Expires at: ${formatDate(record.expiresAt)}`);
  if (record.scopes.includes(SCOPES.INTERNAL_READ)) {
    console.log('Warning: this key can read the internal full-text /api routes — issue it only to trusted clients.');
  }
  console.log('Copy the key now — it is shown only once and cannot be recovered:');
  console.log('');
  console.log(`  ${rawKey}`);
  console.log('');
}

async function listKeys(): Promise<void> {
  requireDatabaseUrl();
  const today = utcDayStart();
  const keys = await prisma.apiKey.findMany({
    orderBy: { id: 'asc' },
    include: { usage: { where: { day: today }, select: { requests: true } } },
  });

  if (keys.length === 0) {
    console.log('No API keys.');
    return;
  }

  for (const key of keys) {
    const todayRequests = key.usage[0]?.requests ?? 0;
    console.log(
      [
        `#${key.id}`,
        `name=${JSON.stringify(key.name)}`,
        `scopes=[${key.scopes.join(',')}]`,
        `active=${key.active}`,
        `createdAt=${formatDate(key.createdAt)}`,
        `lastUsedAt=${formatDate(key.lastUsedAt)}`,
        `expiresAt=${formatDate(key.expiresAt)}`,
        `todayRequests=${todayRequests}`,
      ].join(' '),
    );
  }
}

async function revokeKey(args: string[]): Promise<void> {
  const { flags, error } = parseFlags(args);
  if (error) fail(error);

  const rawId = requireFlag(flags, 'id');
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) fail(`--id must be a positive integer, got "${rawId}"`);
  requireDatabaseUrl();

  try {
    const record = await prisma.apiKey.update({
      where: { id },
      data: { active: false },
      select: { id: true, name: true, active: true },
    });
    console.log(`Revoked API key #${record.id} (${record.name}). active=${record.active}`);
  } catch (error_) {
    if (typeof error_ === 'object' && error_ !== null && (error_ as { code?: string }).code === 'P2025') {
      console.error(`Error: no API key with id ${id}`);
      process.exitCode = 1;
      return;
    }
    throw error_;
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'create':
      await createKey(args);
      return;
    case 'list':
      await listKeys();
      return;
    case 'revoke':
      await revokeKey(args);
      return;
    case undefined:
      fail('a command is required (create, list or revoke)');
      return;
    default:
      fail(`unknown command "${command}" (expected create, list or revoke)`);
  }
}

main()
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      console.error(`Error: ${error.message}\n\n${USAGE}`);
    } else {
      console.error('Error:', error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
