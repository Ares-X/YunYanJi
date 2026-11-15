import type { LaunchOptions } from '@playwright/test';

/** Shared by full browser tests and the lightweight local screenshot command. */
export function chromiumLaunchOptions(): LaunchOptions {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL;
  if (executablePath && channel) {
    throw new Error('Choose either PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH or PLAYWRIGHT_CHROMIUM_CHANNEL, not both.');
  }
  const softwareRendering = process.env.PLAYWRIGHT_SOFTWARE_RENDERING !== '0';
  return {
    args: [
      ...(softwareRendering ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
      '--disable-dev-shm-usage',
    ],
    ...(executablePath ? { executablePath } : {}),
    ...(channel ? { channel } : {}),
  };
}
