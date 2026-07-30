import { defineConfig } from '@playwright/test';

/* STATIC — Playwright harness.
 * Runs against a `vite preview` build (production bundle, service-worker path
 * included) using SwiftShader so WebGL2 works fully headless in CI/sandbox.
 *
 * Run: npm test          (build + tests)
 *      npx playwright test --headed   (watch it locally) */

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1, // WebGL contexts under SwiftShader are heavy — serialize.
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://localhost:4173',
    launchOptions: {
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-sandbox',
        '--mute-audio',
      ],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1920, height: 1080 } },
    },
    {
      name: 'mobile',
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],
});
