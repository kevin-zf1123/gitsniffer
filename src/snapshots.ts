import * as vscode from 'vscode';
import { GitRepository } from './core/git';

/** Only snapshots issued by this provider can be read; no repository path comes from the webview. */
export class Snapshots implements vscode.FileSystemProvider {
  private readonly entries = new Map<string, { repo: GitRepository; oid: string; mode: string; content?: Uint8Array }>();
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private counter = 0;
  private readonly closedTabs = vscode.window.tabGroups.onDidChangeTabs(event => {
    for (const tab of event.closed) {
      if (tab.input instanceof vscode.TabInputTextDiff) {
        for (const uri of [tab.input.original, tab.input.modified]) {
          const used = vscode.window.tabGroups.all.some(group => group.tabs.some(other =>
            other.input instanceof vscode.TabInputTextDiff && [other.input.original, other.input.modified].some(value => value.toString() === uri.toString())));
          if (!used) { this.entries.delete(uri.toString()); }
        }
      }
    }
  });

  uri(repo: GitRepository, path: string, oid: string, mode: string, content?: Uint8Array): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: 'git-sniffer', path: `/${++this.counter}/${path}` });
    this.entries.set(uri.toString(), { repo, oid, mode, content });
    return uri;
  }
  private entry(uri: vscode.Uri) {
    const entry = this.entries.get(uri.toString());
    if (!entry) { throw vscode.FileSystemError.FileNotFound(uri); }
    return entry;
  }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const bytes = await this.readFile(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength, permissions: vscode.FilePermission.Readonly };
  }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { repo, oid, mode, content } = this.entry(uri);
    return content ?? repo.readObject(oid, mode);
  }
  watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): never { throw vscode.FileSystemError.NoPermissions(); }
  writeFile(): never { throw vscode.FileSystemError.NoPermissions(); }
  delete(): never { throw vscode.FileSystemError.NoPermissions(); }
  rename(): never { throw vscode.FileSystemError.NoPermissions(); }
  dispose() { this.closedTabs.dispose(); this.changed.dispose(); this.entries.clear(); }
}
