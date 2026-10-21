export type AreaMode = 'total' | 'added' | 'deleted';
export type Side = 'base' | 'target';
export type ComparisonKind = 'commits' | 'staged' | 'unstaged' | 'uncommitted';
export interface Revision { oid: string; label: string; empty?: boolean }
export interface DiffFile {
  path: string;
  oldPath: string;
  status: string;
  added: number;
  deleted: number;
  binary: boolean;
  oldOid: string;
  newOid: string;
  oldMode: string;
  newMode: string;
}
export interface RefChoice { ref: string; description: string }
export interface Settings { mode: AreaMode; addedColor: string; deletedColor: string }
export interface Comparison {
  kind: ComparisonKind;
  repository: string;
  base: Revision;
  target: Revision;
  files: DiffFile[];
}
export type HostMessage =
  | { type: 'comparison'; comparison: Comparison; settings: Settings }
  | { type: 'settings'; settings: Settings }
  | { type: 'reset' }
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string };
export type ClientMessage =
  | { type: 'ready' | 'refresh' | 'swap' | 'repository' }
  | { type: 'pick'; side: Side }
  | { type: 'kind'; kind: ComparisonKind }
  | { type: 'drop'; side?: Side; value: string }
  | { type: 'openDiff'; path: string };
