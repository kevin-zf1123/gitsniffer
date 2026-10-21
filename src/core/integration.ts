/** Accept plain refs copied/dragged by other tools, never command strings or URLs. */
export function droppedRef(value: string): string {
  const ref = value.trim();
  if (!ref || ref.length > 1024 || /[\s\0]/.test(ref) || ref.startsWith('-') || ref.includes('://') || ref.startsWith('{') || ref.startsWith('[')) {
    throw new Error('Drop a branch name or commit hash. You can also use the revision picker.');
  }
  return ref;
}

export interface SelectionContext { ref?: string; root?: string }
export function droppedSelection(value: string): SelectionContext {
  if (value.startsWith('scm-history-item:')) {
    const url = new URL(value);
    const data: unknown = JSON.parse(decodeURIComponent(url.search.slice(1)));
    if (!data || typeof data !== 'object' || !('historyItemId' in data) || typeof data.historyItemId !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(data.historyItemId)) {
      throw new Error('The dropped history item does not contain a Git commit.');
    }
    let root = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/.test(root)) { root = root.slice(1); }
    return { ref: data.historyItemId, root };
  }
  return { ref: droppedRef(value) };
}
/** Public refs, tree arguments, and native Graph's SourceControl + history item. */
export function selectionContext(value: unknown, ...historyItems: unknown[]): SelectionContext {
  if (historyItems.length) {
    const root = selectionContext(value).root;
    const item = historyItems[0];
    if (!root || historyItems.length !== 1 || !item || typeof item !== 'object' || !('id' in item) ||
      typeof item.id !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(item.id)) {
      throw new Error('Select a single Git commit in the Source Control Graph.');
    }
    return { root, ref: item.id };
  }
  if (typeof value === 'string') { return { ref: value }; }
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    if (item.rootUri && typeof item.rootUri === 'object' && 'fsPath' in item.rootUri && typeof item.rootUri.fsPath === 'string') { return { root: item.rootUri.fsPath }; }
    if (typeof item.ref === 'string') { return { ref: item.ref, root: typeof item.repositoryPath === 'string' ? item.repositoryPath : undefined }; }
    const ref = item.branch ?? item.tag;
    if (ref && typeof ref === 'object') {
      const data = ref as Record<string, unknown>;
      if (typeof data.name === 'string') { return { ref: typeof data.hash === 'string' && /^[0-9a-f]{40,64}$/.test(data.hash) ? data.hash : data.name }; }
    }
  }
  return {};
}
