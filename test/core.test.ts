import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitRepository, parseNumstat } from '../src/core/git';
import { buildTree, layout, weight } from '../src/core/treemap';
import { droppedRef, droppedSelection, selectionContext } from '../src/core/integration';
import type { AreaMode, DiffFile } from '../src/core/types';

const file = (path: string, added: number, deleted: number, binary = false): DiffFile => ({
  path, oldPath: path, added, deleted, binary, status: 'M', oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40), oldMode: '100644', newMode: '100644'
});

test('numstat preserves tabs, newlines, Unicode, and renamed paths', () => {
  const stats = parseNumstat(['3\t2\tfolder/a\tb\nc.ts', '-\t-\timage.png', '0\t0\t', 'old name', '新 文件.ts', ''].join('\0'));
  assert.deepEqual(stats.get('folder/a\tb\nc.ts'), { added: 3, deleted: 2, binary: false });
  assert.equal(stats.get('image.png')?.binary, true);
  assert.deepEqual(stats.get('新 文件.ts'), { added: 0, deleted: 0, binary: false });
});

test('tree aggregates lines and keeps file-to-directory transitions distinct', () => {
  const tree = buildTree([file('src/app.ts', 8, 2), file('src/core/git.ts', 5, 3), file('src', 0, 4), file('image.png', 0, 0, true)]);
  assert.equal(tree.added, 13); assert.equal(tree.deleted, 9); assert.equal(tree.count, 4);
  const src = tree.children.find(n => n.path === 'src' && !n.file)!;
  assert.equal(src.added, 13); assert.equal(src.deleted, 5); assert.equal(src.count, 2);
  assert.equal(tree.children.filter(n => n.path === 'src').length, 2);
});

test('treemap preserves weighted area, fits bounds, and has no overlapping rectangles in every mode', () => {
  const tree = buildTree(Array.from({ length: 140 }, (_, i) => file(`file-${i}`, i % 9 ? i * i % 131 : 0, i * 7 % 63)));
  for (const mode of ['total', 'added', 'deleted'] as AreaMode[]) {
    for (const [width, height] of [[1280, 720], [200, 900], [8, 2]]) {
      const bounds = { x: 13, y: 17, width: width!, height: height! };
      const tiles = layout(tree.children, bounds, mode);
      const total = weight(tree, mode);
      assert.ok(Math.abs(tiles.reduce((sum, r) => sum + r.width * r.height, 0) - width! * height!) < 1e-6);
      for (const tile of tiles) {
        assert.ok(tile.width > 0 && tile.height > 0);
        assert.ok(tile.x >= 13 - 1e-8 && tile.y >= 17 - 1e-8);
        assert.ok(tile.x + tile.width <= 13 + width! + 1e-8);
        assert.ok(tile.y + tile.height <= 17 + height! + 1e-8);
        const expected = weight(tile.node, mode) / total * width! * height!;
        assert.ok(Math.abs(tile.width * tile.height - expected) < 1e-6);
        for (const other of tiles) {
          if (tile === other) { continue; }
          const overlapX = Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x);
          const overlapY = Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y);
          assert.ok(overlapX <= 1e-8 || overlapY <= 1e-8);
        }
      }
    }
  }
  assert.deepEqual(layout(tree.children, { x: 0, y: 0, width: 0, height: 10 }, 'total'), []);
  assert.deepEqual(layout(buildTree([file('binary', 0, 0)]).children, { x: 0, y: 0, width: 10, height: 10 }, 'total'), []);
});

test('drop adapter accepts branches, hashes, and native Source Control history URI', () => {
  assert.equal(droppedRef(' feature/parser '), 'feature/parser');
  const hash = 'a'.repeat(40);
  const uri = `scm-history-item:/Users/me/repo%20name?${encodeURIComponent(JSON.stringify({ historyItemId: hash, repositoryId: 'git' }))}`;
  assert.deepEqual(droppedSelection(uri), { ref: hash, root: '/Users/me/repo name' });
  assert.deepEqual(droppedSelection(`scm-history-item:/C:/Repo?${encodeURIComponent(JSON.stringify({ historyItemId: hash }))}`), { ref: hash, root: 'C:/Repo' });
  assert.throws(() => droppedSelection('scm-history-item:/repo?%7B%22historyItemId%22%3A%22--output%22%7D'));
  for (const value of ['--output=/tmp/foo', 'https://github.com/a/b', 'a\nb', '{"hash":"x"}', '']) { assert.throws(() => droppedRef(value)); }
  assert.deepEqual(selectionContext({ branch: { name: 'main', hash } }), { ref: hash });
  assert.deepEqual(selectionContext({ tag: { name: 'v1.0' } }), { ref: 'v1.0' });
  assert.deepEqual(selectionContext({ ref: 'main', repositoryPath: '/repo' }), { ref: 'main', root: '/repo' });
  const provider = { rootUri: { fsPath: '/repo with spaces' } };
  assert.deepEqual(selectionContext(provider, { id: hash }), { ref: hash, root: '/repo with spaces' });
  assert.deepEqual(selectionContext(provider, { id: 'b'.repeat(64) }), { ref: 'b'.repeat(64), root: '/repo with spaces' });
  assert.throws(() => selectionContext(provider, { id: 'HEAD' }));
  assert.throws(() => selectionContext(provider, { id: hash }, { id: hash }));
  assert.throws(() => selectionContext({}, { id: hash }));
});

test('real Git snapshots handle edits, added/deleted/renamed/binary files and exact diff content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-sniffer-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    const repo = new GitRepository(root);
    await assert.rejects(repo.defaults(), /no commits/);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/app.ts'), 'one\ntwo\nthree\n');
    await writeFile(join(root, 'deleted.txt'), 'remove\nthis\n');
    await writeFile(join(root, 'rename-me.txt'), 'kept\n'.repeat(40));
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    git('add', '.'); git('commit', '-m', 'Initial');
    const base = await repo.resolve('HEAD');
    const defaults = await repo.defaults();
    assert.equal(defaults.base.empty, true);
    const first = await repo.diff(defaults.base, defaults.target);
    assert.equal(first.find(f => f.path === 'src/app.ts')?.added, 3);
    await writeFile(join(root, 'src/app.ts'), 'one\nchanged\nthree\nfour\n');
    await writeFile(join(root, 'new\tname\n新.ts'), 'added\n');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 5, 6]));
    await rename(join(root, 'rename-me.txt'), join(root, 'renamed.txt'));
    await rm(join(root, 'deleted.txt'));
    git('add', '.'); git('commit', '-m', 'Changes');
    const target = await repo.resolve('HEAD');
    const files = await repo.diff(base, target);
    const app = files.find(f => f.path === 'src/app.ts')!;
    assert.equal(app.added, 2); assert.equal(app.deleted, 1);
    assert.equal(Buffer.from(await repo.readObject(app.oldOid, app.oldMode)).toString(), 'one\ntwo\nthree\n');
    assert.equal(Buffer.from(await repo.readObject(app.newOid, app.newMode)).toString(), 'one\nchanged\nthree\nfour\n');
    assert.equal(files.find(f => f.path === 'new\tname\n新.ts')?.added, 1);
    assert.equal(files.find(f => f.path === 'binary.bin')?.binary, true);
    const renamed = files.find(f => f.path === 'renamed.txt')!;
    assert.equal(renamed.oldPath, 'rename-me.txt'); assert.match(renamed.status, /^R/); assert.equal(renamed.added, 0);
    const deleted = files.find(f => f.path === 'deleted.txt')!;
    assert.equal(deleted.deleted, 2); assert.equal((await repo.readObject(deleted.newOid, deleted.newMode)).byteLength, 0);
    const reverse = await repo.diff(target, base);
    assert.equal(reverse.find(f => f.path === 'src/app.ts')?.added, 1);
    assert.equal(reverse.find(f => f.path === 'src/app.ts')?.deleted, 2);
    assert.deepEqual(await repo.diff(base, base), []);
    assert.ok((await repo.choices()).some(c => c.ref === 'refs/heads/main'));
    await assert.rejects(repo.resolve('--output=/tmp/not-a-revision'));
    // Reading a commit object as a blob must fail visibly rather than showing an empty file.
    await assert.rejects(repo.readObject(base.oid, '100644'));
    assert.equal(Buffer.from(await repo.readObject(base.oid, '160000')).toString(), `Subproject commit ${base.oid}\n`);
    // Uncommitted edits do not affect either the area or the opened snapshot.
    await writeFile(join(root, 'src/app.ts'), 'uncommitted\n');
    assert.deepEqual(await repo.diff(base, target), files);
    assert.equal(Buffer.from(await repo.readObject(app.newOid, app.newMode)).toString(), 'one\nchanged\nthree\nfour\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('empty-tree comparison also works in SHA-256 repositories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-sniffer-sha256-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '--object-format=sha256', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(root, 'file.txt'), 'line\n'); git('add', '.'); git('commit', '-m', 'Initial');
    const repo = new GitRepository(root);
    const { base, target } = await repo.defaults();
    assert.equal(base.oid.length, 64);
    assert.equal((await repo.diff(base, target))[0]?.added, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('working comparisons separate staged, unstaged, uncommitted and retain captured bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-sniffer-working-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    await writeFile(join(root, 'file.txt'), 'one\ntwo\n');
    await writeFile(join(root, 'removed.txt'), 'gone\n');
    await writeFile(join(root, '.gitignore'), '*.ignored\n');
    git('add', '.'); git('commit', '-m', 'Initial');
    await writeFile(join(root, 'file.txt'), 'one\nstaged\n'); git('add', 'file.txt');
    await writeFile(join(root, 'file.txt'), 'one\nstaged\nworking\n');
    await writeFile(join(root, 'untracked.txt'), 'new\nline without newline');
    await writeFile(join(root, 'picture.bin'), Buffer.from([0, 2, 3]));
    await writeFile(join(root, 'skip.ignored'), 'ignored\n');
    await rm(join(root, 'removed.txt'));
    const repo = new GitRepository(root);
    const staged = await repo.working('staged');
    assert.equal(staged.files.length, 1); assert.equal(staged.files[0]?.added, 1); assert.equal(staged.files[0]?.deleted, 1);
    assert.equal(Buffer.from(await repo.readObject(staged.files[0]!.newOid, '100644')).toString(), 'one\nstaged\n');
    const unstaged = await repo.working('unstaged');
    assert.equal(unstaged.files.find(f => f.path === 'file.txt')?.added, 1);
    assert.equal(unstaged.files.find(f => f.path === 'file.txt')?.deleted, 0);
    assert.equal(unstaged.files.find(f => f.path === 'removed.txt')?.deleted, 1);
    assert.equal(unstaged.files.find(f => f.path === 'untracked.txt')?.added, 2);
    assert.equal(unstaged.files.find(f => f.path === 'picture.bin')?.binary, true);
    assert.equal(unstaged.files.some(f => f.path === 'skip.ignored'), false);
    const uncommitted = await repo.working('uncommitted');
    assert.equal(uncommitted.files.find(f => f.path === 'file.txt')?.added, 2);
    assert.equal(uncommitted.files.find(f => f.path === 'file.txt')?.deleted, 1);
    await writeFile(join(root, 'file.txt'), 'edited after refresh\n');
    assert.equal(Buffer.from(uncommitted.contents.get('file.txt')!).toString(), 'one\nstaged\nworking\n');
    // Neither reading state nor computing untracked line counts stages or writes files.
    assert.equal(git('show', ':file.txt'), 'one\nstaged');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('working comparisons are usable before the first commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-sniffer-unborn-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'main');
    await writeFile(join(root, 'first.txt'), 'first\n');
    const repo = new GitRepository(root);
    assert.equal((await repo.working('uncommitted')).files[0]?.added, 1);
    git('add', '.');
    assert.equal((await repo.working('staged')).files[0]?.added, 1);
    assert.equal((await repo.working('unstaged')).files.length, 0);
    await writeFile(join(root, 'first.txt'), 'first\nsecond\n');
    assert.equal((await repo.working('unstaged')).files[0]?.added, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uncommitted comparison reconciles staged removal and staged rename with recreated HEAD paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-sniffer-net-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    const original = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
    await writeFile(join(root, 'old.txt'), original); git('add', '.'); git('commit', '-m', 'Initial');
    git('rm', '--cached', 'old.txt');
    const repo = new GitRepository(root);
    assert.deepEqual((await repo.working('uncommitted')).files, []);
    await writeFile(join(root, 'old.txt'), original + 'new\n');
    let files = (await repo.working('uncommitted')).files;
    assert.equal(files.length, 1); assert.equal(files[0]?.added, 1); assert.equal(files[0]?.deleted, 0);
    git('reset', '--hard', 'HEAD'); git('mv', 'old.txt', 'new.txt');
    await writeFile(join(root, 'old.txt'), original);
    await writeFile(join(root, 'new.txt'), original.replace('line 19\n', 'changed\n'));
    files = (await repo.working('uncommitted')).files;
    assert.equal(files.length, 1); assert.equal(files[0]?.path, 'new.txt'); assert.equal(files[0]?.added, 20); assert.equal(files[0]?.deleted, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('revision expressions, typed ref choices and DAG steps use real Git history without checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-sniffer-revisions-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    const commits: string[] = [];
    for (let i = 0; i < 8; i++) { git('commit', '--allow-empty', '-m', `Commit ${i}`); commits.push(git('rev-parse', 'HEAD')); }
    const repo = new GitRepository(root);
    git('config', 'log.showNotes', 'true');
    git('notes', 'add', '-m', 'History note that must not become a revision choice');
    for (const depth of [1, 3, 5, 7]) { assert.equal((await repo.resolve(`HEAD~${depth}`)).oid, commits[7 - depth]); }
    assert.equal((await repo.resolve('HEAD^')).oid, commits[6]);
    await assert.rejects(repo.resolve('HEAD~8'), /Cannot resolve Git revision "HEAD~8".*requested ancestor exists/);
    assert.equal(await repo.parent(commits[0]!), undefined);
    assert.equal((await repo.parent(commits[7]!))?.oid, commits[6]);
    assert.deepEqual((await repo.children(commits[6]!)).map(child => child.ref), [commits[7]]);
    assert.deepEqual(await repo.children(commits[7]!), []);
    git('tag', '-a', 'release', '-m', 'Annotated release', commits[3]!);
    git('branch', 'release', commits[4]!);
    git('update-ref', 'refs/remotes/origin/main', commits[7]!);
    const choices = await repo.choices();
    assert.equal(choices.find(choice => choice.ref === 'refs/tags/release')?.kind, 'tag');
    assert.equal(choices.find(choice => choice.ref === 'refs/heads/release')?.kind, 'branch');
    assert.equal(choices.find(choice => choice.ref === 'refs/remotes/origin/main')?.kind, 'branch');
    assert.equal(choices.find(choice => choice.ref === commits[7])?.kind, 'commit');
    assert.equal((await repo.resolve('refs/tags/release')).oid, commits[3]);
    const tree = git('rev-parse', 'HEAD^{tree}');
    const side = git('commit-tree', tree, '-p', commits[0]!, '-m', 'Side branch');
    git('update-ref', 'refs/heads/side', side);
    assert.deepEqual(new Set((await repo.children(commits[0]!)).map(child => child.ref)), new Set([commits[1], side]));
    const merge = git('commit-tree', tree, '-p', commits[7]!, '-p', side, '-m', 'Merge side');
    git('update-ref', 'refs/heads/main', merge);
    assert.equal((await repo.parent(merge))?.oid, commits[7]);
    assert.equal((await repo.resolve('HEAD^2')).oid, side);
    assert.deepEqual((await repo.children(side)).map(child => child.ref), [merge]);
    const hidden = git('commit-tree', tree, '-p', commits[7]!, '-m', 'Unreferenced child');
    assert.ok(!(await repo.children(commits[7]!)).some(child => child.ref === hidden));
    assert.ok((await repo.children(commits[7]!, [hidden])).some(child => child.ref === hidden));
    await assert.rejects(repo.children('--all'));
    await assert.rejects(repo.parent('HEAD'));
    assert.equal(git('rev-parse', 'HEAD'), merge);
    assert.equal(git('symbolic-ref', 'HEAD'), 'refs/heads/main');
    assert.equal(git('status', '--porcelain'), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
