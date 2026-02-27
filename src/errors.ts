import type { ServerResponse } from 'node:http';

interface OpenAIErrorShape {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  if (res.writableEnded) {
    return;
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

export function sendOpenAIError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  options?: {
    type?: string;
    code?: string | null;
    param?: string | null;
  },
): void {
  const payload: OpenAIErrorShape = {
    error: {
      message,
      type: options?.type ?? 'invalid_request_error',
      param: options?.param ?? null,
      code: options?.code ?? null,
    },
  };

  writeJson(res, statusCode, payload);
}

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  writeJson(res, statusCode, payload);
}
