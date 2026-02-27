# qwen-code-api

[日本語](./README_ja.md)

`qwen-code-api` provides a local OpenAI-compatible endpoint (`/v1/*`) using the OAuth session created by `qwen-code`.

You can point other coding tools (Roo Code, Cline, SDKs, etc.) to this server as a standard OpenAI API base URL.

## qwen-code References

- Official `qwen-code` repository: <https://github.com/QwenLM/qwen-code>
- `qwen-code` authentication docs: <https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/auth.md>
- This project reads the same OAuth cache file used by `qwen-code`: `~/.qwen/oauth_creds.json`

## Features

- `GET /healthz` for liveness checks
- Local `GET /v1/models` and `GET /v1/models/:id` (`coder-model`, `vision-model`)
- Transparent proxy for other `/v1/*` requests to Qwen OpenAI-compatible upstream
- Auto resolve upstream endpoint from OAuth `resource_url`
- Auto refresh expired `access_token` using `refresh_token` and retry once
- Local API key guard (`Authorization: Bearer <key>`) for inbound requests

## Prerequisites

1. You have logged in via `qwen-code`
2. `~/.qwen/oauth_creds.json` exists

If not logged in yet, run `qwen` first and complete `/auth`.

## Setup

```bash
cd /home/moon/qwen-api/qwen-code-api
npm install
```

## Run

```bash
npm run dev -- --port 8787 --api-key my-local-key
```

Build + run:

```bash
npm run build
npm run start -- --port 8787 --api-key my-local-key
```

## Use from Other Coders

Set your target tool to OpenAI-compatible mode:

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="my-local-key"
```

`curl` example:

```bash
curl "http://127.0.0.1:8787/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-local-key" \
  -d '{
    "model": "coder-model",
    "messages": [
      {"role": "user", "content": "hello"}
    ]
  }'
```

## Main Options

- `--host` (default: `127.0.0.1`)
- `--port` (default: `8787`)
- `--api-key` (auto-generated if omitted)
- `--credentials-file` (default: `~/.qwen/oauth_creds.json`)
- `--upstream-base-url` (manual override for OAuth `resource_url`)
- `--token-refresh-buffer-ms` (default: `30000`)
- `--request-timeout-ms` (default: `120000`)

Run `--help` for the full list.

## Environment Variables

- `QWEN_CODE_API_HOST`
- `QWEN_CODE_API_PORT`
- `QWEN_CODE_API_KEY`
- `QWEN_CODE_OAUTH_CREDENTIALS_PATH`
- `QWEN_CODE_API_UPSTREAM_BASE_URL`
- `QWEN_CODE_TOKEN_REFRESH_BUFFER_MS`
- `QWEN_CODE_API_REQUEST_TIMEOUT_MS`

## Security Notes

- Default `host=127.0.0.1` is local-only.
- If you bind to `0.0.0.0`, use a strong API key and network-level restrictions.
