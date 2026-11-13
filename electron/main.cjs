const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app-runtime')
  : path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const APP_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let serverProc = null;
let startedServerHere = false;

function checkHeartbeat() {
  return new Promise((resolve) => {
    const req = http.get(`${APP_URL}/api/heartbeat`, { timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await checkHeartbeat()) return true;
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

function startEmbeddedBackend() {
  const tsxCli = path.join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  serverProc = spawn(process.execPath, [tsxCli, 'server.ts'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      ELECTRON_DESKTOP: '1',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: app.isPackaged ? 'production' : process.env.NODE_ENV || 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startedServerHere = true;

  serverProc.stdout?.on('data', (chunk) => {
    process.stdout.write(`[bot-server] ${chunk}`);
  });
  serverProc.stderr?.on('data', (chunk) => {
    process.stderr.write(`[bot-server] ${chunk}`);
  });
  serverProc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[desktop] Backend server exited with code ${code}`);
    }
    serverProc = null;
  });
}

function stopEmbeddedBackend() {
  if (!serverProc || !startedServerHere) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(serverProc.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      serverProc.kill('SIGTERM');
    }
  } catch {}
  serverProc = null;
}

function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'reload', label: 'Reload Window' },
        { type: 'separator' },
        { role: 'quit', label: 'Exit Solana Launch Sniper' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools', label: 'Developer Console' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'Solana Launch Sniper',
    backgroundColor: '#0b1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links (DexScreener, Solscan) in OS default handler cleanly
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Loading splash screen while embedded server boots
  mainWindow.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(`
        <!doctype html>
        <html>
          <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1117;color:#f1f5f9;font-family:system-ui,-apple-system,sans-serif;">
            <div style="text-align:center;">
              <h2 style="margin:0 0 8px 0;font-size:20px;">Solana Launch Sniper</h2>
              <p style="margin:0;font-size:13px;color:#94a3b8;">Starting desktop trading engine...</p>
            </div>
          </body>
        </html>
      `)
  );
}

app.whenReady().then(async () => {
  buildAppMenu();
  createWindow();

  const alreadyUp = await checkHeartbeat();
  if (!alreadyUp) {
    startEmbeddedBackend();
  }

  const ready = await waitForServer(35000);
  if (ready && mainWindow) {
    mainWindow.loadURL(APP_URL);
  } else if (mainWindow) {
    mainWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(`
          <!doctype html>
          <html>
            <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1117;color:#f87171;font-family:system-ui,sans-serif;">
              <div style="text-align:center;max-width:460px;padding:24px;">
                <h2 style="margin:0 0 10px 0;">Could not start local engine</h2>
                <p style="color:#94a3b8;font-size:13px;">Run <code>npm install</code> in the project root first, then relaunch the desktop app.</p>
              </div>
            </body>
          </html>
        `)
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopEmbeddedBackend();
});

app.on('window-all-closed', () => {
  stopEmbeddedBackend();
  if (process.platform !== 'darwin') app.quit();
});
