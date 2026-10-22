import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ComparisonKind, DiffFile, RefChoice, Revision, StagingState } from './types';
const execute = promisify(execFile);
export const isOid = (value: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

/** Git output uses NUL-delimited paths: tabs/newlines in filenames stay literal. */
export function parseNumstat(output: string): Map<string, Pick<DiffFile, 'added' | 'deleted' | 'binary'>> {
  const tokens = output.split('\0');
  const result = new Map<string, Pick<DiffFile, 'added' | 'deleted' | 'binary'>>();
  for (let i = 0; i < tokens.length && tokens[i]; i++) {
    const record = tokens[i]!;
    const first = record.indexOf('\t'), second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) { throw new Error('Invalid Git numstat output.'); }
    const plus = record.slice(0, first), minus = record.slice(first + 1, second);
    let path = record.slice(second + 1);
    if (!path) { i++; path = tokens[++i] ?? ''; } // rename: empty path, old path, new path
    if (!path || !/^(\d+|-)$/.test(plus) || !/^(\d+|-)$/.test(minus)) { throw new Error('Invalid Git numstat record.'); }
    result.set(path, { added: plus === '-' ? 0 : Number(plus), deleted: minus === '-' ? 0 : Number(minus), binary: plus === '-' || minus === '-' });
  }
  return result;
}

export function parseRaw(output: string, stats: ReturnType<typeof parseNumstat>): DiffFile[] {
  const tokens = output.split('\0');
  const files: DiffFile[] = [];
  for (let i = 0; i < tokens.length && tokens[i]; i++) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/.exec(tokens[i]!);
    if (!match) { throw new Error('Invalid Git raw diff output.'); }
    const oldMode = match[1]!, newMode = match[2]!, oldOid = match[3]!, newOid = match[4]!, status = match[5]!;
    const oldPath = tokens[++i];
    const path = /^[RC]/.test(status) ? tokens[++i] : oldPath;
    if (!path || !oldPath || !isOid(oldOid) || !isOid(newOid)) { throw new Error('Invalid Git diff path or object.'); }
    const stat = stats.get(path);
    if (!stat) { throw new Error(`Missing line counts for ${path}.`); }
    files.push({ path, oldPath, oldMode, newMode, oldOid, newOid, status, ...stat });
  }
  return files;
}

export function parseDiff(output: string): DiffFile[] {
  const tokens = output.split('\0');
  let i = 0;
  while (tokens[i]?.startsWith(':')) {
    const renamed = / [RC]\d+$/.test(tokens[i]!);
    i += renamed ? 3 : 2;
  }
  return parseRaw(tokens.slice(0, i).join('\0'), parseNumstat(tokens.slice(i).join('\0')));
}

export interface WorkingComparison {
  base: Revision;
  target: Revision;
  files: DiffFile[];
  contents: Map<string, Uint8Array>;
}
const diffFlags = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--ignore-submodules=none', '--diff-algorithm=myers'];

function stagingStates(output: string): Map<string, StagingState> {
  const states = new Map<string, StagingState>();
  const tokens = output.split('\0');
  const add = (path: string, staged: boolean, unstaged: boolean) => {
    const previous = states.get(path);
    staged ||= previous === 'staged' || previous === 'partial';
    unstaged ||= previous === 'unstaged' || previous === 'partial';
    states.set(path, staged && unstaged ? 'partial' : staged ? 'staged' : 'unstaged');
  };
  for (let i = 0; i < tokens.length && tokens[i]; i++) {
    const record = tokens[i]!, x = record[0]!, y = record[1]!;
    add(record.slice(3), x !== ' ' && x !== '?', y !== ' ');
    // Porcelain -z emits the destination first, followed by the original path.
    if (/[RC]/.test(x + y)) {
      const oldPath = tokens[++i]!;
      if (x === 'R' || y === 'R') { add(oldPath, x === 'R', y === 'R'); }
    }
  }
  return states;
}

export class GitRepository {
  constructor(readonly root: string, readonly executable = 'git') {}

  private async run(args: string[], maxBuffer = 32 * 1024 * 1024, allowDiffExit = false): Promise<Buffer> {
    try {
      const { stdout } = await execute(this.executable, ['--no-pager', ...args], {
        cwd: this.root, encoding: 'buffer', maxBuffer, timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
      });
      return stdout;
    } catch (error) {
      const e = error as Error & { stderr?: Buffer; stdout?: Buffer; killed?: boolean; code?: string | number };
      if (allowDiffExit && e.code === 1 && e.stdout) { return e.stdout; }
      if (e.killed) { throw new Error('Git timed out after 30 seconds.'); }
      throw new Error(e.stderr?.toString('utf8').trim() || e.message);
    }
  }

  async discover(): Promise<string> {
    return (await this.run(['rev-parse', '--show-toplevel'])).toString('utf8').trimEnd();
  }

  async resolve(ref: string): Promise<Revision> {
    if (!ref || ref.length > 1024 || /[\0\r\n]/.test(ref)) { throw new Error('Enter a branch, tag, or commit.'); }
    let oid: string;
    try { oid = (await this.run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).toString('utf8').trim(); }
    catch (error) { throw new Error(`Cannot resolve Git revision "${ref}". Check the name and that the requested ancestor exists.\n${(error as Error).message}`); }
    if (!isOid(oid)) { throw new Error('Git did not resolve a commit.'); }
    return { oid, label: ref };
  }

  async emptyTree(): Promise<Revision> {
    const format = (await this.run(['rev-parse', '--show-object-format'])).toString('utf8').trim();
    if (format !== 'sha1' && format !== 'sha256') { throw new Error(`Unsupported Git object format: ${format}`); }
    const oid = createHash(format).update('tree 0\0').digest('hex');
    return { oid, label: 'Empty tree', empty: true };
  }

  async defaults(): Promise<{ base: Revision; target: Revision }> {
    let target: Revision;
    try { target = await this.resolve('HEAD'); }
    catch { throw new Error('This repository has no commits. Choose Staged, Unstaged or Uncommitted to inspect working changes.'); }
    let base: Revision;
    try { base = await this.resolve(`${target.oid}^`); base.label = 'HEAD^'; }
    catch { base = await this.emptyTree(); }
    return { base, target };
  }

  async diff(base: Revision, target: Revision): Promise<DiffFile[]> {
    if (!isOid(base.oid) || !isOid(target.oid)) { throw new Error('Invalid comparison object.'); }
    return parseDiff((await this.run(['diff', ...diffFlags, '--raw', '--numstat', '--no-abbrev', '-z', base.oid, target.oid, '--'])).toString('utf8'));
  }

  /** Stage only the selected file, treating Git pathspec metacharacters literally. */
  async stage(filePath: string): Promise<void> {
    this.validateFilePath(filePath);
    const file = (await this.working('unstaged')).files.find(file => file.path === filePath);
    if (!file) { throw new Error('That file has no unstaged changes. Refresh the comparison.'); }
    const paths = file.status.startsWith('R') ? [file.oldPath, file.path] : [file.path];
    await this.run(['--literal-pathspecs', 'add', '--all', '--', ...paths]);
  }

  /** Restore the selected index entry (both ends of a rename), keeping working bytes. */
  async unstage(filePath: string): Promise<void> {
    this.validateFilePath(filePath);
    const staged = await this.working('staged');
    const file = staged.files.find(file => file.path === filePath || (file.status.startsWith('R') && file.oldPath === filePath));
    if (!file) { throw new Error('That file has no staged changes. Refresh the comparison.'); }
    const paths = file.status.startsWith('R') ? [file.oldPath, file.path] : [file.path];
    if (staged.base.empty) {
      await this.run(['--literal-pathspecs', 'rm', '--cached', '--force', '--', ...paths]);
    } else {
      await this.run(['--literal-pathspecs', 'reset', '--quiet', staged.base.oid, '--', ...paths]);
    }
  }

  private validateFilePath(filePath: string): void {
    if (!filePath || filePath.includes('\0') || isAbsolute(filePath) || filePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Choose a file inside the repository.');
    }
  }

  /** Capture working bytes, then verify they stayed stable across Git's line count. */
  async working(kind: Exclude<ComparisonKind, 'commits'>): Promise<WorkingComparison> {
    if ((await this.run(['ls-files', '--unmerged', '-z'])).length) { throw new Error('Resolve merge conflicts before comparing working changes. Commit comparisons are still available.'); }
    let head: Revision;
    try { head = await this.resolve('HEAD'); } catch { head = await this.emptyTree(); }
    const base = kind === 'unstaged' ? { oid: ':index:', label: 'Index (staged)' } : head;
    const target = kind === 'staged' ? { oid: ':index:', label: 'Index (staged)' } : { oid: ':worktree:', label: 'Working tree' };
    const args = ['diff', ...diffFlags, '--raw', '--numstat', '--no-abbrev', '-z',
      ...(kind === 'staged' ? ['--cached', head.oid] : kind === 'uncommitted' ? [head.oid] : []), '--'];
    if (kind === 'staged') {
      return { base, target, files: parseDiff((await this.run(args)).toString('utf8')).map(file => ({ ...file, staging: 'staged' })), contents: new Map() };
    }
    const untracked = () => this.run(['ls-files', '--others', '--exclude-standard', '-z']);
    const status = () => this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']);
    for (let attempt = 0; attempt < 2; attempt++) {
      const initialStatus = await status();
      const first = await this.run(args);
      const others = await untracked();
      let files = parseDiff(first.toString('utf8'));
      const untrackedPaths = new Set(others.toString('utf8').split('\0').filter(Boolean));
      // An index rename can hide a recreated HEAD path. Compare those paths
      // independently so the net HEAD -> working diff counts each path once.
      const recreatedRenames = files.filter(file => file.status.startsWith('R') && untrackedPaths.has(file.oldPath));
      if (kind === 'uncommitted' && recreatedRenames.length) {
        const plain = parseDiff((await this.run([...args.slice(0, -1), '--no-renames', '--'])).toString('utf8'));
        const affected = new Set(recreatedRenames.flatMap(file => [file.oldPath, file.path]));
        files = [...files.filter(file => !recreatedRenames.includes(file)), ...plain.filter(file => affected.has(file.path))];
      }
      const contents = new Map<string, Uint8Array>();
      const signatures = new Map<string, string>();
      const stat = async (filePath: string) => {
        const absolute = resolve(this.root, filePath);
        const rel = relative(this.root, absolute);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) { throw new Error('Git returned a path outside the repository.'); }
        const info = await lstat(absolute, { bigint: true });
        return { absolute, info, signature: `${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` };
      };
      let changed = false;
      const paths = new Map(files.filter(file => file.status !== 'D' && file.newMode !== '160000').map(file => [file.path, false]));
      for (const filePath of untrackedPaths) { if (!filePath.endsWith('/')) { paths.set(filePath, true); } }
      const jobs = [...paths];
      let next = 0;
      let snapshotBytes = 0n;
      await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, async () => {
        while (next < jobs.length) {
          const [filePath, isUntracked] = jobs[next++]!;
          try {
            const before = await stat(filePath);
            if (!before.info.isFile() && !before.info.isSymbolicLink()) { continue; }
            if (before.info.size > 32n * 1024n * 1024n) { throw new Error(`${filePath} exceeds the 32 MiB snapshot limit.`); }
            snapshotBytes += before.info.size;
            if (snapshotBytes > 128n * 1024n * 1024n) { throw new Error('Working snapshots exceed the 128 MiB comparison limit.'); }
            const bytes = before.info.isSymbolicLink() ? Buffer.from(await readlink(before.absolute)) : await readFile(before.absolute);
            const after = await stat(filePath);
            if (before.signature !== after.signature) { changed = true; continue; }
            signatures.set(filePath, after.signature); contents.set(filePath, bytes);
            if (isUntracked) {
              const existing = files.find(file => file.path === filePath);
              const newMode = before.info.isSymbolicLink() ? '120000' : before.info.mode & 0o111n ? '100755' : '100644';
              let temporary: string | undefined;
              let oldPath = '/dev/null';
              try {
                if (existing) {
                  const oldBytes = await this.readObject(existing.oldOid, existing.oldMode);
                  if (Buffer.from(oldBytes).equals(bytes) && existing.oldMode === newMode) { files.splice(files.indexOf(existing), 1); continue; }
                  temporary = await mkdtemp(join(tmpdir(), 'git-sniffer-diff-'));
                  oldPath = join(temporary, 'before');
                  if (existing.oldMode === '120000') { await symlink(Buffer.from(oldBytes).toString(), oldPath); }
                  else { await writeFile(oldPath, oldBytes); }
                }
                const output = await this.run(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--', oldPath, before.absolute], 32 * 1024 * 1024, true);
                const counts = [...parseNumstat(output.toString('utf8')).values()];
                const zeros = '0'.repeat(head.oid.length);
                const entry = { path: filePath, oldPath: filePath, oldMode: existing?.oldMode ?? '000000', newMode,
                  oldOid: existing?.oldOid ?? zeros, newOid: zeros, status: existing ? (existing.oldMode === newMode ? 'M' : 'T') : 'A',
                  added: counts.reduce((sum, c) => sum + c.added, 0), deleted: counts.reduce((sum, c) => sum + c.deleted, 0), binary: counts.some(c => c.binary) };
                if (existing) { files[files.indexOf(existing)] = entry; } else { files.push(entry); }
              } finally { if (temporary) { await rm(temporary, { recursive: true, force: true }); } }
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { changed = true; } else { throw error; }
          }
        }
      }));
      const final = await this.run(args);
      if (!first.equals(final) || !others.equals(await untracked()) || !initialStatus.equals(await status())) { changed = true; }
      for (const [filePath, signature] of signatures) {
        try { if ((await stat(filePath)).signature !== signature) { changed = true; } } catch { changed = true; }
      }
      if (!changed) {
        const states = stagingStates(initialStatus.toString('utf8'));
        return { base, target, files: files.map(file => ({ ...file, staging: states.get(file.path) ?? 'unstaged' })), contents };
      }
    }
    throw new Error('Files or the index changed during refresh. Refresh again after the current edit or Git operation finishes.');
  }

  async choices(): Promise<RefChoice[]> {
    const [refs, commits] = await Promise.all([
      this.run(['for-each-ref', '--format=%(refname)%00%(objectname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']),
      this.run(['log', '--all', 'HEAD', '--no-show-signature', '--no-notes', '--topo-order', '-n', '200', '--format=%H%x00%s'])
    ]);
    return [
      ...refs.toString('utf8').split('\n').filter(Boolean).map(line => {
        const [ref = '', oid = ''] = line.split('\0');
        return { ref, description: oid, kind: ref.startsWith('refs/tags/') ? 'tag' as const : 'branch' as const };
      }),
      ...commits.toString('utf8').split('\n').filter(Boolean).map(line => {
        const [ref = '', description = ''] = line.split('\0');
        return { ref, description, kind: 'commit' as const };
      })
    ];
  }

  async parent(oid: string): Promise<Revision | undefined> {
    if (!isOid(oid)) { throw new Error('Invalid Git commit ID.'); }
    const parents = (await this.run(['show', '--no-patch', '--no-show-signature', '--no-notes', '--format=%P', oid, '--'])).toString('utf8').trim();
    const parent = parents.split(' ')[0];
    return parent ? { oid: parent, label: parent.slice(0, 8) } : undefined;
  }

  async children(oid: string, tips: string[] = []): Promise<RefChoice[]> {
    if (!isOid(oid) || tips.some(tip => !isOid(tip))) { throw new Error('Invalid Git commit ID.'); }
    // Include the selected tip so back/forward also works for detached or
    // otherwise unreachable commits entered by hash.
    const output = await this.run(['log', '--all', '--no-show-signature', '--no-notes', '--topo-order', '--ancestry-path',
      '--format=%H%x00%P%x00%s', ...new Set([oid, ...tips]), `^${oid}`, '--']);
    return output.toString('utf8').split('\n').filter(Boolean).flatMap(line => {
      const [ref = '', parents = '', description = ''] = line.split('\0');
      return parents.split(' ').includes(oid) ? [{ ref, description, kind: 'commit' as const }] : [];
    });
  }

  async readObject(oid: string, mode: string): Promise<Uint8Array> {
    if (!isOid(oid)) { throw new Error('Invalid Git object ID.'); }
    if (/^0+$/.test(oid)) { return new Uint8Array(); }
    if (mode === '160000') { return Buffer.from(`Subproject commit ${oid}\n`); }
    return this.run(['cat-file', 'blob', oid]);
  }
}
