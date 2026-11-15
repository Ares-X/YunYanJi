import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { FireSnapshot, LightningSnapshot, WeatherSnapshot } from '../../src/core/types';

async function state(page: Page) { return page.evaluate(() => window.__YUNYANJI__!.getState()); }
async function settled(page: Page) {
  await expect.poll(async () => {
    const current = await state(page);
    return Number(current.renderedWeatherRevision) === (current.weather as WeatherSnapshot).revision
      && Number(current.renderedFireRevision) === (current.fire as FireSnapshot).revision;
  }, { timeout: 45_000, message: 'A paused action must reach the actual rendered frame' }).toBe(true);
  return state(page);
}
async function setQuality(page: Page, quality: 'medium' | 'high') {
  const before = await state(page);
  if (before.quality === quality) return;
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('combobox', { name: '画质', exact: true }).selectOption(quality);
  await expect.poll(async () => Number((await state(page)).reflectionUpdates), { timeout: 45_000 })
    .toBeGreaterThan(Number(before.reflectionUpdates));
  await page.getByRole('button', { name: '关闭设置' }).click();
}
async function imageDifference(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(async ({ left, right }) => {
    const decode = async (text: string) => createImageBitmap(new Blob([
      Uint8Array.from(atob(text), character => character.charCodeAt(0)),
    ], { type: 'image/png' }));
    const first = await decode(left), second = await decode(right);
    const width = Math.floor(first.width * .60), height = Math.floor(first.height * .40);
    const x = Math.floor(first.width * .15), y = Math.floor(first.height * .28);
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d')!;
    const pixels = (image: ImageBitmap) => {
      context.drawImage(image, x, y, width, height, 0, 0, width, height);
      return context.getImageData(0, 0, width, height).data;
    };
    const initial = pixels(first), changed = pixels(second);
    let difference = 0;
    for (let i = 0; i < initial.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) difference += Math.abs(initial[i + channel]! - changed[i + channel]!);
    }
    first.close(); second.close();
    return difference / (width * height * 3);
  }, { left: a.toString('base64'), right: b.toString('base64') });
}

test('changes actual weather and fire, adds wood, and hears a delayed thunderclap', async ({ page }, testInfo) => {
  // Six frozen weather previews, five hearth states and acoustic propagation
  // require several readbacks on software GPUs; each individual action stays bounded.
  test.setTimeout(300_000);
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?debug=1&seed=qa-rainfire');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const initial = await settled(page);
  expect(initial.audioContext).toBe('uninitialized');
  // Exercise the entire preset matrix with shadows, AO and bloom enabled at
  // medium quality. The desktop's final edited scene is also captured at high;
  // the other tests retain default/high-quality motion and restoration coverage.
  await setQuality(page, 'medium');
  const captures = new Map<string, Buffer>();
  const lighting = new Map<string, number>();
  for (const [mode, label, rain, snow] of [
    ['clear', '晴天', 0, 0], ['overcast', '阴天', 0, 0], ['drizzle', '小雨', .22, 0],
    ['rain', '大雨', .72, 0], ['downpour', '暴雨', 1, 0], ['snow', '下雪', 0, .78],
  ] as const) {
    await page.getByRole('button', { name: '天候', exact: true }).click();
    await page.getByRole('button', { name: label, exact: true }).click();
    const current = await settled(page);
    expect(current.elapsed).toBe(0);
    expect((current.weather as WeatherSnapshot).mode).toBe(mode);
    expect(current.rain).toBe(rain); expect(current.snow).toBe(snow);
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    lighting.set(mode, Number(current.weatherSunIntensity));
    if (mode === 'snow') {
      expect((current.weather as WeatherSnapshot).snowCover).toBeGreaterThan(.35);
      const panel = await page.locator('#weather-panel').boundingBox();
      const viewport = page.viewportSize()!;
      expect(panel!.x).toBeGreaterThanOrEqual(0);
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(viewport.width);
      expect(panel!.y + panel!.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({ path: testInfo.outputPath('weather-controls.png'), timeout: 45_000, animations: 'disabled', scale: 'css' });
      await testInfo.attach('weather-controls', { path: testInfo.outputPath('weather-controls.png'), contentType: 'image/png' });
    }
    await page.getByRole('button', { name: '收起天候面板' }).click();
    if (['clear', 'overcast', 'downpour', 'snow'].includes(mode)) {
      const shot = await page.screenshot({ path: testInfo.outputPath(`${mode}.png`), timeout: 45_000, animations: 'disabled', scale: 'css' });
      captures.set(mode, shot);
      await testInfo.attach(mode, { path: testInfo.outputPath(`${mode}.png`), contentType: 'image/png' });
    }
  }
  expect(lighting.get('clear')!).toBeGreaterThan(lighting.get('overcast')! * 2);
  expect(lighting.get('overcast')!).toBeGreaterThan(lighting.get('downpour')!);
  expect(await imageDifference(page, captures.get('clear')!, captures.get('downpour')!)).toBeGreaterThan(3);
  expect(await imageDifference(page, captures.get('overcast')!, captures.get('snow')!)).toBeGreaterThan(1);

  await page.getByRole('button', { name: '天候', exact: true }).click();
  const fireLevels = new Map<string, number>();
  for (const mode of ['out', 'embers', 'small', 'steady', 'roaring'] as const) {
    await page.getByRole('combobox', { name: '火势', exact: true }).selectOption(mode);
    const current = await settled(page);
    expect((current.fire as FireSnapshot).state).toBe(mode);
    fireLevels.set(mode, Number(current.fireLightIntensity));
    if (mode === 'out') {
      expect(current.fireLightIntensity).toBe(0); expect(current.emberLightIntensity).toBe(0);
      expect(current.fireSparks).toBe(0);
      for (let i = 0; i < 4; i++) await page.getByRole('button', { name: '添柴', exact: true }).click();
      const fed = await settled(page);
      expect((fed.fire as FireSnapshot).addedLogs).toBe(4);
      expect(fed.visibleAddedLogs).toBe(4); expect(fed.fireLightIntensity).toBe(0);
      const geometryCount = fed.geometries;
      for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '添柴', exact: true }).click();
      expect((await state(page)).geometries).toBe(geometryCount);
      expect(((await state(page)).fire as FireSnapshot).addedLogs).toBe(4);
      await page.getByRole('button', { name: '收起天候面板' }).click();
      await page.screenshot({ path: testInfo.outputPath('cold-fed-hearth.png'), timeout: 45_000, animations: 'disabled', scale: 'css' });
      await testInfo.attach('cold-fed-hearth', { path: testInfo.outputPath('cold-fed-hearth.png'), contentType: 'image/png' });
      await page.getByRole('button', { name: '天候', exact: true }).click();
    }
  }
  expect(fireLevels.get('small')!).toBeGreaterThan(fireLevels.get('embers')!);
  expect(fireLevels.get('steady')!).toBeGreaterThan(fireLevels.get('small')!);
  expect(fireLevels.get('roaring')!).toBeGreaterThan(fireLevels.get('steady')!);
  // A second round of presets reuses GPU resources after their first upload.
  const warm = await state(page);
  for (const label of ['晴天', '大雨', '下雪']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await settled(page);
  }
  const repeated = await state(page);
  expect(repeated.geometries).toBe(warm.geometries);
  expect(repeated.textures).toBe(warm.textures);
  await page.getByRole('button', { name: '收起天候面板' }).click();
  if (testInfo.project.name === 'desktop') await setQuality(page, 'high');
  await page.screenshot({ path: testInfo.outputPath('snow-fed-fire.png'), timeout: 45_000, animations: 'disabled', scale: 'css' });
  await testInfo.attach('snow-fed-fire', { path: testInfo.outputPath('snow-fed-fire.png'), contentType: 'image/png' });
  await setQuality(page, 'medium');

  // User activation creates the graph. A manual strike resumes the shared
  // clock but respects reduced motion by suppressing its visible flash.
  await page.getByRole('button', { name: '听声', exact: true }).click();
  await expect.poll(async () => (await state(page)).audioContext).toBe('suspended');
  await page.getByRole('button', { name: '天候', exact: true }).click();
  await page.getByRole('button', { name: '打雷', exact: true }).click();
  const strike = (await state(page)).lightning as LightningSnapshot;
  expect(strike.flash).toBe(0);
  expect(strike.delay).toBeGreaterThan(1);
  if (strike.age < strike.delay) expect((await state(page)).audioThunders).toBe(0);
  await expect.poll(async () => Number((await state(page)).audioThunders), { timeout: 45_000 }).toBe(1);
  await page.getByRole('button', { name: '添柴', exact: true }).click();
  // Full hearth feeding remains bounded, regardless of whether more fuel fits.
  expect(Number((await state(page)).audioTransientSources)).toBeLessThanOrEqual(4);
  const settings = page.getByRole('button', { name: '设置', exact: true });
  await settings.focus();
  await settings.press('Enter');
  await page.getByRole('button', { name: '重看此境', exact: true }).click();
  await page.getByRole('button', { name: '天候', exact: true }).click();
  await page.getByRole('button', { name: '添柴', exact: true }).click();
  await expect.poll(async () => Number((await state(page)).audioWoodEvents)).toBe(1);
  await page.getByRole('button', { name: '收起天候面板' }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect.poll(async () => (await state(page)).audioContext).toBe('suspended');
  expect((await state(page)).audioTransientSources).toBe(0);
  await testInfo.attach('weather-fire-diagnostics', { body: JSON.stringify(await state(page), null, 2), contentType: 'application/json' });
  await page.evaluate(() => window.__YUNYANJI__!.dispose());
  await expect.poll(async () => (await state(page)).audioContext).toBe('closed');
  const disposed = await state(page);
  expect(disposed.geometries).toBe(0); expect(disposed.textures).toBe(0);
  expect(disposed.audioNodes).toBe(0);
  expect(errors).toEqual([]); expect(external).toEqual([]);
});
