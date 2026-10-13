import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import configuration from '../wrangler.toml?raw';

// What the design (section 10) asks of wrangler.toml, and the bindings the test worker gets from it.

describe('wrangler.toml', () => {
  it('turns invocation logs off, because the gateway entrypoint receives the requests of crawler code', () => {
    expect(configuration).toMatch(/^invocation_logs = false$/m);
    expect(configuration).not.toMatch(/invocation_logs = true/);
    expect(configuration).toMatch(/^enabled = true$/m);
  });

  it('declares the loader, the bucket of the files, the vault and the cleanup cron', () => {
    expect(configuration).toMatch(/\[\[worker_loaders\]\]\s+binding = "LOADER"/);
    expect(configuration).toMatch(/\[\[r2_buckets\]\]\s+binding = "CRAWLER_FILES"\s+bucket_name = "audio-underview-crawler-files"/);
    expect(configuration).toMatch(/\[\[services\]\]\s+binding = "USER_VAULT"\s+service = "audio-underview-user-vault-worker"/);
    expect(configuration).toMatch(/\[triggers\]\s+(#.*\s+)*crons = \["\*\/15 \* \* \* \*"\]/);
  });

  it('gives the worker the bindings of the runtime', () => {
    expect(typeof env.LOADER.get).toBe('function');
    expect(typeof env.CRAWLER_FILES.put).toBe('function');
    expect(typeof env.USER_VAULT.fetch).toBe('function');
  });
});
