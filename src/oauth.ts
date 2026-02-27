import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_DASHSCOPE_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_OAUTH_TOKEN_ENDPOINT = 'https://chat.qwen.ai/api/v1/oauth2/token';
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';

export interface QwenCredentials {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expiry_date?: number;
  resource_url?: string;
}

interface TokenRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  resource_url?: string;
  error?: string;
  error_description?: string;
}

export class OAuthCredentialsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'OAuthCredentialsError';
  }
}

interface OAuthCredentialStoreOptions {
  credentialsFile: string;
  tokenRefreshBufferMs: number;
}

function parseCredentials(raw: unknown): QwenCredentials {
  if (!raw || typeof raw !== 'object') {
    throw new OAuthCredentialsError(
      'Invalid OAuth credentials JSON format.',
      'invalid_credentials_format',
    );
  }

  const record = raw as Record<string, unknown>;
  const credentials: QwenCredentials = {};

  if (typeof record.access_token === 'string') {
    credentials.access_token = record.access_token;
  }
  if (typeof record.refresh_token === 'string') {
    credentials.refresh_token = record.refresh_token;
  }
  if (typeof record.token_type === 'string') {
    credentials.token_type = record.token_type;
  }
  if (typeof record.expiry_date === 'number') {
    credentials.expiry_date = record.expiry_date;
  }
  if (typeof record.resource_url === 'string') {
    credentials.resource_url = record.resource_url;
  }

  if (!credentials.access_token && !credentials.refresh_token) {
    throw new OAuthCredentialsError(
      'OAuth credentials are missing both access_token and refresh_token.',
      'missing_credentials',
    );
  }

  return credentials;
}

function extractUpstreamErrorMessage(
  payload: string,
  fallback: string,
): string {
  try {
    const parsed = JSON.parse(payload) as TokenRefreshResponse;
    if (parsed.error_description) {
      return parsed.error_description;
    }
    if (parsed.error) {
      return parsed.error;
    }
  } catch {
    // noop
  }

  return payload.trim() ? payload : fallback;
}

export function normalizeResourceUrl(resourceUrl?: string): string {
  const input = resourceUrl?.trim() || DEFAULT_DASHSCOPE_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const normalized = new URL(withProtocol);

  normalized.search = '';
  normalized.hash = '';

  const cleanPath = normalized.pathname.replace(/\/+$/, '');
  if (!cleanPath || cleanPath === '/') {
    normalized.pathname = '/v1';
  } else if (cleanPath.endsWith('/v1')) {
    normalized.pathname = cleanPath;
  } else {
    normalized.pathname = `${cleanPath}/v1`;
  }

  return normalized.toString().replace(/\/$/, '');
}

export function buildUpstreamUrl(
  upstreamBaseUrl: string,
  requestPath: string,
  requestSearch: string,
): string {
  if (!requestPath.startsWith('/v1')) {
    throw new OAuthCredentialsError(
      `Invalid request path for proxy: ${requestPath}`,
      'invalid_proxy_path',
    );
  }

  const upstream = new URL(upstreamBaseUrl);
  const basePath = upstream.pathname.replace(/\/+$/, '');
  const suffix = requestPath === '/v1' ? '' : requestPath.slice('/v1'.length);

  upstream.pathname = `${basePath}${suffix}`;
  upstream.search = requestSearch;
  upstream.hash = '';

  return upstream.toString();
}

export class OAuthCredentialStore {
  private refreshPromise: Promise<QwenCredentials> | null = null;

  constructor(private readonly options: OAuthCredentialStoreOptions) {}

  get credentialsFilePath(): string {
    return this.options.credentialsFile;
  }

  async readCredentials(): Promise<QwenCredentials> {
    let fileContent: string;
    try {
      fileContent = await fs.readFile(this.options.credentialsFile, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new OAuthCredentialsError(
          `OAuth credentials not found: ${this.options.credentialsFile}. Run \`qwen\` and execute \`/auth\` first.`,
          'credentials_not_found',
        );
      }

      throw new OAuthCredentialsError(
        `Failed to read OAuth credentials: ${error instanceof Error ? error.message : String(error)}`,
        'credentials_read_failed',
      );
    }

    try {
      const parsed = JSON.parse(fileContent) as unknown;
      return parseCredentials(parsed);
    } catch (error) {
      if (error instanceof OAuthCredentialsError) {
        throw error;
      }

      throw new OAuthCredentialsError(
        `Invalid OAuth credentials JSON: ${error instanceof Error ? error.message : String(error)}`,
        'credentials_parse_failed',
      );
    }
  }

  async getValidCredentials(forceRefresh = false): Promise<QwenCredentials> {
    const current = await this.readCredentials();

    if (!forceRefresh && this.isTokenValid(current)) {
      return current;
    }

    if (!current.refresh_token) {
      throw new OAuthCredentialsError(
        'OAuth refresh_token is missing. Run `qwen` and execute `/auth` again.',
        'missing_refresh_token',
      );
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshCredentials(current);
    }

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  getUpstreamBaseUrl(
    credentials: QwenCredentials,
    overrideBaseUrl?: string,
  ): string {
    return normalizeResourceUrl(overrideBaseUrl ?? credentials.resource_url);
  }

  private isTokenValid(credentials: QwenCredentials): boolean {
    if (!credentials.access_token) {
      return false;
    }

    if (!credentials.expiry_date) {
      return false;
    }

    return (
      Date.now() < credentials.expiry_date - this.options.tokenRefreshBufferMs
    );
  }

  private async refreshCredentials(
    current: QwenCredentials,
  ): Promise<QwenCredentials> {
    if (!current.refresh_token) {
      throw new OAuthCredentialsError(
        'OAuth refresh_token is missing. Run `qwen` and execute `/auth` again.',
        'missing_refresh_token',
      );
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
      client_id: QWEN_OAUTH_CLIENT_ID,
    });

    let response: Response;
    try {
      response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'x-request-id': randomUUID(),
        },
        body: body.toString(),
      });
    } catch (error) {
      throw new OAuthCredentialsError(
        `Failed to refresh OAuth token: ${error instanceof Error ? error.message : String(error)}`,
        'refresh_network_error',
      );
    }

    const payload = await response.text();
    if (!response.ok) {
      const upstreamMessage = extractUpstreamErrorMessage(
        payload,
        response.statusText,
      );
      const guidance =
        response.status === 400
          ? ' Qwen OAuth credentials may be expired. Run `qwen` and execute `/auth` again.'
          : '';

      throw new OAuthCredentialsError(
        `OAuth refresh failed (${response.status}): ${upstreamMessage}.${guidance}`,
        'refresh_failed',
        response.status,
      );
    }

    let tokenData: TokenRefreshResponse;
    try {
      tokenData = JSON.parse(payload) as TokenRefreshResponse;
    } catch (error) {
      throw new OAuthCredentialsError(
        `OAuth refresh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        'refresh_parse_failed',
      );
    }

    if (!tokenData.access_token || typeof tokenData.access_token !== 'string') {
      throw new OAuthCredentialsError(
        'OAuth refresh response is missing access_token.',
        'refresh_missing_access_token',
      );
    }

    const expiresInSeconds =
      typeof tokenData.expires_in === 'number' && tokenData.expires_in > 0
        ? tokenData.expires_in
        : 3600;

    const nextCredentials: QwenCredentials = {
      access_token: tokenData.access_token,
      refresh_token:
        typeof tokenData.refresh_token === 'string'
          ? tokenData.refresh_token
          : current.refresh_token,
      token_type:
        typeof tokenData.token_type === 'string'
          ? tokenData.token_type
          : current.token_type,
      resource_url:
        typeof tokenData.resource_url === 'string'
          ? tokenData.resource_url
          : current.resource_url,
      expiry_date: Date.now() + expiresInSeconds * 1000,
    };

    await this.saveCredentials(nextCredentials);
    return nextCredentials;
  }

  private async saveCredentials(credentials: QwenCredentials): Promise<void> {
    const credentialsDir = path.dirname(this.options.credentialsFile);
    const tempFilePath = `${this.options.credentialsFile}.tmp.${randomUUID()}`;

    await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });

    const serialized = `${JSON.stringify(credentials, null, 2)}\n`;
    await fs.writeFile(tempFilePath, serialized, { mode: 0o600 });
    await fs.rename(tempFilePath, this.options.credentialsFile);
  }
}
