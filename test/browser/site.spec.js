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
  const context = await browser.newContext({ javaScriptEnabled: false }); const page = await context.newPage();
  for (const path of ['/', '/messages', '/observatory', '/about', '/api', '/participate', '/privacy']) {
    const response = await page.goto((process.env.E2E_URL || 'http://127.0.0.1:8049') + path);
    expect(response.status()).toBe(200); await expect(page.locator('main h1')).toBeVisible();
  }
  await context.close();
});
