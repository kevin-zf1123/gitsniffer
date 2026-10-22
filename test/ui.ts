import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { fixture } from './fixture';
import type { Comparison } from '../src/core/types';

async function main() {
  const data = await fixture();
  const comparison: Comparison = { kind: 'commits', repository: data.root, base: data.base, target: data.target, files: await data.repo.diff(data.base, data.target) };
  const [script, css] = await Promise.all([readFile('dist/webview.js'), readFile('dist/style.css')]);
  const server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); }
    else if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body class="vscode-dark"><div id="app"></div><script>
window.messages=[];window.viewState=JSON.parse(sessionStorage.getItem('viewState')||'null');window.acquireVsCodeApi=()=>({postMessage:m=>window.messages.push(m),getState:()=>window.viewState,setState:s=>{window.viewState=s;sessionStorage.setItem('viewState',JSON.stringify(s))}});</script><script src="/app.js"></script></body></html>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.evaluate(comparison => window.postMessage({ type: 'comparison', comparison, settings: { mode: 'total', addedColor: '#238636', deletedColor: '#c24040' } }, '*'), comparison);
    await page.waitForSelector('.tile[data-path="src/core"]');
    assert.equal(await page.locator('.tile[data-path="src"]').getAttribute('class'), 'tile folder expanded');
    assert.equal(await page.locator('.tile[data-path="src/core"]').getAttribute('class'), 'tile folder leaf');
    assert.equal(await page.locator('.tile[data-path="src/core/git.ts"]').count(), 0);
    await page.locator('.tile[data-path="src/core"] > .tile-control').click();
    await page.locator('.tile[data-path="src/core/git.ts"] > .tile-control').waitFor();
    const file = comparison.files.find(f => f.path === 'src/core/git.ts')!;
    const percent = await page.locator('.tile[data-path="src/core/git.ts"] > .tile-control').evaluate(node => (node as HTMLElement).style.background);
    assert.ok(percent.includes(`${file.added / (file.added + file.deleted) * 100}`));
    await page.locator('.tile[data-path="src/core/git.ts"] > .tile-control').click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages.at(-1)), { type: 'openDiff', path: 'src/core/git.ts' });
    await page.locator('#mode').selectOption('added');
    assert.equal(await page.locator('#mode').inputValue(), 'added');
    await page.locator('#mode').selectOption('deleted');
    assert.equal(await page.locator('#mode').inputValue(), 'deleted');
    await page.locator('#mode').selectOption('total');
    await page.locator('#other').click();
    assert.equal(await page.locator('.other-file').count(), 2);
    await page.locator('#close-dialog').click();
    await page.locator('#base').dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => { const data = new DataTransfer(); data.setData('text/plain', 'baseline'); return data; }) });
    assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages.at(-1)), { type: 'drop', side: 'base', value: 'baseline' });
    for (const side of ['base', 'target']) {
      for (const direction of ['older', 'newer']) {
        await page.locator(`#${side}-${direction}`).click();
        assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages.at(-1)), { type: 'step', side, direction });
      }
    }
    await page.evaluate(() => window.postMessage({ type: 'busy', busy: true }, '*'));
    await page.waitForFunction(() => (document.getElementById('base-older') as HTMLButtonElement).disabled);
    await page.evaluate(() => window.postMessage({ type: 'busy', busy: false }, '*'));
    await page.locator('#kind').selectOption('staged');
    assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages.at(-1)), { type: 'kind', kind: 'staged' });
    for (const kind of ['staged', 'unstaged', 'uncommitted'] as const) {
      const value = await data.repo.working(kind);
      await page.evaluate(c => window.postMessage({ type: 'comparison', comparison: c, settings: { mode: 'total', addedColor: '#238636', deletedColor: '#c24040' } }, '*'), { kind, repository: data.root, base: value.base, target: value.target, files: value.files });
      await page.waitForFunction(kind => (document.getElementById('kind') as HTMLSelectElement).value === kind && (document.getElementById('swap') as HTMLButtonElement).disabled, kind);
      assert.equal(await page.locator('#swap').isDisabled(), true);
      for (const side of ['base', 'target']) { for (const direction of ['older', 'newer']) { assert.equal(await page.locator(`#${side}-${direction}`).isDisabled(), true); } }
    }
    // Repository-controlled text is rendered literally, with no HTML execution.
    const malicious = { ...comparison, files: [{ ...comparison.files[0]!, path: '<img src=x onerror=alert(1)>.ts', oldPath: '<img src=x onerror=alert(1)>.ts' }] };
    await page.evaluate(c => window.postMessage({ type: 'comparison', comparison: c, settings: { mode: 'total', addedColor: '#238636', deletedColor: '#c24040' } }, '*'), malicious);
    await page.waitForSelector('.tile.file');
    assert.equal(await page.locator('.tile-name img').count(), 0);
    assert.equal(await page.locator('.tile-name').first().textContent(), malicious.files[0]!.path);
    const skewed = { ...comparison, files: [{ ...comparison.files[0]!, path: 'massive.ts', added: 1000000, deleted: 0 }, { ...comparison.files[0]!, path: 'small/leaf.ts', added: 1, deleted: 0 }] };
    await page.evaluate(c => window.postMessage({ type: 'comparison', comparison: c, settings: { mode: 'total', addedColor: '#238636', deletedColor: '#c24040' } }, '*'), skewed);
    await page.locator('#all-files').click();
    await page.locator('#file-filter').fill('small/');
    assert.equal(await page.locator('.other-file').count(), 1);
    await page.locator('.file-focus').click();
    await page.locator('.tile[data-path="small/leaf.ts"] > .tile-control').click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages.at(-1)), { type: 'openDiff', path: 'small/leaf.ts' });
    const netComparison = { ...comparison, repository: `${data.root}-net`, files: [
      { ...comparison.files[0]!, path: 'mixed/growing.ts', added: 14, deleted: 4 },
      { ...comparison.files[0]!, path: 'mixed/shrinking.ts', added: 4, deleted: 14 },
      { ...comparison.files[0]!, path: 'mixed/balanced.ts', added: 7, deleted: 7 }
    ] };
    // A configured net default applies until the user chooses another metric.
    await page.reload();
    await page.evaluate(() => { sessionStorage.removeItem('viewState'); });
    await page.reload();
    await page.evaluate(c => window.postMessage({ type: 'comparison', comparison: c, settings: { mode: 'net', addedColor: '#238636', deletedColor: '#c24040' } }, '*'), netComparison);
    await page.waitForFunction(() => (document.getElementById('mode') as HTMLSelectElement).value === 'net');
    const growTile = page.locator('.tile[data-path="mixed/growing.ts"]');
    const shrinkTile = page.locator('.tile[data-path="mixed/shrinking.ts"]');
    await growTile.waitFor(); await shrinkTile.waitFor();
    assert.equal(await growTile.locator(':scope > .tile-control').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(35, 134, 54)');
    assert.equal(await shrinkTile.locator(':scope > .tile-control').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(194, 64, 64)');
    assert.equal(await page.locator('.tile[data-path="mixed"] > .tile-control').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(102, 102, 102)');
    // Read both rectangles in one layout snapshot and allow subpixel rounding.
    const areas = await page.evaluate(() => ['mixed/growing.ts', 'mixed/shrinking.ts'].map(path => {
      const rect = document.querySelector(`.tile[data-path="${path}"]`)!.getBoundingClientRect(); return rect.width * rect.height;
    }));
    assert.ok(Math.abs(areas[0]! - areas[1]!) <= Math.max(...areas) * 0.0001, `Equal net weights have areas ${areas.join(', ')}`);
    assert.equal(await page.locator('.tile[data-path="mixed/balanced.ts"]').count(), 0);
    assert.ok((await page.locator('#summary').innerText()).endsWith('20 lines'));
    await page.locator('#other').click();
    assert.equal(await page.locator('.other-file').count(), 1);
    await page.locator('.other-file').click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages.at(-1)), { type: 'openDiff', path: 'mixed/balanced.ts' });
    await page.locator('#mode').selectOption('total');
    await page.locator('#mode').selectOption('net');
    await page.reload();
    await page.evaluate(c => window.postMessage({ type: 'comparison', comparison: c, settings: { mode: 'total', addedColor: '#238636', deletedColor: '#c24040' } }, '*'), netComparison);
    await growTile.waitFor();
    assert.equal(await page.locator('#mode').inputValue(), 'net');
    await page.locator('#mode').selectOption('total');
    const stagingComparison: Comparison = { ...comparison, kind: 'uncommitted', repository: `${data.root}-staging`, files: [
      { ...comparison.files[0]!, path: 'staged.ts', added: 4, deleted: 1, staging: 'staged' },
      { ...comparison.files[0]!, path: 'unstaged.ts', added: 4, deleted: 1, staging: 'unstaged' },
      { ...comparison.files[0]!, path: 'partial.ts', added: 4, deleted: 1, staging: 'partial' },
      { ...comparison.files[0]!, path: 'binary.bin', added: 0, deleted: 0, binary: true, staging: 'unstaged' }
    ] };
    await page.evaluate(c => window.postMessage({ type: 'comparison', comparison: c, settings: { mode: 'total', addedColor: '#238636', deletedColor: '#c24040' } }, '*'), stagingComparison);
    const stagedTile = page.locator('.tile[data-path="staged.ts"] > .tile-control');
    const unstagedTile = page.locator('.tile[data-path="unstaged.ts"] > .tile-control');
    const partialTile = page.locator('.tile[data-path="partial.ts"] > .tile-control');
    await stagedTile.waitFor();
    for (const metric of ['total', 'added', 'deleted', 'net']) {
      await page.locator('#mode').selectOption(metric);
      const backgrounds = await Promise.all([stagedTile, unstagedTile, partialTile].map(tile => tile.evaluate(node => { const style = getComputedStyle(node); return `${style.backgroundColor} ${style.backgroundImage}`; })));
      assert.notEqual(backgrounds[0], backgrounds[1]);
      assert.equal(backgrounds[1], backgrounds[2]);
    }
    await partialTile.hover();
    assert.match(await page.locator('#tooltip').innerText(), /Partially staged/);
    await partialTile.click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem').count(), 2);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages.at(-1)), { type: 'unstage', path: 'partial.ts', repository: stagingComparison.repository, kind: 'uncommitted' });
    await unstagedTile.click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem').count(), 1);
    await page.getByRole('menuitem', { name: 'Stage Changes', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages.at(-1)), { type: 'stage', path: 'unstaged.ts', repository: stagingComparison.repository, kind: 'uncommitted' });
    await stagedTile.click({ button: 'right' }); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#file-context').isHidden(), true);
    assert.equal(await stagedTile.evaluate(node => node === document.activeElement), true);
    await page.locator('#other').click();
    await page.locator('.other-file').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Stage Changes', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages.at(-1)), { type: 'stage', path: 'binary.bin', repository: stagingComparison.repository, kind: 'uncommitted' });
    await page.locator('#close-dialog').click();
    for (const [kind, name, action] of [['unstaged', 'Stage Changes', 'stage'], ['staged', 'Unstage Changes', 'unstage']] as const) {
      await page.evaluate(c => window.postMessage({ type: 'comparison', comparison: c, settings: { mode: 'total', addedColor: '#238636', deletedColor: '#c24040' } }, '*'), { ...stagingComparison, kind, files: [{ ...stagingComparison.files[0]!, staging: kind }] });
      await stagedTile.click({ button: 'right' });
      assert.equal(await page.getByRole('menuitem').count(), 1);
      await page.getByRole('menuitem', { name, exact: true }).click();
      assert.deepEqual(await page.evaluate(() => (window as unknown as { messages: unknown[] }).messages.at(-1)), { type: action, path: 'staged.ts', repository: stagingComparison.repository, kind });
    }
    await page.evaluate(c => window.postMessage({ type: 'comparison', comparison: c, settings: { mode: 'total', addedColor: '#238636', deletedColor: '#c24040' } }, '*'), comparison);
    await page.locator('#breadcrumbs .crumb').first().click();
    await page.locator('#one-level').click();
    await page.evaluate(() => {
      document.body.className = 'vscode-light';
      for (const [key, value] of Object.entries({ '--vscode-editor-background': '#fff', '--vscode-sideBar-background': '#f5f5f5', '--vscode-foreground': '#333', '--vscode-descriptionForeground': '#666', '--vscode-panel-border': '#ddd', '--vscode-dropdown-background': '#fff', '--vscode-dropdown-foreground': '#333' })) { document.documentElement.style.setProperty(key, value); }
    });
    assert.equal(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    await page.setViewportSize({ width: 520, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 1440, height: 940 });
    await page.evaluate(() => { document.body.className = 'vscode-dark'; for (const name of ['--vscode-editor-background', '--vscode-sideBar-background', '--vscode-foreground', '--vscode-descriptionForeground', '--vscode-panel-border', '--vscode-dropdown-background', '--vscode-dropdown-foreground']) { document.documentElement.style.removeProperty(name); } });
    if (process.env.GIT_SNIFFER_SCREENSHOT) { await page.waitForTimeout(300); await page.screenshot({ path: process.env.GIT_SNIFFER_SCREENSHOT }); }
    assert.deepEqual(errors, []);
    console.log('UI passed: stage/unstage context menus in working views and file dialog, partial staging, keyboard actions, dark unstaged colors in four area modes, net area, persistence, real Git data, expansion, drops, escaping, themes and viewport.');
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await data.cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
