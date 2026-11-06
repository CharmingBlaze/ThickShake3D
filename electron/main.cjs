// ThickShake desktop shell: window, native file dialogs, autosave storage.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const smokeShot = process.env.THICKSHAKE_SMOKE_SHOT; // test hook: capture a PNG and quit
let win;
let allowClose = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#17191c',
    title: 'ThickShake',
    icon: path.join(__dirname, '..', 'public', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#17191c', symbolColor: '#c9cdd3', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('request-close');
  });

  if (smokeShot) {
    // Packaging test: exercise real file I/O and the unsaved-changes prompt, then quit.
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const report = await win.webContents.executeJavaScript(`(async () => {
          const T = window.__thickshake;
          T.ed.loadModel(T.ed.model, null, 'Smoke');
          T.runCommand('create.box');
          const glb = T.exportGLB(T.ed.model, T.defaultExport);
          const saved = await window.native.saveFile({ path: ${JSON.stringify(`${smokeShot}.glb`)}, data: glb });
          const back = await window.native.readFile(saved.path);
          return { saved: saved.name, bytes: back.data.byteLength, expected: glb.length, dirty: T.ed.dirty };
        })()`);
        win.close(); // Should be intercepted because the document is dirty.
        await new Promise((r) => setTimeout(r, 600));
        report.closePromptShown = await win.webContents.executeJavaScript(`!!document.querySelector('.modal')`);
        report.windowStillOpen = !win.isDestroyed();
        report.iconLoaded = await win.webContents.executeJavaScript(`document.querySelector('.modal-back').remove(); document.querySelector('.app-icon').naturalWidth > 0`);
        win.show();
        win.focus();
        await new Promise((r) => setTimeout(r, 800));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(smokeShot, img.toPNG());
        fs.writeFileSync(`${smokeShot}.json`, JSON.stringify(report, null, 2));
        allowClose = true;
        app.quit();
      }, 2500);
    });
  }
}

// Remove Electron's default menu: its accelerators (Ctrl+R reload, Ctrl+W close, ...)
// would otherwise fire before the app's own shortcuts and could destroy unsaved work.
Menu.setApplicationMenu(null);

const autosaveDir = () => path.join(app.getPath('userData'), 'autosave');

ipcMain.handle('open-file', async (_e, opts) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: opts.filters });
  if (r.canceled || !r.filePaths[0]) return null;
  return readFile(r.filePaths[0]);
});

ipcMain.handle('read-file', async (_e, p) => {
  try { return readFile(p); } catch { return null; }
});

function readFile(p) {
  const b = fs.readFileSync(p);
  return { path: p, name: path.basename(p), data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
}

ipcMain.handle('save-file', async (_e, opts) => {
  let target = opts.path;
  if (!target) {
    const r = await dialog.showSaveDialog(win, { defaultPath: opts.defaultName, filters: opts.filters });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  fs.writeFileSync(target, Buffer.from(opts.data));
  // Sidecar files (e.g. .mtl, .bin) land next to the main file.
  for (const extra of opts.extras || []) {
    fs.writeFileSync(path.join(path.dirname(target), extra.name), Buffer.from(extra.data));
  }
  return { path: target, name: path.basename(target) };
});

ipcMain.handle('set-title', (_e, t) => { if (win) win.setTitle(t); });
ipcMain.handle('confirm-close', () => { allowClose = true; win.close(); });

ipcMain.handle('autosave-write', (_e, text) => {
  fs.mkdirSync(autosaveDir(), { recursive: true });
  fs.writeFileSync(path.join(autosaveDir(), 'recovery.tshake'), text);
});
ipcMain.handle('autosave-read', () => {
  const p = path.join(autosaveDir(), 'recovery.tshake');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
});
ipcMain.handle('autosave-clear', () => {
  const p = path.join(autosaveDir(), 'recovery.tshake');
  if (fs.existsSync(p)) fs.unlinkSync(p);
});

ipcMain.handle('toggle-devtools', () => win.webContents.toggleDevTools());
ipcMain.handle('toggle-fullscreen', () => win.setFullScreen(!win.isFullScreen()));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
