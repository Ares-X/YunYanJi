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
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const frozen = (await state(page)).elapsed;
  await page.waitForTimeout(250);
  expect((await state(page)).elapsed).toBe(frozen);
  await page.screenshot({ path: testInfo.outputPath('courtyard.png') });
  await testInfo.attach('courtyard', { path: testInfo.outputPath('courtyard.png'), contentType: 'image/png' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);

  await page.getByRole('button', { name: '起风', exact: true }).click();
  await expect.poll(async () => Number((await state(page)).gust)).toBeGreaterThan(0.005);
  expect((await state(page)).paused).toBe(false);
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
  const beforeQuality = await state(page);
  await page.getByLabel('画质', { exact: true }).selectOption('low');
  expect((await state(page)).quality).toBe('low');
  expect((await state(page)).geometries).toBe(beforeQuality.geometries);
  await page.getByLabel('雪量', { exact: true }).press('Home');
  for (let i = 0; i < 20; i++) await page.getByLabel('雪量', { exact: true }).press('ArrowRight');
  expect((await state(page)).snow).toBe(0.2);
  await page.screenshot({ path: testInfo.outputPath('settings.png') });
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
});

test('starts still for reduced motion and recovers from WebGL context loss', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?debug=1&seed=qa-snow');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  expect((await state(page)).paused).toBe(true);
  expect((await state(page)).elapsed).toBe(0);
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
  await page.screenshot({ path: testInfo.outputPath('restored.png') });
  await testInfo.attach('restored', { path: testInfo.outputPath('restored.png'), contentType: 'image/png' });
});
