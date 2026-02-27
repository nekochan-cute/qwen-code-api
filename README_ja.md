# qwen-code-api

[English](./README.md)

`qwen-code` の OAuth キャッシュ (`~/.qwen/oauth_creds.json`) を使って、ローカルに OpenAI 互換 API (`/v1/*`) を公開するプロキシです。

Roo Code や Cline などの外部コーダー/エージェントから、通常の OpenAI 互換エンドポイントとして利用できます。

## qwen-code 参照

- `qwen-code` 公式リポジトリ: <https://github.com/QwenLM/qwen-code>
- `qwen-code` 認証ドキュメント: <https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/auth.md>
- 本プロジェクトは `qwen-code` と同じ OAuth キャッシュファイル `~/.qwen/oauth_creds.json` を利用します

## できること

- `GET /healthz` でヘルスチェック
- `GET /v1/models` / `GET /v1/models/:id` をローカルで提供（`coder-model`, `vision-model`）
- それ以外の `ANY /v1/*` を上流 Qwen OpenAI 互換エンドポイントへ透過転送
- OAuth の `resource_url` から上流エンドポイントを自動解決
- `access_token` 期限切れ時に `refresh_token` で自動更新して 1 回再試行
- ローカル API キー (`Authorization: Bearer <key>`) でアクセス制御

## 前提

1. `qwen-code` で OAuth ログイン済みであること
2. `~/.qwen/oauth_creds.json` が存在すること

未ログインの場合は、先に `qwen` を起動して `/auth` を実行してください。

## セットアップ

```bash
cd /home/moon/qwen-api/qwen-code-api
npm install
```

## 起動

```bash
npm run dev -- --port 8787 --api-key my-local-key
```

ビルドして起動する場合:

```bash
npm run build
npm run start -- --port 8787 --api-key my-local-key
```

## 他のコーダーから使う

接続先を OpenAI 互換として設定します。

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="my-local-key"
```

`curl` 例:

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

## 主なオプション

- `--host` (default: `127.0.0.1`)
- `--port` (default: `8787`)
- `--api-key` (未指定時は起動時にランダム生成)
- `--credentials-file` (default: `~/.qwen/oauth_creds.json`)
- `--upstream-base-url` (`resource_url` を手動上書き)
- `--token-refresh-buffer-ms` (default: `30000`)
- `--request-timeout-ms` (default: `120000`)

`--help` で一覧を表示できます。

## 環境変数

- `QWEN_CODE_API_HOST`
- `QWEN_CODE_API_PORT`
- `QWEN_CODE_API_KEY`
- `QWEN_CODE_OAUTH_CREDENTIALS_PATH`
- `QWEN_CODE_API_UPSTREAM_BASE_URL`
- `QWEN_CODE_TOKEN_REFRESH_BUFFER_MS`
- `QWEN_CODE_API_REQUEST_TIMEOUT_MS`

## セキュリティ注意

- 既定の `host=127.0.0.1` はローカル専用です。
- `0.0.0.0` で公開する場合は、必ず強い API キーとネットワーク制限を併用してください。
