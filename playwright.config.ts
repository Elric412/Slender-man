import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------------------------------------------------------------------------
 * Headless audio device.
 *
 * This sandbox (and most CI images) has no sound card, no PulseAudio daemon and
 * no ALSA plugin libraries. Chromium's audio service nevertheless opens a real
 * output stream; with nothing to consume the samples its render callback times
 * out forever —
 *
 *   audio_manager_linux.cc] Falling back to ALSA ... could not be initialized
 *   sync_reader.cc] SyncReader::Read timed out, audio glitch count=10
 *   sync_reader.cc] ASR: No room in socket buffer.: Broken pipe (32)
 *
 * — and the browser can then no longer be torn down, so every audio test dies
 * on `browserContext.close: Test ended.` even though its body passed.
 *
 * Things that do NOT fix it, all verified here:
 *   - `--mute-audio` only zeroes samples; the device is still opened.
 *   - `--disable-audio-output` is not honoured by chromium_headless_shell.
 *   - Forcing the audio service in-process turns the stall into a SIGSEGV.
 *
 * The actual fix lives in the app: audio specs boot with `?silentaudio=1`, which
 * builds the AudioContext on Chromium's silent sink (`sinkId: {type:'none'}`).
 * The graph is still rendered on the real audio clock — worklets execute and
 * AnalyserNode meters read true values — but no device is ever opened.
 * See src/audio/README-AUDIO.md §13 and src/audio/AudioBuses.ts.
 *
 * What remains here is defence in depth for the *non-audio* specs, which also
 * bring up an AudioContext incidentally:
 *
 *   1. A null ALSA sink (below). `type null` is compiled into libasound core, so
 *      pointing the default PCM at it needs no plugin .so on disk; it gives
 *      libasound a device that accepts and discards samples instead of failing
 *      to open one at all. NB it accepts them *instantly*, so it cures the
 *      "Unknown PCM default" failure but not thread starvation — which is
 *      precisely why the silent sink above is the real answer, not this.
 *   2. A large audio buffer, widening the deadline the audio thread must meet.
 *
 * ALSA_CONFIG_PATH is read by libasound inside the browser process, so it is
 * handed over explicitly through launchOptions.env below. Setting it on
 * process.env here is NOT sufficient: Playwright spawns the browser from a
 * separate worker process which does not inherit this file's mutations. */
// The project is an ES module, so __dirname does not exist here.
const HERE = dirname(fileURLToPath(import.meta.url));
const ALSA_NULL_CONF = resolve(HERE, 'tests/support/asound-null.conf');

/* STATIC — Playwright harness.
 * Runs against a `vite preview` build (production bundle, service-worker path
 * included) using SwiftShader so WebGL2 works fully headless in CI/sandbox.
 *
 * Run: npm test          (build + tests)
 *      npx playwright test --headed   (watch it locally) */

export default defineConfig({
  testDir: './tests',
  // Software rasterisation on 2 cores: world build + audio graph bring-up alone
  // can take ~30 s, and the audio tests then wait out real Director escalation.
  timeout: 240_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1, // WebGL contexts under SwiftShader are heavy — serialize.
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: {
      // Must be passed through launchOptions.env: Playwright spawns the browser
      // from a worker process, so mutating process.env in this config file is
      // NOT inherited by it. (That was the reason an earlier attempt at this
      // fix appeared to do nothing.) Spreading process.env keeps PATH etc.
      env: { ...process.env, ALSA_CONFIG_PATH: ALSA_NULL_CONF },
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-sandbox',

        /* ---- audio, headless ----------------------------------------------
         * See the ALSA_CONFIG_PATH note at the top of this file for the null
         * PCM sink. The other half of the problem is scheduling: this sandbox
         * has 2 cores, and SwiftShader saturates both, so the audio render
         * thread misses its ~2.7 ms deadline (128 frames @ 48 kHz) and logs
         * `SyncReader::Read timed out` until the stream wedges.
         *
         * A 4096-frame buffer (~85 ms) gives the audio thread 30x more slack,
         * which is enough to survive a software-rasterised frame. It only
         * affects output latency, which no assertion depends on. */
        '--audio-buffer-size=4096',
        '--mute-audio',
        // The audio service must stay sandboxed-but-separate: in-process it
        // SIGSEGVs on teardown in this image.
        '--disable-features=AudioServiceSandbox',
        // Let AudioContext.resume() succeed without a trusted gesture so the
        // meters are measurable; production still unlocks on first real input.
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    // Tracing is off by default: on a 985 MB / 2-core runner, serialising a
    // failed test's trace zip (it embeds SwiftShader screenshots) can take
    // longer than the test itself, and was observed to hang teardown outright —
    // an audio test would pass every assertion and still fail the run with
    // `browserContext.close: Test ended.`
    // Re-enable when actually debugging: `--trace=retain-on-failure`.
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
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
