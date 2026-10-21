import { build, context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
const watch = process.argv.includes('--watch');
await mkdir('dist', { recursive: true });
await copyFile('src/webview/style.css', 'dist/style.css');
const jobs = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20' },
  { entryPoints: ['src/webview/app.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' }
];
for (const job of jobs) {
  const options = { ...job, bundle: true, sourcemap: true, logLevel: 'info' };
  if (watch) { await (await context(options)).watch(); } else { await build(options); }
}
if (watch) {
  const { watch: watchFile } = await import('node:fs');
  watchFile('src/webview/style.css', () => copyFile('src/webview/style.css', 'dist/style.css'));
}
