import { buildTree, layout, weight, type TreeNode } from '../core/treemap';
import type { AreaMode, ClientMessage, Comparison, DiffFile, HostMessage, Settings, Side } from '../core/types';

declare function acquireVsCodeApi(): { postMessage(message: ClientMessage): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();
const send = (message: ClientMessage) => vscode.postMessage(message);
const app = document.getElementById('app')!;
// This shell is static. Repository content is only ever assigned through textContent.
app.innerHTML = `
<header class="toolbar">
  <div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="2" width="12" height="20" rx="2"/><rect x="15" y="2" width="8" height="8" rx="2"/><rect class="red" x="15" y="12" width="8" height="10" rx="2"/></svg><strong>Git Sniffer</strong></div>
  <button id="repository" class="quiet repo" title="Choose repository">Repository</button>
  <span class="toolbar-spacer"></span>
  <select id="kind" aria-label="Changes to compare"><option value="commits">Commits</option><option value="staged">Staged</option><option value="unstaged">Unstaged</option><option value="uncommitted">Uncommitted</option></select>
  <label class="mode-label" for="mode">Area</label>
  <select id="mode" aria-label="Area metric"><option value="total">diff+ + diff−</option><option value="added">diff+ · Added</option><option value="deleted">diff− · Deleted</option><option value="net">|diff+ − diff−|</option></select>
  <button id="refresh" class="quiet" title="Refresh comparison">↻ <span>Refresh</span></button>
</header>
<section class="comparison-bar" aria-label="Comparison revisions">
  <div class="revision-group"><button class="revision" id="base" data-side="base"><span class="revision-label">BASE</span><span class="revision-name">Choose branch or commit</span><span class="revision-hash"></span><span class="revision-action">⌄</span></button><button class="quiet revision-step" id="base-older" aria-label="Base: previous commit" title="Base: previous commit (first parent)" disabled>‹</button><button class="quiet revision-step" id="base-newer" aria-label="Base: next commit" title="Base: next commit (choose a child)" disabled>›</button></div>
  <button id="swap" class="quiet swap" aria-label="Swap base and target" title="Swap comparison direction">⇄</button>
  <div class="revision-group"><button class="revision" id="target" data-side="target"><span class="revision-label">TARGET</span><span class="revision-name">Choose branch or commit</span><span class="revision-hash"></span><span class="revision-action">⌄</span></button><button class="quiet revision-step" id="target-older" aria-label="Target: previous commit" title="Target: previous commit (first parent)" disabled>‹</button><button class="quiet revision-step" id="target-newer" aria-label="Target: next commit" title="Target: next commit (choose a child)" disabled>›</button></div>
</section>
<section class="navigation-bar">
  <nav id="breadcrumbs" aria-label="Folder path"></nav>
  <div class="expand-controls"><button class="quiet" id="collapse" title="Collapse all folders">Collapse</button><button class="quiet" id="one-level" title="Expand one folder level">One level</button><button class="quiet" id="expand" title="Expand every folder">Expand all</button></div>
</section>
<div id="error" role="alert" hidden></div>
<main id="canvas" aria-label="Diff treemap" aria-busy="false"><div id="tiles"></div><div id="empty" class="empty"><div class="empty-mark">▥</div><h2>See where the code changed.</h2><p>Choose a base and target branch or commit to explore the diff.</p><button id="start">Choose target revision</button></div><div class="drop-overlay">Drop a branch or commit<br><small>Use the BASE / TARGET slots, or drop here to choose a side</small></div></main>
<footer><div id="summary">Ready</div><div class="legend"><span class="legend-added">+</span> added <span class="legend-deleted">−</span> deleted<span id="staging-legend" hidden><span class="staging-swatch"></span> staged <span class="staging-swatch dark"></span> unstaged</span><span class="footer-hint">Hold Shift to drop from Source Control · Click a file for diff</span></div><button id="all-files" class="quiet">Files</button><button id="other" class="quiet" hidden></button></footer>
<dialog id="other-dialog"><div class="dialog-head"><strong id="files-heading">Changed files</strong><button id="close-dialog" class="quiet" aria-label="Close">×</button></div><p class="muted" id="files-description">Open any file, including files too small to show on the canvas.</p><input id="file-filter" type="search" placeholder="Filter by path…" aria-label="Filter files by path"><div id="other-files"></div></dialog>
<div id="tooltip" role="tooltip" hidden></div>
<div id="file-context" role="menu" aria-label="File staging" hidden></div>
`;
const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
interface ViewState { mode?: AreaMode; expanded?: string[]; focus?: string; repository?: string; initialized?: boolean }
const previous = (vscode.getState() ?? {}) as ViewState;
let mode: AreaMode = previous.mode === 'added' || previous.mode === 'deleted' || previous.mode === 'net' ? previous.mode : 'total';
let modeChosen = previous.mode !== undefined;
let expanded = new Set(previous.expanded ?? []);
let initialized = previous.initialized === true;
let focus = previous.focus ?? '';
let comparison: Comparison | undefined;
let tree = buildTree([]);
let settings: Settings = { mode: 'total', addedColor: '#238636', deletedColor: '#c24040' };
let busy = false;
let dragged = 0;
let renderFrame = 0;
let listedFiles: Comparison['files'] = [];
let contextTrigger: HTMLElement | undefined;
const number = (value: number) => value.toLocaleString();
function persist() { vscode.setState({ mode, expanded: [...expanded], focus, repository: comparison?.repository, initialized }); }
function applySettings(value: Settings) {
  settings = value;
  if (!modeChosen) { mode = settings.mode; }
  document.documentElement.style.setProperty('--added', value.addedColor);
  document.documentElement.style.setProperty('--deleted', value.deletedColor);
  const darken = (color: string) => `#${color.slice(1).match(/../g)!.map(channel => Math.round(parseInt(channel, 16) * .55).toString(16).padStart(2, '0')).join('')}`;
  document.documentElement.style.setProperty('--unstaged-added', darken(value.addedColor));
  document.documentElement.style.setProperty('--unstaged-deleted', darken(value.deletedColor));
  el<HTMLSelectElement>('mode').value = mode;
}
function hideTooltip() { el('tooltip').hidden = true; }
function stagingLabel(file: DiffFile): string {
  return file.staging === 'partial' ? 'Partially staged' : file.staging === 'staged' ? 'Staged' : 'Unstaged';
}
function hideContextMenu(restoreFocus = false) {
  el('file-context').hidden = true;
  if (restoreFocus && contextTrigger?.isConnected) { contextTrigger.focus(); }
  contextTrigger = undefined;
}
function showContextMenu(event: MouseEvent, file: DiffFile, trigger: HTMLElement) {
  const current = comparison;
  if (busy || !current || current.kind === 'commits') { return; }
  const actions: ('stage' | 'unstage')[] = [];
  if ((current.kind === 'unstaged' || current.kind === 'uncommitted') && file.staging !== 'staged') { actions.push('stage'); }
  if ((current.kind === 'staged' || current.kind === 'uncommitted') && file.staging !== 'unstaged') { actions.push('unstage'); }
  if (!actions.length) { return; }
  event.preventDefault(); event.stopPropagation(); hideTooltip();
  contextTrigger = trigger;
  const menu = el('file-context'); menu.replaceChildren();
  // Keep the menu inside a modal dialog so its controls remain interactive.
  (trigger.closest('dialog') ?? app).append(menu);
  for (const action of actions) {
    const button = document.createElement('button'); button.setAttribute('role', 'menuitem');
    button.textContent = action === 'stage' ? 'Stage Changes' : 'Unstage Changes';
    button.addEventListener('click', () => {
      hideContextMenu(true);
      send({ type: action, path: file.path, repository: current.repository, kind: current.kind });
    });
    menu.append(button);
  }
  menu.hidden = false;
  const bounds = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(event.clientX || bounds.left, innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(event.clientY || bounds.bottom, innerHeight - menu.offsetHeight - 4))}px`;
  menu.querySelector('button')!.focus();
}
document.addEventListener('pointerdown', event => { if (!el('file-context').contains(event.target as Node)) { hideContextMenu(); } });
document.addEventListener('keydown', event => {
  const menu = el('file-context');
  if (menu.hidden) { return; }
  if (event.key === 'Escape' || event.key === 'Tab') {
    hideContextMenu(true);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]!.focus();
  }
}, true);
function updateSteps() {
  for (const side of ['base', 'target'] as const) {
    for (const direction of ['older', 'newer']) {
      el<HTMLButtonElement>(`${side}-${direction}`).disabled = busy || !comparison || comparison.kind !== 'commits' || !!comparison[side].empty;
    }
  }
}
function tooltip(event: MouseEvent, node: TreeNode) {
  const tip = el('tooltip');
  tip.replaceChildren();
  const title = document.createElement('strong'); title.textContent = node.path;
  const counts = document.createElement('div'); counts.textContent = `+${number(node.added)} added   −${number(node.deleted)} deleted`;
  const detail = document.createElement('div'); detail.className = 'muted';
  detail.textContent = node.file
    ? `${node.file.status}${comparison?.kind !== 'commits' ? ` · ${stagingLabel(node.file)} · Right-click for staging actions` : ''} · ${node.file.binary ? 'Binary file' : `${number(weight(node, mode))} lines of area`} · Click to open diff${node.file.path !== node.file.oldPath ? ` · From ${node.file.oldPath}` : ''}`
    : `${number(node.count)} files · Click to ${expanded.has(node.path) ? 'collapse' : 'expand'}`;
  tip.append(title, counts, detail); tip.hidden = false;
  tip.style.left = `${Math.max(8, Math.min(event.clientX + 14, innerWidth - tip.offsetWidth - 8))}px`;
  tip.style.top = `${Math.max(8, Math.min(event.clientY + 14, innerHeight - tip.offsetHeight - 8))}px`;
}
function scheduleRender() { cancelAnimationFrame(renderFrame); renderFrame = requestAnimationFrame(render); }
function findDirectory(path: string): TreeNode {
  if (!path) { return tree; }
  let node = tree;
  for (const segment of path.split('/')) {
    const next = node.children.find(child => !child.file && child.name === segment);
    if (!next) { focus = ''; return tree; }
    node = next;
  }
  return node;
}
function activate(node: TreeNode) {
  hideTooltip();
  if (busy) { return; }
  if (node.file) { send({ type: 'openDiff', path: node.path }); }
  else { if (expanded.has(node.path)) { expanded.delete(node.path); } else { expanded.add(node.path); } persist(); render(); }
}
function paint(node: Pick<TreeNode, 'added' | 'deleted' | 'unstagedCount'>, button: HTMLElement) {
  const dark = comparison?.kind === 'uncommitted' && node.unstagedCount > 0;
  const added = dark ? 'var(--unstaged-added)' : 'var(--added)';
  const deleted = dark ? 'var(--unstaged-deleted)' : 'var(--deleted)';
  if (mode === 'net') {
    const neutral = dark ? 'color-mix(in srgb, var(--vscode-badge-background, #666666) 55%, black)' : 'var(--vscode-badge-background, #666666)';
    button.style.background = node.added > node.deleted ? added : node.added < node.deleted ? deleted : neutral;
    return;
  }
  const all = node.added + node.deleted;
  const percent = mode === 'added' ? 100 : mode === 'deleted' ? 0 : all ? node.added / all * 100 : 0;
  button.style.background = `linear-gradient(to bottom, ${added} 0%, ${added} ${percent}%, ${deleted} ${percent}%, ${deleted} 100%)`;
}
function draw(parent: HTMLElement, node: TreeNode, width: number, height: number) {
  const fragment = document.createDocumentFragment();
  for (const tile of layout(node.children, { x: 0, y: 0, width, height }, mode)) {
    if (tile.width < 1 || tile.height < 1) { continue; }
    const folder = !tile.node.file;
    const isExpanded = folder && expanded.has(tile.node.path) && tile.height > 54 && tile.width > 60;
    const box = document.createElement('div');
    box.className = `tile ${folder ? 'folder' : 'file'} ${isExpanded ? 'expanded' : 'leaf'}`;
    box.dataset.path = tile.node.path;
    box.style.left = `${tile.x}px`; box.style.top = `${tile.y}px`;
    box.style.width = `${tile.width}px`; box.style.height = `${tile.height}px`;
    const control = document.createElement('button');
    control.className = 'tile-control';
    control.setAttribute('aria-label', `${tile.node.path}, ${tile.node.added} added, ${tile.node.deleted} deleted. ${folder ? 'Toggle folder' : 'Open diff'}`);
    if (folder) { control.setAttribute('aria-expanded', String(isExpanded)); }
    if (tile.node.file && comparison?.kind !== 'commits') {
      control.setAttribute('aria-label', `${control.getAttribute('aria-label')}. ${stagingLabel(tile.node.file)}`);
      control.addEventListener('contextmenu', event => showContextMenu(event, tile.node.file!, control));
    }
    paint(tile.node, control);
    const name = document.createElement('span'); name.className = 'tile-name';
    name.textContent = `${folder ? (isExpanded ? '▾ ' : '▸ ') : ''}${tile.node.name}`;
    const counts = document.createElement('span'); counts.className = 'tile-counts';
    counts.textContent = `+${number(tile.node.added)}  −${number(tile.node.deleted)}`;
    control.append(name, counts);
    if (tile.width < 48 || tile.height < 24) { control.classList.add('tiny'); }
    control.addEventListener('click', () => {
      if (folder && !isExpanded && (tile.height <= 54 || tile.width <= 60)) { focus = tile.node.path; persist(); render(); }
      else { activate(tile.node); }
    });
    control.addEventListener('mousemove', event => tooltip(event, tile.node));
    control.addEventListener('mouseleave', hideTooltip);
    control.addEventListener('blur', hideTooltip);
    box.append(control);
    if (folder && tile.width > 110 && tile.height > 35) {
      const zoom = document.createElement('button'); zoom.className = 'zoom'; zoom.textContent = '↗'; zoom.title = `Focus ${tile.node.path}`;
      zoom.setAttribute('aria-label', `Focus ${tile.node.path}`);
      zoom.addEventListener('click', () => { focus = tile.node.path; hideTooltip(); persist(); render(); });
      box.append(zoom);
    }
    if (isExpanded) {
      const content = document.createElement('div'); content.className = 'tile-children'; box.append(content);
      draw(content, tile.node, Math.max(0, tile.width - 8), Math.max(0, tile.height - 34));
    }
    fragment.append(box);
  }
  parent.append(fragment);
}
function renderBreadcrumbs() {
  const nav = el('breadcrumbs'); nav.replaceChildren();
  const parts = focus ? focus.split('/') : [];
  ['', ...parts].forEach((part, index) => {
    if (index) { const divider = document.createElement('span'); divider.textContent = '/'; divider.className = 'crumb-divider'; nav.append(divider); }
    const button = document.createElement('button'); button.className = 'quiet crumb'; button.textContent = index ? part : 'All changes';
    button.addEventListener('click', () => { focus = parts.slice(0, index).join('/'); persist(); render(); });
    nav.append(button);
  });
}
function renderOther(files: Comparison['files']) {
  el('other-files').replaceChildren();
  for (const file of files) {
    const row = document.createElement('div'); row.className = 'file-row';
    const button = document.createElement('button'); button.className = 'other-file';
    const path = document.createElement('span'); path.textContent = file.path;
    const counts = document.createElement('span'); counts.className = 'muted'; counts.textContent = `${file.binary ? 'Binary' : `+${file.added} −${file.deleted} · ${file.status}`}${comparison?.kind !== 'commits' ? ` · ${stagingLabel(file)}` : ''}`;
    const swatch = document.createElement('span'); swatch.className = 'file-swatch'; swatch.setAttribute('aria-hidden', 'true');
    paint({ ...file, unstagedCount: Number(file.staging === 'unstaged' || file.staging === 'partial') }, swatch);
    button.append(swatch, path, counts);
    button.addEventListener('contextmenu', event => showContextMenu(event, file, button));
    button.addEventListener('click', () => { el<HTMLDialogElement>('other-dialog').close(); send({ type: 'openDiff', path: file.path }); });
    row.append(button);
    const parent = file.path.split('/').slice(0, -1).join('/');
    if (parent) {
      const zoom = document.createElement('button'); zoom.className = 'quiet file-focus'; zoom.textContent = '↗'; zoom.title = `Focus ${parent}`;
      zoom.setAttribute('aria-label', `Focus folder ${parent}`);
      zoom.addEventListener('click', () => { focus = parent; el<HTMLDialogElement>('other-dialog').close(); persist(); render(); });
      row.append(zoom);
    }
    el('other-files').append(row);
  }
}
function render() {
  hideTooltip(); hideContextMenu();
  el('staging-legend').hidden = comparison?.kind !== 'uncommitted';
  const node = findDirectory(focus);
  renderBreadcrumbs();
  const tiles = el('tiles'); tiles.replaceChildren();
  const total = weight(node, mode);
  const empty = el('empty'); empty.hidden = !!comparison && total > 0;
  if (comparison && !total) {
    empty.querySelector('h2')!.textContent = comparison.files.length ? 'No lines in this area mode.' : 'These snapshots have no file changes.';
    empty.querySelector('p')!.textContent = comparison.files.length ? 'Switch area mode or open the files without area below.' : 'Choose a different branch or commit to compare.';
  }
  el('start').hidden = !!comparison;
  if (comparison) {
    draw(tiles, node, tiles.clientWidth, tiles.clientHeight);
    el('summary').textContent = `${number(node.count)} files  ·  +${number(node.added)}  −${number(node.deleted)}  ·  ${number(total)} lines`;
    const inFocus = comparison.files.filter(file => !focus || file.path.startsWith(`${focus}/`));
    const withoutArea = inFocus.filter(file => weight(file, mode) === 0);
    const button = el<HTMLButtonElement>('other'); button.hidden = withoutArea.length === 0;
    button.textContent = `${withoutArea.length} without area`;
  }
}
for (const side of ['base', 'target'] as const) {
  el(side).addEventListener('click', () => send({ type: 'pick', side }));
  for (const direction of ['older', 'newer'] as const) {
    el(`${side}-${direction}`).addEventListener('click', () => send({ type: 'step', side, direction }));
  }
  el(side).addEventListener('dragover', event => { event.preventDefault(); event.stopPropagation(); el(side).classList.add('drag-over'); if (event.dataTransfer) { event.dataTransfer.dropEffect = 'copy'; } });
  el(side).addEventListener('dragleave', () => el(side).classList.remove('drag-over'));
  el(side).addEventListener('drop', event => drop(event, side));
}
function drop(event: DragEvent, side?: Side) {
  event.preventDefault(); event.stopPropagation();
  dragged = 0; el('canvas').classList.remove('dragging');
  el('base').classList.remove('drag-over'); el('target').classList.remove('drag-over');
  const value = event.dataTransfer?.getData('text/plain');
  if (value) { send({ type: 'drop', side, value }); }
  else { showError('This view does not expose a branch or commit as text. Use its Git Sniffer context menu or copy the revision into the picker.'); }
}
const canvas = el('canvas');
canvas.addEventListener('dragenter', event => { event.preventDefault(); dragged++; canvas.classList.add('dragging'); });
canvas.addEventListener('dragleave', () => { if (--dragged <= 0) { canvas.classList.remove('dragging'); } });
canvas.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) { event.dataTransfer.dropEffect = 'copy'; } });
canvas.addEventListener('drop', event => drop(event));
el('refresh').addEventListener('click', () => send({ type: 'refresh' }));
el('repository').addEventListener('click', () => send({ type: 'repository' }));
el('swap').addEventListener('click', () => send({ type: 'swap' }));
el('start').addEventListener('click', () => send({ type: 'pick', side: 'target' }));
el<HTMLSelectElement>('mode').addEventListener('change', event => { mode = (event.target as HTMLSelectElement).value as AreaMode; modeChosen = true; persist(); render(); });
el<HTMLSelectElement>('kind').addEventListener('change', event => send({ type: 'kind', kind: (event.target as HTMLSelectElement).value as Comparison['kind'] }));
el('collapse').addEventListener('click', () => { expanded.clear(); persist(); render(); });
el('one-level').addEventListener('click', () => { expanded = new Set(findDirectory(focus).children.filter(node => !node.file).map(node => node.path)); initialized = true; persist(); render(); });
el('expand').addEventListener('click', () => {
  const stack = [...findDirectory(focus).children];
  while (stack.length) { const node = stack.pop()!; if (!node.file) { expanded.add(node.path); stack.push(...node.children); } }
  persist(); render();
});
function showFiles(onlyWithoutArea: boolean) {
  hideContextMenu();
  listedFiles = (comparison?.files ?? []).filter(file => (!focus || file.path.startsWith(`${focus}/`)) && (!onlyWithoutArea || weight(file, mode) === 0));
  el('files-heading').textContent = onlyWithoutArea ? 'Files without area in this mode' : 'Changed files';
  el('files-description').textContent = onlyWithoutArea ? 'Binary files, pure renames and files with zero selected lines remain accessible here.' : 'Open any file, including files too small to show on the canvas.';
  el<HTMLInputElement>('file-filter').value = ''; renderOther(listedFiles); el<HTMLDialogElement>('other-dialog').showModal();
}
el('other').addEventListener('click', () => showFiles(true));
el('all-files').addEventListener('click', () => showFiles(false));
el('file-filter').addEventListener('input', () => { const query = el<HTMLInputElement>('file-filter').value.toLowerCase(); renderOther(listedFiles.filter(file => file.path.toLowerCase().includes(query))); });
el('close-dialog').addEventListener('click', () => el<HTMLDialogElement>('other-dialog').close());
el('other-dialog').addEventListener('close', () => hideContextMenu());
function showError(message: string) { el('error').textContent = message; el('error').hidden = false; }
window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'comparison': {
      const changedRepo = (comparison?.repository ?? previous.repository) !== message.comparison.repository;
      comparison = message.comparison; tree = buildTree(comparison.files); applySettings(message.settings);
      el('repository').textContent = comparison.repository.split(/[\\/]/).filter(Boolean).at(-1) ?? comparison.repository;
      el('repository').title = comparison.repository;
      if (changedRepo) { focus = ''; initialized = false; }
      if (!initialized) { expanded = new Set(tree.children.filter(node => !node.file).map(node => node.path)); initialized = true; }
      for (const side of ['base', 'target'] as const) {
        const revision = comparison[side];
        el(side).querySelector('.revision-name')!.textContent = revision.label.replace(/^refs\/(heads|remotes|tags)\//, '');
        el(side).querySelector('.revision-hash')!.textContent = revision.empty || revision.oid.startsWith(':') ? '' : revision.oid.slice(0, 8);
        el(side).title = `${revision.label}\n${revision.oid}\nClick to choose, or drop a branch or commit here`;
      }
      el<HTMLSelectElement>('kind').value = comparison.kind;
      el<HTMLButtonElement>('swap').disabled = comparison.kind !== 'commits' || !!comparison.base.empty;
      el<HTMLDialogElement>('other-dialog').close();
      el('error').hidden = true; updateSteps(); persist(); render(); break;
    }
    case 'settings': applySettings(message.settings); render(); break;
    case 'reset': comparison = undefined; tree = buildTree([]); el('other').hidden = true; el('summary').textContent = 'Loading repository…'; updateSteps(); render(); break;
    case 'busy': busy = message.busy; if (busy) { hideContextMenu(); } canvas.setAttribute('aria-busy', String(busy)); app.classList.toggle('busy', busy); el('refresh').classList.toggle('spinning', busy); updateSteps(); break;
    case 'error': showError(message.message); break;
  }
});
new ResizeObserver(scheduleRender).observe(canvas);
applySettings(settings); renderBreadcrumbs(); send({ type: 'ready' });
