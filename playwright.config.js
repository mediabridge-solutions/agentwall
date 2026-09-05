import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './test/browser', use: { baseURL: process.env.E2E_URL || 'http://127.0.0.1:8049', browserName: 'chromium', extraHTTPHeaders: process.env.E2E_INTERNAL_TOKEN ? { 'x-agentwall-observation-token': `Bearer ${process.env.E2E_INTERNAL_TOKEN}` } : {} }, reporter: 'list' });
