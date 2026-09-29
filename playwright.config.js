const { defineConfig, devices } = require('@playwright/test');

// Overridable so parallel worktrees don't share a port or database.
const port = process.env.E2E_PORT ?? '8791';
const db = process.env.E2E_DATABASE_URL ?? 'postgres://buttery:buttery@localhost:5433/buttery_e2e';

module.exports = defineConfig({
  testDir: './tests/e2e',
  // One worker, files in name order: 01-review runs before 02-inventory against one seeded DB.
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'on-first-retry' },
  projects: [{ name: 'phone', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'npm run build -w apps/web && npm run e2e:server -w apps/server',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      DATABASE_URL: db,
      PORT: port,
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1234',
    },
  },
});
