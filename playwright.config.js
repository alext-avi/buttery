const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  // One worker, files in name order: 01-review runs before 02-inventory against one seeded DB.
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8791', trace: 'on-first-retry' },
  projects: [{ name: 'phone', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'npm run build -w apps/web && npm run e2e:server -w apps/server',
    url: 'http://127.0.0.1:8791/healthz',
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      DATABASE_URL: 'postgres://buttery:buttery@localhost:5433/buttery_e2e',
      PORT: '8791',
      PUBLIC_BASE_URL: 'http://127.0.0.1:8791',
      SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1234',
    },
  },
});
