import { chromium } from '@playwright/test';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(new URL('./social.html', import.meta.url).href);
  await page.screenshot({ path: 'public/social.png' });
} finally { await browser.close(); }
