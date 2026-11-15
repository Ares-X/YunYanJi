import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function state(page: Page) {
  return page.evaluate(() => window.__YUNYANJI__!.getState());
}

test('renders a procedural scene, supports interaction and releases its resources', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const requests: { url: string; type: string }[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', (request) => requests.push({ url: request.url(), type: request.resourceType() }));
  await page.goto('/?debug=1&seed=qa-snow');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect.poll(async () => Number((await state(page)).frames)).toBeGreaterThan(2);
  expect((await state(page)).audioContext).toBe('uninitialized');
  expect(Number((await state(page)).triangles)).toBeGreaterThan(1000);
  expect(Number((await state(page)).calls)).toBeGreaterThan(1);
  expect(Number((await state(page)).calls)).toBeLessThan(80);
  expect((await state(page)).contactBakes).toBe(1);
  expect(Number((await state(page)).reflectionUpdates)).toBeGreaterThan(0);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const frozen = (await state(page)).elapsed;
  await page.waitForTimeout(250);
  expect((await state(page)).elapsed).toBe(frozen);
  const pausedReflection = (await state(page)).reflectionUpdates;
  // Pixel readback on software-only CI has a different budget from UI actions.
  await page.screenshot({ path: testInfo.outputPath('courtyard.png'), timeout: 45_000, animations: 'disabled', scale: 'css' });
  await testInfo.attach('courtyard', { path: testInfo.outputPath('courtyard.png'), contentType: 'image/png' });
  expect((await state(page)).reflectionUpdates).toBe(pausedReflection);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await expect(page.locator('#hint')).toHaveText('已暂停，点继续或起风');
  for (const selector of ['.masthead', '.verse', '.scene-footer']) {
    const box = await page.locator(selector).boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  }

  await page.getByRole('button', { name: '起风', exact: true }).click();
  await expect.poll(async () => Number((await state(page)).gust)).toBeGreaterThan(0.005);
  expect((await state(page)).paused).toBe(false);
  for (const distance of [40, 20]) {
    const before = Number((await state(page)).viewX);
    await page.mouse.move(100, 400);
    await page.mouse.down();
    await page.mouse.move(100 + distance, 400, { steps: 3 });
    await page.mouse.up();
    expect(Number((await state(page)).viewX)).toBeGreaterThan(before);
  }
  await page.getByRole('button', { name: '声音 关', exact: true }).click();
  await expect.poll(async () => (await state(page)).audioState).toBe('playing');
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(async () => (await state(page)).audioContext).toBe('suspended');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect.poll(async () => (await state(page)).audioState).toBe('playing');

  await page.getByRole('button', { name: '诗文', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#poem-text')).toContainText('未若柳絮因风起');
  await expect.poll(async () => (await state(page)).suspended).toBe(true);
  await page.getByRole('button', { name: '关闭诗文' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect.poll(async () => (await state(page)).audioState).toBe('playing');
  await page.getByRole('slider', { name: '声音音量', exact: true }).press('Home');
  await page.getByRole('slider', { name: '声音音量', exact: true }).press('ArrowRight');
  expect((await state(page)).audioVolume).toBe(0.01);
  const beforeQuality = await state(page);
  await page.getByRole('combobox', { name: '画质', exact: true }).selectOption('low');
  expect((await state(page)).quality).toBe('low');
  expect((await state(page)).geometries).toBe(beforeQuality.geometries);
  expect((await state(page)).contactBakes).toBe(beforeQuality.contactBakes);
  expect((await state(page)).reflectionSize).toBe(256);
  // A quality change schedules its static redraw on the next animation frame.
  await expect.poll(async () => Number((await state(page)).reflectionUpdates))
    .toBeGreaterThan(Number(beforeQuality.reflectionUpdates));
  await page.getByLabel('雪量', { exact: true }).press('Home');
  // Two native keyboard increments exercise the control without queuing twenty
  // redundant WebGL redraws on a software-only runner.
  for (let i = 0; i < 2; i++) await page.getByLabel('雪量', { exact: true }).press('ArrowRight');
  expect((await state(page)).snow).toBe(0.02);
  await page.screenshot({ path: testInfo.outputPath('settings.png'), timeout: 45_000, animations: 'disabled', scale: 'css' });
  await testInfo.attach('settings', { path: testInfo.outputPath('settings.png'), contentType: 'image/png' });
  await page.getByRole('button', { name: '重看此境' }).click();
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  expect(Number((await state(page)).elapsed)).toBeLessThan(2);
  await page.getByRole('button', { name: '声音 开', exact: true }).click();
  await expect.poll(async () => (await state(page)).audioState).toBe('off');

  expect(requests.filter(({ type }) => ['image', 'media', 'font'].includes(type))).toEqual([]);
  expect(requests.filter(({ url }) => !url.startsWith('http://127.0.0.1:4173/'))).toEqual([]);
  expect(errors).toEqual([]);
  await testInfo.attach('runtime-diagnostics', { body: JSON.stringify(await state(page), null, 2), contentType: 'application/json' });
  await page.evaluate(() => window.__YUNYANJI__!.dispose());
  await expect.poll(async () => (await state(page)).audioContext).toBe('closed');
  expect((await state(page)).disposed).toBe(true);
  expect((await state(page)).geometries).toBe(0);
  expect((await state(page)).textures).toBe(0);
});

test('starts still for reduced motion and recovers from WebGL context loss', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?debug=1&seed=qa-snow');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  expect((await state(page)).paused).toBe(true);
  expect((await state(page)).elapsed).toBe(0);
  await page.evaluate(async () => { await document.fonts.ready; });
  await expect.poll(async () => Number((await state(page)).reflectionUpdates)).toBeGreaterThan(0);
  const before = await page.screenshot({
    path: testInfo.outputPath('before-restoration.png'), timeout: 45_000, animations: 'disabled', scale: 'css',
  });
  await testInfo.attach('before-restoration', { path: testInfo.outputPath('before-restoration.png'), contentType: 'image/png' });
  const contactBakes = Number((await state(page)).contactBakes);
  const reflectionUpdates = Number((await state(page)).reflectionUpdates);
  const supported = await page.evaluate(() => {
    const gl = document.querySelector('canvas')!.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    extension.loseContext();
    setTimeout(() => extension.restoreContext(), 350);
    return true;
  });
  expect(supported).toBe(true);
  await expect(page.locator('#app')).toHaveAttribute('data-context', 'ready', { timeout: 30_000 });
  expect((await state(page)).contextLost).toBe(false);
  expect((await state(page)).paused).toBe(true);
  expect(Number((await state(page)).contactBakes)).toBe(contactBakes + 1);
  expect(Number((await state(page)).reflectionUpdates)).toBeGreaterThan(reflectionUpdates);
  const restored = await page.screenshot({ path: testInfo.outputPath('restored.png'), timeout: 45_000, animations: 'disabled', scale: 'css' });
  await testInfo.attach('restored', { path: testInfo.outputPath('restored.png'), contentType: 'image/png' });
  // Compare runtime captures of the same frozen scene. The central region omits
  // the recovery notification but includes the courtyard's indirect lighting.
  const difference = await page.evaluate(async ({ beforePng, restoredPng }) => {
    const decode = async (encoded: string) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    };
    const [initialImage, restoredImage] = await Promise.all([decode(beforePng), decode(restoredPng)]);
    try {
      if (initialImage.width !== restoredImage.width || initialImage.height !== restoredImage.height) {
        throw new Error('Context restoration changed screenshot dimensions');
      }
      const x = Math.floor(initialImage.width * 0.1);
      const y = Math.floor(initialImage.height * 0.35);
      const width = Math.floor(initialImage.width * 0.9) - x;
      const height = Math.floor(initialImage.height * 0.7) - y;
      const pixels = (bitmap: ImageBitmap) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };
      const initialPixels = pixels(initialImage);
      const restoredPixels = pixels(restoredImage);
      let absoluteRgbDifference = 0;
      for (let pixel = 0; pixel < initialPixels.length; pixel += 4) {
        for (let channel = 0; channel < 3; channel++) {
          absoluteRgbDifference += Math.abs(initialPixels[pixel + channel]! - restoredPixels[pixel + channel]!);
        }
      }
      return {
        meanAbsoluteRgbDifference: absoluteRgbDifference / (width * height * 3),
        region: { x, y, width, height },
      };
    } finally {
      initialImage.close();
      restoredImage.close();
    }
  }, { beforePng: before.toString('base64'), restoredPng: restored.toString('base64') });
  await testInfo.attach('restoration-image-difference', {
    body: JSON.stringify(difference, null, 2), contentType: 'application/json',
  });
  expect(difference.meanAbsoluteRgbDifference, 'Context restoration must preserve the frozen scene lighting').toBeLessThan(2);
  expect(errors).toEqual([]);
});
