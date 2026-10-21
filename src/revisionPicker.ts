import * as vscode from 'vscode';
import type { RefChoice, RefFilter, Side } from './core/types';

interface RevisionItem extends vscode.QuickPickItem { ref?: string }
const filters: { kind: RefFilter; name: string; icon: string }[] = [
  { kind: 'all', name: 'All', icon: 'list-unordered' },
  { kind: 'tag', name: 'Tags', icon: 'tag' },
  { kind: 'branch', name: 'Branches', icon: 'git-branch' },
  { kind: 'commit', name: 'Commits', icon: 'git-commit' }
];

export async function showRevisionPicker(side: Side, choices: RefChoice[], initialFilter: RefFilter): Promise<{ ref?: string; filter: RefFilter }> {
  const picker = vscode.window.createQuickPick<RevisionItem>();
  let filter = initialFilter;
  picker.matchOnDescription = true;
  picker.placeholder = 'Search or enter a Git revision: HEAD^, HEAD~5, main, or a hash';
  const buttons = filters.map(item => ({ ...item, iconPath: new vscode.ThemeIcon(item.icon), tooltip: `Filter: ${item.name}` }));
  picker.buttons = buttons;
  const update = () => {
    picker.title = `Git Sniffer · ${side === 'base' ? 'Base' : 'Target'} revision · ${filters.find(item => item.kind === filter)!.name}`;
    const items: RevisionItem[] = [];
    const value = picker.value.trim();
    if (side === 'base' && filter === 'all') { items.push({ label: '$(circle-slash) Empty tree', ref: ':empty:', description: 'Compare every line in the target' }); }
    for (const group of filters.filter(item => item.kind !== 'all' && (filter === 'all' || filter === item.kind))) {
      const matches = choices.filter(choice => choice.kind === group.kind);
      if (!matches.length) { continue; }
      items.push({ label: group.name, kind: vscode.QuickPickItemKind.Separator });
      items.push(...matches.map(choice => ({ label: choice.ref.replace(/^refs\/(heads|remotes|tags)\//, ''), ref: choice.ref, description: choice.description })));
    }
    if (value) { items.push({ label: `$(terminal) ${value}`, description: 'Use Git revision expression', ref: value, alwaysShow: true }); }
    picker.items = items;
  };
  const registrations: vscode.Disposable[] = [];
  try {
    return await new Promise(resolve => {
      registrations.push(picker.onDidChangeValue(update), picker.onDidTriggerButton(button => {
        const selected = buttons.find(item => item === button);
        if (selected) { filter = selected.kind; update(); }
      }), picker.onDidAccept(() => {
        const ref = picker.selectedItems[0]?.ref ?? picker.activeItems[0]?.ref;
        if (ref) { resolve({ ref, filter }); picker.hide(); }
      }), picker.onDidHide(() => resolve({ filter })));
      update(); picker.show();
    });
  } finally { registrations.forEach(item => item.dispose()); picker.dispose(); }
}
