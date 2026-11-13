import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const electronDir = path.join(rootDir, 'electron');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

console.log('[build-desktop] Building frontend production bundle...');
const viteRes = spawnSync(npmCmd, ['run', 'build'], { cwd: rootDir, stdio: 'inherit', shell: isWin });
if (viteRes.status !== 0) process.exit(viteRes.status || 1);

if (!fs.existsSync(path.join(electronDir, 'node_modules', 'electron-builder'))) {
  console.log('[build-desktop] Installing Electron & electron-builder...');
  const installRes = spawnSync(npmCmd, ['install'], { cwd: electronDir, stdio: 'inherit', shell: isWin });
  if (installRes.status !== 0) process.exit(installRes.status || 1);
}

console.log('[build-desktop] Packaging standalone desktop app into /release ...');
const distRes = spawnSync(npmCmd, ['run', 'dist'], { cwd: electronDir, stdio: 'inherit', shell: isWin });
process.exit(distRes.status ?? 0);
