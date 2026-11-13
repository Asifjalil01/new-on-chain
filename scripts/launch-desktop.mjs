import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const electronDir = path.join(rootDir, 'electron');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

if (!fs.existsSync(path.join(rootDir, 'node_modules'))) {
  console.log('[desktop] Installing root Node dependencies...');
  const res = spawnSync(npmCmd, ['install'], { cwd: rootDir, stdio: 'inherit', shell: isWin });
  if (res.status !== 0) process.exit(res.status || 1);
}

if (!fs.existsSync(path.join(electronDir, 'node_modules', 'electron'))) {
  console.log('[desktop] Installing Electron desktop runtime (first run)...');
  const res = spawnSync(npmCmd, ['install'], { cwd: electronDir, stdio: 'inherit', shell: isWin });
  if (res.status !== 0) process.exit(res.status || 1);
}

const electronBin = path.join(
  electronDir,
  'node_modules',
  '.bin',
  isWin ? 'electron.cmd' : 'electron'
);

console.log('[desktop] Opening Solana Launch Sniper desktop window...');
const child = spawn(electronBin, ['.'], {
  cwd: electronDir,
  stdio: 'inherit',
  shell: isWin,
});

child.on('exit', (code) => process.exit(code ?? 0));
