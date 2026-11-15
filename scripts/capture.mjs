import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, devices } from '@playwright/test';
import { build, preview } from 'vite';
import { chromiumLaunchOptions } from './browser-options.ts';

const { values } = parseArgs({
  options: {
    device: { type: 'string', default: 'all' },
    seed: { type: 'string', default: 'yunyanji-rainfire-01' },
    seconds: { type: 'string', default: '0' },
    dpr: { type: 'string' },
    scale: { type: 'string', default: 'css' },
    output: { type: 'string', default: 'test-results/captures' },
    'skip-build': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run capture -- [options]
  --device all|desktop|mobile   Viewports to capture (default: all)
  --seed VALUE                  Reproducible landscape seed (default: yunyanji-rainfire-01)
  --seconds NUMBER              Let the scene animate before capture, 0–30 (default: 0)
  --dpr NUMBER                  Emulate display pixel ratio, 1–3 (default: device profile)
  --scale css|device            CSS-size preview or full device-pixel capture (default: css)
  --output DIRECTORY            Destination (default: test-results/captures)
  --skip-build                  Reuse an already current dist/ build

Uses Playwright's bundled Chromium by default. Set either
PLAYWRIGHT_CHROMIUM_CHANNEL=chrome for installed Chrome or
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH for an existing browser binary.
PLAYWRIGHT_SOFTWARE_RENDERING=0 leaves GPU selection to the browser.
The command starts and stops its own local preview server and browser.`);
} else {
  await capture();
}

async function capture() {
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) throw new Error('--seconds must be between 0 and 30.');
  const dpr = values.dpr === undefined ? undefined : Number(values.dpr);
  if (dpr !== undefined && (!Number.isFinite(dpr) || dpr < 1 || dpr > 3)) throw new Error('--dpr must be between 1 and 3.');
  if (values.scale !== 'css' && values.scale !== 'device') throw new Error('--scale must be css or device.');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const output = resolve(root, values.output);
  const profiles = [
    { name: 'desktop', options: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', options: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ].filter((profile) => values.device === 'all' || profile.name === values.device);
  if (profiles.length === 0) throw new Error('--device must be all, desktop, or mobile.');

  let server;
  let browser;
  try {
    const launchOptions = chromiumLaunchOptions();
    if (!values['skip-build']) await build({ root, logLevel: 'warn' });
    await mkdir(output, { recursive: true });
    // An ephemeral loopback port avoids an existing development/preview server.
    server = await preview({ root, logLevel: 'error', preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('The local preview did not receive a TCP port.');
    const url = new URL(`http://127.0.0.1:${address.port}/`);
    url.search = new URLSearchParams({ debug: '1', seed: values.seed }).toString();
    browser = await chromium.launch({ ...launchOptions, headless: true });
    const report = {
      capturedAt: new Date().toISOString(),
      browser: browser.version(),
      browserSelection: launchOptions.channel ?? (launchOptions.executablePath ? 'custom executable' : 'Playwright Chromium'),
      renderingRequested: launchOptions.args?.includes('--use-angle=swiftshader')
        ? 'SwiftShader software rendering requested'
        : 'Browser default requested; hardware acceleration is not guaranteed',
      seed: values.seed,
      requestedElapsed: seconds,
      captures: [],
    };
    for (const profile of profiles) {
      // A reduced-motion initial frame freezes weather without racing frame timing.
      const context = await browser.newContext({ ...profile.options,
        ...(dpr === undefined ? {} : { deviceScaleFactor: dpr }), reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto(url.href, { waitUntil: 'load', timeout: 45_000 });
        await page.locator('#app[data-ready="true"]').waitFor({ timeout: 60_000 });
        await page.evaluate(() => document.fonts.ready);
        if (seconds > 0) {
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await page.getByRole('button', { name: '继续', exact: true }).click();
          await page.waitForFunction((elapsed) => Number(window.__YUNYANJI__?.getState().elapsed) >= elapsed,
            seconds, { timeout: 60_000 });
          await page.getByRole('button', { name: '暂停', exact: true }).click();
          // The final paused state can wait behind an in-flight GPU frame.
          // Capture the submitted static redraw, not an earlier animation frame.
          await page.waitForFunction(() => {
            const snapshot = window.__YUNYANJI__?.getState();
            return snapshot && Number(snapshot.renderedElapsed) >= Number(snapshot.elapsed);
          }, undefined, { timeout: 45_000 });
        }
        const state = await page.evaluate(() => window.__YUNYANJI__?.getState());
        if (!state || !(Number(state.triangles) > 0) || state.contextLost) throw new Error(`${profile.name}: no ready WebGL frame.`);
        const webgl = await page.evaluate(() => {
          const gl = document.querySelector('canvas')?.getContext('webgl2');
          if (!gl) return { renderer: null, source: 'unavailable' };
          const extension = gl.getExtension('WEBGL_debug_renderer_info');
          const unmasked = extension && gl.getParameter(extension.UNMASKED_RENDERER_WEBGL);
          if (typeof unmasked === 'string' && unmasked) return { renderer: unmasked, source: 'WEBGL_debug_renderer_info' };
          return { renderer: gl.getParameter(gl.RENDERER), source: 'RENDERER' };
        });
        const filename = `${profile.name}.png`;
        await page.screenshot({ path: resolve(output, filename), timeout: 45_000, animations: 'disabled', scale: values.scale });
        report.captures.push({ device: profile.name, viewport: profile.options.viewport,
          devicePixelRatio: await page.evaluate(() => window.devicePixelRatio), file: filename, webgl, state, errors });
        await writeFile(resolve(output, 'capture.json'), `${JSON.stringify(report, null, 2)}\n`);
        console.log(`${profile.name}: ${resolve(output, filename)}`);
        if (errors.length > 0) throw new Error(`${profile.name}: browser errors:\n${errors.join('\n')}`);
      } finally {
        await context.close();
      }
    }
    console.log(`Browser: ${report.browser} (${report.browserSelection}); local captures complete.`);
  } finally {
    try { await browser?.close(); }
    finally { await server?.close(); }
  }
}
