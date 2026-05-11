const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow = null;
let fastifyServer = null;

function ensureConfigDir() {
  const configDir = path.join(app.getPath('userData'), 'config');
  fs.mkdirSync(path.join(configDir, 'hosts'), { recursive: true });
  return configDir;
}

async function startEmbeddedServer() {
  process.env.HERMES_AGENT_EMBEDDED = '1';
  process.env.HERMES_AGENT_CONFIG_DIR = ensureConfigDir();
  process.env.HERMES_AGENT_HOST = '127.0.0.1';

  const serverUrl = pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href;
  const { startServer } = await import(serverUrl);
  const started = await startServer({ host: '127.0.0.1', port: 0 });
  fastifyServer = started.server;
  return `http://${started.host}:${started.port}`;
}

async function createWindow() {
  const localUrl = await startEmbeddedServer();
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 720,
    title: 'Hermes Agent',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(localUrl);
}

app.whenReady().then(() => {
  createWindow().catch(error => {
    dialog.showErrorBox('Hermes Agent failed to start', error instanceof Error ? error.stack || error.message : String(error));
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch(error => {
        dialog.showErrorBox('Hermes Agent failed to start', error instanceof Error ? error.message : String(error));
      });
    }
  });
});

app.on('before-quit', async event => {
  if (!fastifyServer) return;
  event.preventDefault();
  const serverToClose = fastifyServer;
  fastifyServer = null;
  try {
    await serverToClose.close();
  } finally {
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
