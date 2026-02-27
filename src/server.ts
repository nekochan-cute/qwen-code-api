import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import type { AppConfig } from './config.js';
import { sendJson, sendOpenAIError } from './errors.js';
import {
  buildUpstreamUrl,
  OAuthCredentialStore,
  OAuthCredentialsError,
} from './oauth.js';

const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

class HttpRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

interface ProxyRuntime {
  config: AppConfig;
  oauthStore: OAuthCredentialStore;
}

interface OpenAIModelCard {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

const LOCAL_OPENAI_MODELS: OpenAIModelCard[] = [
  {
    id: 'coder-model',
    object: 'model',
    created: 0,
    owned_by: 'qwen-oauth',
  },
  {
    id: 'vision-model',
    object: 'model',
    created: 0,
    owned_by: 'qwen-oauth',
  },
];

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.includes('aborted'))
  );
}

function parseBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function verifyLocalApiKey(req: IncomingMessage, apiKey: string): boolean {
  const authHeader =
    typeof req.headers.authorization === 'string'
      ? req.headers.authorization
      : undefined;
  const token = parseBearerToken(authHeader);
  return token === apiKey;
}

function buildUpstreamHeaders(
  incomingHeaders: IncomingHttpHeaders,
  accessToken: string,
): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(incomingHeaders)) {
    const lowerKey = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lowerKey) ||
      lowerKey === 'host' ||
      lowerKey === 'authorization' ||
      lowerKey === 'content-length'
    ) {
      continue;
    }

    if (typeof value === 'undefined') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    headers.set(key, value);
  }

  headers.set('Authorization', `Bearer ${accessToken}`);
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'qwen-code-api/0.1.0');
  }

  return headers;
}

function mayHaveBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD';
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (!mayHaveBody(req.method ?? 'GET')) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buffer.length;

    if (totalSize > MAX_REQUEST_BODY_BYTES) {
      throw new HttpRequestError(
        `Request body is too large (limit: ${MAX_REQUEST_BODY_BYTES} bytes).`,
        413,
        'request_body_too_large',
      );
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return Buffer.concat(chunks);
}

async function requestUpstream(
  runtime: ProxyRuntime,
  req: IncomingMessage,
  requestPath: string,
  requestSearch: string,
  requestBody: Buffer | undefined,
  forceRefresh: boolean,
): Promise<Response> {
  const credentials = await runtime.oauthStore.getValidCredentials(forceRefresh);
  if (!credentials.access_token) {
    throw new OAuthCredentialsError(
      'OAuth access_token is missing. Run `qwen` and execute `/auth` again.',
      'missing_access_token',
    );
  }

  const upstreamBaseUrl = runtime.oauthStore.getUpstreamBaseUrl(
    credentials,
    runtime.config.upstreamBaseUrl,
  );
  const upstreamUrl = buildUpstreamUrl(
    upstreamBaseUrl,
    requestPath,
    requestSearch,
  );
  const upstreamHeaders = buildUpstreamHeaders(req.headers, credentials.access_token);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    runtime.config.requestTimeoutMs,
  );

  const outboundBody = requestBody ? new Uint8Array(requestBody) : undefined;

  try {
    return await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: outboundBody,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new HttpRequestError(
        `Upstream request timed out after ${runtime.config.requestTimeoutMs}ms.`,
        504,
        'upstream_timeout',
      );
    }

    throw new HttpRequestError(
      `Failed to reach upstream API: ${error instanceof Error ? error.message : String(error)}`,
      502,
      'upstream_unavailable',
    );
  } finally {
    clearTimeout(timeout);
  }
}

function copyUpstreamResponseHeaders(
  upstream: Response,
  res: ServerResponse,
): void {
  for (const [key, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    res.setHeader(key, value);
  }
}

async function relayUpstreamResponse(
  upstream: Response,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = upstream.status;
  copyUpstreamResponseHeaders(upstream, res);

  if (!upstream.body) {
    const textBody = await upstream.text();
    res.end(textBody);
    return;
  }

  await pipeline(
    Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>),
    res,
  );
}

async function proxyRequest(
  runtime: ProxyRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  requestSearch: string,
  requestBody: Buffer | undefined,
): Promise<void> {
  const firstResponse = await requestUpstream(
    runtime,
    req,
    requestPath,
    requestSearch,
    requestBody,
    false,
  );

  if (firstResponse.status !== 401) {
    await relayUpstreamResponse(firstResponse, res);
    return;
  }

  try {
    await firstResponse.body?.cancel();
  } catch {
    // noop
  }

  const retryResponse = await requestUpstream(
    runtime,
    req,
    requestPath,
    requestSearch,
    requestBody,
    true,
  );
  await relayUpstreamResponse(retryResponse, res);
}

function handleRequestError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpRequestError) {
    sendOpenAIError(res, error.statusCode, error.message, {
      code: error.code,
      type: error.statusCode === 413 ? 'invalid_request_error' : 'api_error',
    });
    return;
  }

  if (error instanceof OAuthCredentialsError) {
    const statusCode =
      error.statusCode && error.statusCode >= 500 ? 502 : error.statusCode ?? 401;
    sendOpenAIError(res, statusCode, error.message, {
      code: error.code,
      type: statusCode === 401 ? 'authentication_error' : 'api_error',
    });
    return;
  }

  sendOpenAIError(
    res,
    500,
    `Unexpected server error: ${error instanceof Error ? error.message : String(error)}`,
    {
      code: 'internal_error',
      type: 'api_error',
    },
  );
}

function handleLocalModelsEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname !== '/v1/models' && !pathname.startsWith('/v1/models/')) {
    return false;
  }

  if (req.method !== 'GET') {
    sendOpenAIError(
      res,
      405,
      `Method not allowed for ${pathname}. Use GET.`,
      {
        code: 'method_not_allowed',
      },
    );
    return true;
  }

  if (pathname === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: LOCAL_OPENAI_MODELS,
    });
    return true;
  }

  const modelId = decodeURIComponent(pathname.slice('/v1/models/'.length));
  const model = LOCAL_OPENAI_MODELS.find((item) => item.id === modelId);
  if (!model) {
    sendOpenAIError(res, 404, `Model not found: ${modelId}`, {
      code: 'model_not_found',
    });
    return true;
  }

  sendJson(res, 200, model);
  return true;
}

export function createProxyServer(runtime: ProxyRuntime): Server {
  return createServer(async (req, res) => {
    const requestUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? `${runtime.config.host}:${runtime.config.port}`}`,
    );

    if (requestUrl.pathname === '/healthz' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (!verifyLocalApiKey(req, runtime.config.apiKey)) {
      sendOpenAIError(res, 401, 'Invalid or missing API key.', {
        code: 'invalid_api_key',
        type: 'authentication_error',
      });
      return;
    }

    if (handleLocalModelsEndpoint(req, res, requestUrl.pathname)) {
      return;
    }

    if (
      requestUrl.pathname !== '/v1' &&
      !requestUrl.pathname.startsWith('/v1/')
    ) {
      sendOpenAIError(
        res,
        404,
        `Path not found: ${requestUrl.pathname}. Only /v1/* is proxied.`,
        {
          code: 'not_found',
        },
      );
      return;
    }

    try {
      const requestBody = await readRequestBody(req);
      await proxyRequest(
        runtime,
        req,
        res,
        requestUrl.pathname,
        requestUrl.search,
        requestBody,
      );
    } catch (error) {
      handleRequestError(res, error);
    }
  });
}
