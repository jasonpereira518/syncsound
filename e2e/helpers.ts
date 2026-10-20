import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface Joined {
  ctx: BrowserContext;
  page: Page;
}

/** Shape of the instrumentation the web app exposes on window.__syncsound */
export interface ScheduleRecord {
  action: string;
  trackId: string | null;
  startRoomTime: number;
  trackOffset: number;
  whenCtx: number;
  offset: number;
  compensationSec: number;
  late: boolean;
  expectedHeardEpochMs: number;
}

export async function newPage(browser: Browser): Promise<Joined> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  (page as Page & { __errors?: string[] }).__errors = errors;
  return { ctx, page };
}

export function pageErrors(page: Page): string[] {
  return (page as Page & { __errors?: string[] }).__errors ?? [];
}

export async function createRoom(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByTestId('create-room').click();
  await page.waitForURL(/\/room\/[A-Z0-9]{6}/);
  const code = page.url().match(/\/room\/([A-Z0-9]{6})/)![1]!;
  return code;
}

export async function joinRoom(page: Page, code: string, name: string): Promise<void> {
  if (!page.url().includes(`/room/${code}`)) await page.goto(`/room/${code}`);
  await page.getByTestId('join-name').fill(name);
  await page.getByTestId('join-button').click();
  await expect(page.getByTestId('room-code').first()).toContainText(code);
}

export async function waitConverged(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as unknown as { __syncsound?: { getState(): { clock: { converged: boolean } | null } } })
      .__syncsound;
    return !!s?.getState().clock?.converged;
  }, null, { timeout: 30_000 });
}

export async function schedules(page: Page): Promise<ScheduleRecord[]> {
  return page.evaluate(
    () => (window as unknown as { __syncsound: { schedules: ScheduleRecord[] } }).__syncsound.schedules,
  );
}

export async function waitForSchedule(page: Page, pred: (s: ScheduleRecord) => boolean, after = 0) {
  const src = pred.toString();
  await page.waitForFunction(
    ({ src, after }) => {
      const fn = new Function(`return (${src})`)() as (s: unknown) => boolean;
      const list = (window as unknown as { __syncsound?: { schedules: unknown[] } }).__syncsound?.schedules ?? [];
      return list.slice(after).some(fn);
    },
    { src, after },
    { timeout: 30_000 },
  );
  const list = await schedules(page);
  return list.slice(after).filter(pred).at(-1)!;
}

export const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
