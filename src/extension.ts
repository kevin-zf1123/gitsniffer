import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { GitRepository } from './core/git';
import { droppedSelection, selectionContext } from './core/integration';
import type { ClientMessage, Comparison, ComparisonKind, HostMessage, Revision, Settings, Side } from './core/types';
import { Snapshots } from './snapshots';

interface GitAPI {
  repositories: { rootUri: vscode.Uri }[];
  git: { path: string };
}

function settings(): Settings {
  const config = vscode.workspace.getConfiguration('gitSniffer');
  const color = (key: string, fallback: string) => {
    const value = config.get<string>(key, fallback);
    return /^#[\da-f]{6}$/i.test(value) ? value : fallback;
  };
  const mode = config.get<string>('areaMode');
  return { mode: mode === 'added' || mode === 'deleted' ? mode : 'total',
    addedColor: color('addedColor', '#238636'), deletedColor: color('deletedColor', '#c24040') };
}

class Sniffer {
  private panel?: vscode.WebviewPanel;
  private repo?: GitRepository;
  private comparison?: Comparison;
  private requested?: { base: Revision; target: Revision };
  private kind: ComparisonKind = 'commits';
  private contents = new Map<string, Uint8Array>();
  private version = 0;
  private git?: GitAPI;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly snapshots: Snapshots) {
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('gitSniffer')) { this.send({ type: 'settings', settings: settings() }); }
    }));
  }

  private async repositories(): Promise<GitRepository[]> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: number): GitAPI }>('vscode.git');
    if (extension) { this.git = (await extension.activate()).getAPI(1); }
    const executable = this.git?.git.path ?? 'git';
    const roots = new Set<string>((this.git?.repositories ?? []).map(repo => repo.rootUri.fsPath));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') { continue; }
      try { roots.add(await new GitRepository(folder.uri.fsPath, executable).discover()); } catch { /* A workspace may contain non-repository folders. */ }
    }
    const canonical = await Promise.all([...roots].map(root => realpath(root).catch(() => root)));
    return [...new Set(canonical)].map(root => new GitRepository(root, executable));
  }

  private async chooseRepository(root?: string): Promise<GitRepository | undefined> {
    const repos = await this.repositories();
    if (root) {
      const canonical = await realpath(root).catch(() => root);
      const match = repos.find(repo => path.resolve(repo.root) === path.resolve(canonical));
      if (!match) { throw new Error('The selected repository is not open in this workspace.'); }
      return match;
    }
    if (!repos.length) { throw new Error('Open a folder containing a Git repository first.'); }
    if (repos.length === 1) { return repos[0]; }
    const selection = await vscode.window.showQuickPick(repos.map(repo => ({ label: path.basename(repo.root), description: repo.root, repo })),
      { title: 'Git Sniffer · Repository', placeHolder: 'Choose the repository to compare' });
    return selection?.repo;
  }

  async open(): Promise<void> {
    if (!vscode.workspace.isTrusted) { throw new Error('Trust this workspace to use Git Sniffer.'); }
    if (this.panel) { this.panel.reveal(); return; }
    if (!this.repo) { this.repo = await this.chooseRepository(); }
    if (!this.repo) { return; }
    const panel = vscode.window.createWebviewPanel('gitSniffer', 'Git Sniffer', vscode.ViewColumn.Active, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')]
    });
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sniffer.svg');
    const registrations = [
      panel.webview.onDidReceiveMessage(message => { void this.receive(message).catch(error => this.error(error)); }),
      panel.onDidDispose(() => {
        this.panel = undefined; this.version++;
        if (this.kind !== 'commits') { this.comparison = undefined; this.contents.clear(); }
        registrations.forEach(item => item.dispose());
      })
    ];
    panel.webview.html = this.html(panel.webview);
  }

  private send(message: HostMessage) { void this.panel?.webview.postMessage(message); }
  private error(error: unknown) {
    this.send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    this.send({ type: 'busy', busy: false });
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }

  receive(message: unknown): Promise<void> { return this.enqueue(() => this.handle(message)); }

  openFromContext(value: unknown): Promise<void> {
    return this.enqueue(async () => { await this.useContextRepository(value); await this.open(); });
  }

  pickFromContext(side: Side, value: unknown): Promise<void> {
    return this.enqueue(async () => { await this.useContextRepository(value); await this.open(); await this.pick(side); });
  }

  private changeRepository(repo: GitRepository): void {
    if (repo.root === this.repo?.root) { return; }
    this.version++; this.repo = repo; this.comparison = undefined; this.requested = undefined;
    this.contents.clear(); this.send({ type: 'reset' });
  }

  private async useContextRepository(value: unknown): Promise<void> {
    const root = selectionContext(value).root;
    if (root) { const repo = await this.chooseRepository(root); if (repo) { this.changeRepository(repo); } }
  }

  private async handle(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || !('type' in message)) { return; }
    const m = message as ClientMessage;
    switch (m.type) {
      case 'ready':
        if (this.comparison) { this.send({ type: 'comparison', comparison: this.comparison, settings: settings() }); }
        else { await this.refresh(); } break;
      case 'refresh': await this.refresh(); break;
      case 'kind': if (['commits', 'staged', 'unstaged', 'uncommitted'].includes(m.kind)) {
        this.kind = m.kind; await this.refresh();
      } break;
      case 'pick': if (m.side === 'base' || m.side === 'target') { await this.pick(m.side); } break;
      case 'drop': if ((m.side === undefined || m.side === 'base' || m.side === 'target') && typeof m.value === 'string') {
        const selection = droppedSelection(m.value);
        const side = m.side ?? (await vscode.window.showQuickPick([
          { label: 'Use as target', side: 'target' as const }, { label: 'Use as base', side: 'base' as const }
        ], { title: 'Git Sniffer · Dropped revision' }))?.side;
        if (selection.ref && side) { await this.setRefNow(side, selection.ref, selection.root); }
        break;
      } break;
      case 'swap': {
        const current = this.requested;
        if (this.kind === 'commits' && current && !current.base.empty) { this.requested = { base: current.target, target: current.base }; await this.refresh(); }
        break;
      }
      case 'repository': {
        const repo = await this.chooseRepository();
        if (repo && repo.root !== this.repo?.root) {
          this.changeRepository(repo);
          await this.refresh();
        }
        break;
      }
      case 'openDiff': if (typeof m.path === 'string') { await this.openDiff(m.path); } break;
    }
  }

  private async refresh(): Promise<void> {
    const repo = this.repo;
    if (!repo) { return; }
    const version = ++this.version;
    this.send({ type: 'busy', busy: true });
    try {
      let result: Comparison;
      let contents = new Map<string, Uint8Array>();
      if (this.kind === 'commits') {
        const revisions = this.requested ?? await repo.defaults();
        if (version !== this.version) { return; }
        this.requested = revisions;
        result = { kind: this.kind, repository: repo.root, ...revisions, files: await repo.diff(revisions.base, revisions.target) };
      } else {
        const working = await repo.working(this.kind);
        contents = working.contents;
        result = { kind: this.kind, repository: repo.root, base: working.base, target: working.target, files: working.files };
      }
      if (version !== this.version) { return; }
      this.contents = contents; this.comparison = result;
      this.send({ type: 'comparison', comparison: result, settings: settings() });
    } catch (error) { if (version === this.version) { this.error(error); } }
    finally { if (version === this.version) { this.send({ type: 'busy', busy: false }); } }
  }

  setFromContext(side: Side, value: unknown): Promise<void> {
    return this.enqueue(async () => {
      const selection = selectionContext(value);
      if (!selection.ref) { await this.useContextRepository(value); await this.open(); await this.pick(side); return; }
      // Git Graph+ tree arguments have no repository root. Ask when ambiguous.
      if (!selection.root) {
        const repo = await this.chooseRepository();
        if (!repo) { return; }
        selection.root = repo.root;
      }
      await this.setRefNow(side, selection.ref, selection.root);
    });
  }

  private async setRefNow(side: Side, ref: string, root?: string): Promise<void> {
    if (root && root !== this.repo?.root) {
      const repo = await this.chooseRepository(root);
      if (!repo) { return; }
      this.changeRepository(repo);
    }
    await this.open();
    const repo = this.repo;
    if (!repo) { return; }
    const version = ++this.version;
    this.send({ type: 'busy', busy: true });
    try {
      const revision = ref === ':empty:' && side === 'base' ? await repo.emptyTree() : await repo.resolve(ref);
      const revisions = this.requested ?? await repo.defaults();
      if (version !== this.version) { return; }
      this.kind = 'commits';
      this.requested = { ...revisions, [side]: revision };
      await this.refresh();
    } catch (error) { if (version === this.version) { this.error(error); } }
  }

  private async pick(side: Side): Promise<void> {
    const repo = this.repo;
    if (!repo) { return; }
    const choices = await repo.choices().catch(() => []);
    const items = [
      { label: '$(edit) Enter branch, tag, or commit…', ref: ':input:', description: 'Accepts revisions such as main, HEAD~3, or a hash' },
      ...(side === 'base' ? [{ label: '$(circle-slash) Empty tree', ref: ':empty:', description: 'Compare every line in the target' }] : []),
      ...choices.map(choice => ({ label: choice.ref.replace(/^refs\/(heads|remotes|tags)\//, ''), ...choice }))
    ];
    const selection = await vscode.window.showQuickPick(items, { title: `Git Sniffer · ${side === 'base' ? 'Base' : 'Target'} revision`, matchOnDescription: true });
    if (!selection || this.repo !== repo) { return; }
    const ref = selection.ref === ':input:'
      ? await vscode.window.showInputBox({ title: 'Git Sniffer · Revision', prompt: 'Branch, tag, or commit (resolved without checking out)', placeHolder: 'main / feature/parser / HEAD~3 / a1b2c3d' })
      : selection.ref;
    if (ref && this.repo === repo) { await this.setRefNow(side, ref); }
  }

  private async openDiff(filePath: string): Promise<void> {
    const comparison = this.comparison, repo = this.repo;
    if (!comparison || !repo || comparison.repository !== repo.root) { return; }
    const file = comparison.files.find(item => item.path === filePath);
    if (!file) { throw new Error('That file is not in the current comparison.'); }
    const left = this.snapshots.uri(repo, file.oldPath, file.oldOid, file.oldMode);
    const right = this.snapshots.uri(repo, file.path, file.newOid, file.newMode, this.contents.get(file.path));
    const label = (revision: Revision) => revision.empty ? 'empty' : revision.oid.startsWith(':') ? revision.label : revision.oid.slice(0, 8);
    await vscode.commands.executeCommand('vscode.diff', left, right,
      `${file.path} (${label(comparison.base)} ↔ ${label(comparison.target)})`,
      { preview: true, viewColumn: this.panel?.viewColumn ? Math.min(this.panel.viewColumn + 1, 9) : vscode.ViewColumn.Beside });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(20).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'style.css'));
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${css}"><title>Git Sniffer</title></head><body>
<div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  dispose() { this.panel?.dispose(); this.disposables.forEach(item => item.dispose()); }
}

export function activate(context: vscode.ExtensionContext) {
  const snapshots = new Snapshots();
  const sniffer = new Sniffer(context, snapshots);
  const statusBar = vscode.window.createStatusBarItem('gitSniffer.open', vscode.StatusBarAlignment.Left, 90);
  statusBar.name = 'Git Sniffer';
  statusBar.text = '$(graph) Git Sniffer';
  statusBar.tooltip = 'Open Git Sniffer';
  statusBar.command = 'gitSniffer.open';
  const command = (id: string, callback: (...args: unknown[]) => Promise<void>) => vscode.commands.registerCommand(id, async (...args: unknown[]) => {
    try { await callback(...args); } catch (error) { void vscode.window.showErrorMessage(`Git Sniffer: ${error instanceof Error ? error.message : String(error)}`); }
  });
  context.subscriptions.push(snapshots, sniffer, statusBar,
    vscode.workspace.registerFileSystemProvider('git-sniffer', snapshots, { isReadonly: true, isCaseSensitive: true }),
    command('gitSniffer.open', value => sniffer.openFromContext(value)),
    ...(['base', 'target'] as const).map(side => command(`gitSniffer.set${side === 'base' ? 'Base' : 'Target'}`, async value => {
      await sniffer.setFromContext(side, value);
    })),
    ...(['base', 'target'] as const).map(side => command(`gitSniffer.pick${side === 'base' ? 'Base' : 'Target'}`, async value => {
      await sniffer.pickFromContext(side, value);
    }))
  );
  statusBar.show();
}
