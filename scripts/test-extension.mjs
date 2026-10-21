import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fixture } from '../test/fixture.ts';
const data = await fixture();
const userData = await mkdtemp(join(tmpdir(), 'git-sniffer-vscode-'));
await mkdir(join(userData, 'User'));
await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({ 'window.menuStyle': 'custom' }));
const portServer = createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
try {
  await build({ entryPoints: ['test/extension-host.ts'], outfile: 'dist/extension-host-test.js', platform: 'node', format: 'cjs', bundle: true, external: ['vscode', 'playwright'], target: 'node20', sourcemap: true });
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    extensionDevelopmentPath: resolve('.'), extensionTestsPath: resolve('dist/extension-host-test.js'),
    extensionTestsEnv: { SNIFFER_FIXTURE: data.root, SNIFFER_BASE: data.base.oid, SNIFFER_TARGET: data.target.oid, SNIFFER_CDP: String(port) },
    launchArgs: [data.root, '--new-window', '--disable-extensions', '--enable-proposed-api=gitsniffer.git-sniffer', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--user-data-dir', userData, '--extensions-dir', join(userData, 'extensions'), `--remote-debugging-port=${port}`]
  });
} finally { await data.cleanup(); await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
