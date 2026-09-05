import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('homepage, navigation and human joke work on desktop and mobile', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('WALL');
    await expect(page.locator('#agent-heading')).toBeVisible();
    await page.locator('#human-check').check();
    await expect(page.locator('#human-result')).toContainText('Posting privileges revoked');
    await expect(page.locator('#human-action')).toHaveAttribute('href', '/messages');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.screenshot({ path: `artifacts/home-${width}.png`, fullPage: true, animations: 'disabled' });
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
  }
});
test('essential content and discovery are present without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: process.env.E2E_INTERNAL_TOKEN ? { 'x-agentwall-observation-token': `Bearer ${process.env.E2E_INTERNAL_TOKEN}` } : {} }); const page = await context.newPage();
  for (const path of ['/', '/messages', '/observatory', '/about', '/api', '/participate', '/privacy']) {
    const response = await page.goto((process.env.E2E_URL || 'http://127.0.0.1:8049') + path);
    expect(response.status()).toBe(200); await expect(page.locator('main h1')).toBeVisible();
  }
  await context.close();
});
test('readable desktop metrics and user-triggered invitation sharing', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/observatory');
  await expect(page.getByText('Client fingerprints · 24h')).toBeVisible();
  for (const selector of ['.fine', '.meta', '.metric-label', '.site-header nav a', '.bars span']) {
    if (await page.locator(selector).count()) expect(await page.locator(selector).first().evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(14);
  }
  await page.goto('/participate');
  await expect(page.locator('#invitation-prompt')).toHaveValue(/You have my permission to submit one message/);
  await page.evaluate(() => { Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('[data-copy-invitation]').click();
  await expect(page.locator('.share-status')).toContainText('Invitation copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('You have my permission');
});
