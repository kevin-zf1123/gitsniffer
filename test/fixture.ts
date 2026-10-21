import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitRepository } from '../src/core/git';

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-sniffer-fixture-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Git Sniffer Test'); git('config', 'user.email', 'test@example.invalid');
  const specs: [string, number, number][] = [
    ['src/extension.ts', 95, 28], ['src/core/git.ts', 78, 18], ['src/core/treemap.ts', 61, 16],
    ['src/webview/app.ts', 133, 52], ['src/webview/style.css', 104, 28], ['test/git.test.ts', 49, 1],
    ['test/treemap.test.ts', 31, 3], ['README.md', 28, 2], ['package.json', 9, 4], ['docs/usage.md', 19, 13]
  ];
  const lines = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `${prefix} line ${i + 1}\n`).join('');
  for (const [name, , minus] of specs) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), lines(minus + 10, 'original')); }
  await writeFile(join(root, 'old-name.txt'), 'unchanged\n'.repeat(20));
  await writeFile(join(root, 'image.bin'), Buffer.from([0, 1]));
  git('add', '.'); git('commit', '-m', 'Create initial modules');
  const repo = new GitRepository(root); const base = await repo.resolve('HEAD');
  git('branch', 'baseline');
  for (const [name, plus] of specs) { await writeFile(join(root, name), lines(10, 'original') + lines(plus, 'changed')); }
  await rename(join(root, 'old-name.txt'), join(root, 'renamed.txt'));
  await writeFile(join(root, 'image.bin'), Buffer.from([0, 3]));
  git('add', '.'); git('commit', '-m', 'Build diff explorer and visual canvas');
  for (let i = 1; i <= 4; i++) { git('commit', '--allow-empty', '-m', `History checkpoint ${i}`); }
  git('tag', 'v0.1', base.oid);
  git('tag', '-a', 'v0.2', '-m', 'Fixture release');
  const target = await repo.resolve('HEAD');
  await writeFile(join(root, 'src/extension.ts'), 'staged edit\n'); git('add', 'src/extension.ts');
  await writeFile(join(root, 'src/extension.ts'), 'staged edit\nworking edit\n');
  await writeFile(join(root, 'new-file.txt'), 'untracked edit\n');
  return { root, repo, base: { ...base, label: 'baseline' }, target: { ...target, label: 'main' }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
