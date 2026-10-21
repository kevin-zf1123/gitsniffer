import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { chromium, type Frame } from 'playwright';
import { execFileSync } from 'node:child_process';

export async function run() {
  const root = process.env.SNIFFER_FIXTURE!;
  const extension = vscode.extensions.getExtension('gitsniffer.git-sniffer');
  assert.ok(extension, 'Extension is discovered'); await extension.activate();
  await vscode.commands.executeCommand('gitSniffer.setBase', { ref: process.env.SNIFFER_BASE, repositoryPath: root });
  await vscode.commands.executeCommand('gitSniffer.setTarget', { ref: process.env.SNIFFER_TARGET, repositoryPath: root });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.SNIFFER_CDP}`);
  try {
    let frame: Frame | undefined;
    const deadline = Date.now() + 20_000;
    while (!frame && Date.now() < deadline) {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          for (const candidate of page.frames()) {
            if (await candidate.locator('#canvas').count().catch(() => 0)) { frame = candidate; break; }
          }
        }
      }
      if (!frame) { await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    if (!frame) {
      for (const context of browser.contexts()) { for (const page of context.pages()) { console.log('PAGE', page.url(), page.frames().map(frame => frame.url())); console.log((await page.locator('body').innerText()).slice(-5000)); } }
    }
    assert.ok(frame, 'Actual VS Code webview renders its canvas');
    const workbench = frame.page();
    const picking = vscode.commands.executeCommand('gitSniffer.pickBase');
    const input = workbench.locator('.quick-input-widget input');
    await workbench.getByRole('button', { name: 'Filter: Tags', exact: true }).click();
    await workbench.getByText('v0.1', { exact: true }).waitFor();
    assert.equal(await workbench.locator('.quick-input-list').getByText('main', { exact: true }).count(), 0);
    await workbench.getByRole('button', { name: 'Filter: Branches', exact: true }).click();
    await workbench.locator('.quick-input-list').getByText('main', { exact: true }).waitFor();
    assert.equal(await workbench.locator('.quick-input-list').getByText('v0.1', { exact: true }).count(), 0);
    await workbench.getByRole('button', { name: 'Filter: Commits', exact: true }).click();
    await workbench.locator('.quick-input-list').getByText('History checkpoint 4', { exact: true }).waitFor();
    assert.equal(await workbench.locator('.quick-input-list').getByText('main', { exact: true }).count(), 0);
    await input.fill('HEAD~5');
    await workbench.getByText('Use Git revision expression', { exact: true }).waitFor({ timeout: 3000 });
    await workbench.keyboard.press('Enter');
    await picking;
    await frame.waitForFunction(base => document.querySelector('#base .revision-hash')?.textContent === base, process.env.SNIFFER_BASE!.slice(0, 8));
    const revisionAt = (ref: string) => execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim();
    const waitForRevision = (side: string, oid: string) => frame!.waitForFunction(({ side, oid }) => document.querySelector(`#${side} .revision-hash`)?.textContent === oid.slice(0, 8) && document.getElementById('canvas')?.getAttribute('aria-busy') === 'false', { side, oid });
    await frame.locator('#target-older').click();
    await waitForRevision('target', revisionAt('HEAD^'));
    await frame.locator('#target-newer').click();
    await waitForRevision('target', process.env.SNIFFER_TARGET!);
    await frame.locator('#base-newer').click();
    await waitForRevision('base', revisionAt('HEAD~4'));
    await frame.locator('#base-older').click();
    await waitForRevision('base', process.env.SNIFFER_BASE!);
    await frame.locator('.tile[data-path="src/extension.ts"] > .tile-control').waitFor();
    await frame.locator('.tile[data-path="src/extension.ts"] > .tile-control').click();
    const wait = async (predicate: () => boolean, message: string) => {
      const deadline = Date.now() + 10_000;
      while (!predicate() && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); }
      assert.ok(predicate(), message);
    };
    await wait(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff)), 'File click opens native diff editor');
    const diff = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputTextDiff)!.input as vscode.TabInputTextDiff;
    const oldDoc = await vscode.workspace.openTextDocument(diff.original);
    const newDoc = await vscode.workspace.openTextDocument(diff.modified);
    assert.ok(oldDoc.getText().startsWith('original line 1\n'));
    assert.ok(newDoc.getText().includes('changed line 95\n'));
    // The webview remains visible beside the diff. Validate every real working preset.
    for (const [kind, expected] of [['staged', 'staged edit\n'], ['unstaged', 'staged edit\nworking edit\n'], ['uncommitted', 'staged edit\nworking edit\n']] as const) {
      await frame.locator('#kind').selectOption(kind);
      await frame.waitForFunction(kind => document.querySelector(`#${kind === 'staged' ? 'target' : 'base'} .revision-name`)?.textContent === (kind === 'uncommitted' ? 'HEAD' : 'Index (staged)'), kind);
      await frame.waitForFunction(() => document.getElementById('canvas')?.getAttribute('aria-busy') === 'false');
      const priorDiffs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs).flatMap(tab => tab.input instanceof vscode.TabInputTextDiff ? [tab.input.modified.toString()] : []));
      await frame.locator('.tile[data-path="src/extension.ts"] > .tile-control').click();
      const newDiff = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputTextDiff && !priorDiffs.has(tab.input.modified.toString()));
      await wait(() => !!newDiff(), 'Working diff opens');
      const activeDiff = newDiff()!.input as vscode.TabInputTextDiff;
      assert.equal((await vscode.workspace.openTextDocument(activeDiff.modified)).getText(), expected);
      if (kind === 'unstaged') { assert.equal((await vscode.workspace.openTextDocument(activeDiff.original)).getText(), 'staged edit\n'); }
    }
    await vscode.commands.executeCommand('workbench.scm.history.focus');
    const page = frame.page();
    const source = page.locator('.scm-history-view .monaco-list-row[draggable="true"]:has(.history-item)').filter({ hasText: 'Create initial modules' }).first();
    await source.waitFor({ timeout: 15_000 });
    // Exercise the native graph's real drag handler. OS cross-frame gestures
    // remain a manual check; this test transfers the emitted payload explicitly.
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent('dragstart', { dataTransfer: transfer, shiftKey: true });
    const payload = await transfer.evaluate(value => value.getData('text/plain'));
    await source.dispatchEvent('dragend', { dataTransfer: transfer });
    assert.ok(payload.startsWith('scm-history-item:'), 'Native graph emits the supported history URI');
    await vscode.commands.executeCommand('gitSniffer.open');
    // Revealing a background webview may recreate its inner frame.
    for (const candidate of page.frames()) { if (await candidate.locator('#canvas').count().catch(() => 0)) { frame = candidate; } }
    const received = await frame.evaluateHandle(text => { const data = new DataTransfer(); data.setData('text/plain', text); return data; }, payload);
    await frame.locator('#base').dispatchEvent('drop', { dataTransfer: received });
    await frame.waitForFunction(base => (document.getElementById('kind') as HTMLSelectElement).value === 'commits' && document.querySelector('#base .revision-hash')?.textContent === base, process.env.SNIFFER_BASE!.slice(0, 8));
    console.log('Extension host passed: picker type filters, direct HEAD~5, older/newer on both endpoints, native diff with exact commit/index/working content, native Graph drag payload -> comparison. Physical drag gesture needs manual validation.');
  } finally { await browser.close(); }
}
