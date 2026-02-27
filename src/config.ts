import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_TOKEN_REFRESH_BUFFER_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

const DEFAULT_CREDENTIALS_FILE = path.join(
  os.homedir(),
  '.qwen',
  'oauth_creds.json',
);

export interface AppConfig {
  host: string;
  port: number;
  apiKey: string;
  apiKeyGenerated: boolean;
  credentialsFile: string;
  upstreamBaseUrl?: string;
  tokenRefreshBufferMs: number;
  requestTimeoutMs: number;
  showHelp: boolean;
}

function toNonEmptyString(value: string | undefined, fieldName: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Invalid ${fieldName}: value is required`);
  }
  return normalized;
}

function toOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function toInteger(
  value: string,
  fieldName: string,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${fieldName}: expected integer in [${min}, ${max}]`);
  }
  return parsed;
}

export function getUsageText(): string {
  return [
    'qwen-code-api: local OpenAI-compatible proxy backed by Qwen OAuth',
    '',
    'Usage:',
    '  qwen-code-api [options]',
    '',
    'Options:',
    '  -h, --help                        Show this help',
    `  --host <host>                    Listen host (default: ${DEFAULT_HOST})`,
    `  -p, --port <port>                Listen port (default: ${DEFAULT_PORT})`,
    '  --api-key <key>                  Local API key used by client apps',
    `  --credentials-file <path>        Qwen OAuth credentials file (default: ${DEFAULT_CREDENTIALS_FILE})`,
    '  --upstream-base-url <url>        Override upstream base URL from OAuth resource_url',
    `  --token-refresh-buffer-ms <ms>   Refresh token if expiry is within this window (default: ${DEFAULT_TOKEN_REFRESH_BUFFER_MS})`,
    `  --request-timeout-ms <ms>        Upstream request timeout (default: ${DEFAULT_REQUEST_TIMEOUT_MS})`,
    '',
    'Environment variables:',
    '  QWEN_CODE_API_HOST',
    '  QWEN_CODE_API_PORT',
    '  QWEN_CODE_API_KEY',
    '  QWEN_CODE_OAUTH_CREDENTIALS_PATH',
    '  QWEN_CODE_API_UPSTREAM_BASE_URL',
    '  QWEN_CODE_TOKEN_REFRESH_BUFFER_MS',
    '  QWEN_CODE_API_REQUEST_TIMEOUT_MS',
  ].join('\n');
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: {
        type: 'boolean',
        short: 'h',
      },
      host: {
        type: 'string',
      },
      port: {
        type: 'string',
        short: 'p',
      },
      'api-key': {
        type: 'string',
      },
      'credentials-file': {
        type: 'string',
      },
      'upstream-base-url': {
        type: 'string',
      },
      'token-refresh-buffer-ms': {
        type: 'string',
      },
      'request-timeout-ms': {
        type: 'string',
      },
    },
    strict: true,
    allowPositionals: false,
  });

  const showHelp = values.help ?? false;

  const host = toNonEmptyString(
    values.host ?? env.QWEN_CODE_API_HOST ?? DEFAULT_HOST,
    'host',
  );
  const port = toInteger(
    values.port ?? env.QWEN_CODE_API_PORT ?? String(DEFAULT_PORT),
    'port',
    1,
    65_535,
  );

  const tokenRefreshBufferMs = toInteger(
    values['token-refresh-buffer-ms'] ??
      env.QWEN_CODE_TOKEN_REFRESH_BUFFER_MS ??
      String(DEFAULT_TOKEN_REFRESH_BUFFER_MS),
    'tokenRefreshBufferMs',
    0,
    Number.MAX_SAFE_INTEGER,
  );

  const requestTimeoutMs = toInteger(
    values['request-timeout-ms'] ??
      env.QWEN_CODE_API_REQUEST_TIMEOUT_MS ??
      String(DEFAULT_REQUEST_TIMEOUT_MS),
    'requestTimeoutMs',
    1,
    Number.MAX_SAFE_INTEGER,
  );

  const credentialsFile = toNonEmptyString(
    values['credentials-file'] ??
      env.QWEN_CODE_OAUTH_CREDENTIALS_PATH ??
      DEFAULT_CREDENTIALS_FILE,
    'credentialsFile',
  );

  const upstreamBaseUrl = toOptionalString(
    values['upstream-base-url'] ?? env.QWEN_CODE_API_UPSTREAM_BASE_URL,
  );

  let apiKey = toOptionalString(values['api-key'] ?? env.QWEN_CODE_API_KEY);
  let apiKeyGenerated = false;

  if (!apiKey) {
    apiKey = randomBytes(24).toString('hex');
    apiKeyGenerated = true;
  }

  return {
    host,
    port,
    apiKey,
    apiKeyGenerated,
    credentialsFile,
    upstreamBaseUrl,
    tokenRefreshBufferMs,
    requestTimeoutMs,
    showHelp,
  };
}
