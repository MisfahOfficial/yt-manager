import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import path from 'node:path';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOOTSTRAP_TOKEN: 'test-bootstrap-token',
            ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
            PBKDF2_ITER: '1000',
            SESSION_HOURS: '5000', // tests jump the clock by days
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.js'], fileParallelism: false },
  };
});
