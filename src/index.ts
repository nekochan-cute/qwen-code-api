#!/usr/bin/env node

import { loadConfig, getUsageText } from './config.js';
import { createProxyServer } from './server.js';
import { OAuthCredentialStore } from './oauth.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.showHelp) {
    process.stdout.write(`${getUsageText()}\n`);
    return;
  }

  const oauthStore = new OAuthCredentialStore({
    credentialsFile: config.credentialsFile,
    tokenRefreshBufferMs: config.tokenRefreshBufferMs,
  });

  const bootCredentials = await oauthStore.getValidCredentials(false);
  const upstreamBaseUrl = oauthStore.getUpstreamBaseUrl(
    bootCredentials,
    config.upstreamBaseUrl,
  );

  const server = createProxyServer({
    config,
    oauthStore,
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => resolve());
  });

  process.stdout.write(
    [
      `qwen-code-api started at http://${config.host}:${config.port}`,
      `Upstream base URL: ${upstreamBaseUrl}`,
      `Credentials file: ${config.credentialsFile}`,
      config.apiKeyGenerated
        ? `Local API key (auto-generated): ${config.apiKey}`
        : 'Local API key: (provided via --api-key or env)',
    ].join('\n') + '\n',
  );

  const shutdown = (signal: string) => {
    process.stderr.write(`Received ${signal}, shutting down...\n`);
    server.close((error) => {
      if (error) {
        process.stderr.write(`Server shutdown error: ${error.message}\n`);
        process.exit(1);
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  process.stderr.write(
    `Failed to start qwen-code-api: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
