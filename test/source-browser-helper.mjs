import fs from 'node:fs/promises';

export async function sourceBrowser(t, url) {
  const executablePath = process.env.SECOND_MIND_TEST_CHROME || '/usr/bin/google-chrome';
  if (!await fs.access(executablePath).then(() => true, () => false)) {
    t.skip('The browser acceptance binary is unavailable.');
    return null;
  }
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  const session = await page.context().newCDPSession(page);
  return {
    call: (method, parameters) => session.send(method, parameters),
    async evaluate(expression) {
      const deadline = Date.now() + 6000;
      while (true) {
        try {
          const value = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
          if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
          return value.result.value;
        } catch (error) {
          if (!/Cannot find default execution context/u.test(error.message) || Date.now() > deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      }
    },
    waitFor: expression => page.waitForFunction(expression, undefined, { timeout: 8000 }),
  };
}
