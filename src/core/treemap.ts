import type { AreaMode, DiffFile } from './types';
export interface TreeNode {
  name: string;
  path: string;
  added: number;
  deleted: number;
  /** Sum of absolute file deltas; opposing files retain their individual areas. */
  netArea: number;
  count: number;
  unstagedCount: number;
  children: TreeNode[];
  file?: DiffFile;
}
export interface Rect { x: number; y: number; width: number; height: number }
export interface Tile extends Rect { node: TreeNode }
export const weight = (node: Pick<TreeNode, 'added' | 'deleted'> & Partial<Pick<TreeNode, 'netArea'>>, mode: AreaMode): number =>
  mode === 'added' ? node.added : mode === 'deleted' ? node.deleted : mode === 'net' ? node.netArea ?? Math.abs(node.added - node.deleted) : node.added + node.deleted;

export function buildTree(files: DiffFile[]): TreeNode {
  const make = (name: string, path: string): TreeNode => ({ name, path, added: 0, deleted: 0, netArea: 0, count: 0, unstagedCount: 0, children: [] });
  const root = make('', '');
  const directories = new Map<string, TreeNode>([['', root]]);
  for (const file of files) {
    const parts = file.path.split('/');
    let parent = root, path = '';
    const ancestors = [root];
    for (const part of parts.slice(0, -1)) {
      path = path ? `${path}/${part}` : part;
      let directory = directories.get(path);
      if (!directory) { directory = make(part, path); directories.set(path, directory); parent.children.push(directory); }
      parent = directory;
      ancestors.push(parent);
    }
    const leaf = { ...make(parts.at(-1)!, file.path), added: file.added, deleted: file.deleted, netArea: Math.abs(file.added - file.deleted), count: 1,
      unstagedCount: Number(file.staging === 'unstaged' || file.staging === 'partial'), file };
    parent.children.push(leaf);
    for (const ancestor of ancestors) {
      ancestor.added += file.added; ancestor.deleted += file.deleted; ancestor.netArea += leaf.netArea; ancestor.count++;
      ancestor.unstagedCount += leaf.unstagedCount;
    }
  }
  return root;
}

/** Squarified rows keep nearby weights readable while preserving each raw area. */
export function layout(nodes: TreeNode[], bounds: Rect, mode: AreaMode): Tile[] {
  const total = nodes.reduce((sum, node) => sum + weight(node, mode), 0);
  if (total <= 0 || bounds.width <= 0 || bounds.height <= 0) { return []; }
  const scale = bounds.width * bounds.height / total;
  const items = nodes.filter(n => weight(n, mode) > 0)
    .sort((a, b) => weight(b, mode) - weight(a, mode) || a.path.localeCompare(b.path))
    .map(node => ({ node, area: weight(node, mode) * scale }));
  const result: Tile[] = [];
  let box = { ...bounds };
  let row: typeof items = [], sum = 0;
  const worst = (list: typeof items, area: number): number => {
    if (!list.length || !area) { return Infinity; }
    const side = Math.min(box.width, box.height);
    const max = list[0]!.area, min = list.at(-1)!.area;
    return Math.max(side * side * max / (area * area), area * area / (side * side * min));
  };
  const flush = () => {
    if (!row.length) { return; }
    const vertical = box.width >= box.height;
    const thickness = sum / (vertical ? box.height : box.width);
    let cursor = vertical ? box.y : box.x;
    row.forEach((item, index) => {
      const extent = index === row.length - 1
        ? (vertical ? box.y + box.height : box.x + box.width) - cursor
        : item.area / thickness;
      result.push({ node: item.node, x: vertical ? box.x : cursor, y: vertical ? cursor : box.y,
        width: vertical ? thickness : extent, height: vertical ? extent : thickness });
      cursor += extent;
    });
    if (vertical) { box.x += thickness; box.width = Math.max(0, box.width - thickness); }
    else { box.y += thickness; box.height = Math.max(0, box.height - thickness); }
    row = []; sum = 0;
  };
  for (const item of items) {
    if (row.length && worst([...row, item], sum + item.area) > worst(row, sum)) { flush(); }
    row.push(item); sum += item.area;
  }
  flush();
  return result;
}
