const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog, shell } = require('electron');
const path = require('path');
const tracker = require('./tracker');
const library = require('./library');

let mainWindow;
let isTrackingMode = tracker.supported;
let trackerHandle = null;
let vscodeRect = null; // DIP座標のVS Code領域（取れない/最小化中はnull）
let modelInset = null; // ウィンドウ内でのキャラ描画範囲 {left, top, right, bottom}
let cursorTimer = null;
let tray = null;
let creditsWindow = null;

const APP_ROOT = path.join(__dirname, '../..');

// 多重起動防止
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // もう一度起動された／Dockアイコンがクリックされたら表示を戻す
  const bringBack = () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
  };
  app.on('second-instance', bringBack);
  app.on('activate', bringBack);
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.fixtan.live2d-desktop-mascot');
    createWindow();
    createTray();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true, // タスクバーには出さず、トレイから操作する
    minimizable: false, // 最小化させない（隠すのはトレイ／メニューから）
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // レンダラーのログ・エラーをターミナルに出す
  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    // Electron 35+ は引数がイベントオブジェクトにまとまる
    if (message === undefined) ({ level, message, lineNumber: line, sourceId } = e);
    const tag = typeof level === 'string' ? level.toUpperCase() : (['LOG', 'WARN', 'ERROR'][level - 1] || 'DEBUG');
    console.log(`[renderer ${tag}] ${message} (${path.basename(sourceId || '')}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error('[load failed]', code, desc, url);
  });
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('[renderer gone]', details);
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    // どのデスクトップ（Space）・フルスクリーンアプリの上にも表示
    // skipTransformProcessType: これが無いと Electron が Dock アイコンを消してしまう
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }

  // npm start -- --debug で DevTools を別窓で開く
  if (process.argv.includes('--debug')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  trackerHandle = tracker.start((rect) => {
    vscodeRect = rect ? screen.screenToDipRect(null, rect) : null;
    clampToVSCode();
  });
  startCursorTracking();
}

// ===== タスクトレイ =====
function createTray() {
  let icon = nativeImage.createFromPath(path.join(APP_ROOT, 'assets/tray.png'));
  if (icon.isEmpty()) console.warn('[tray] アイコン画像を読めません:', path.join(APP_ROOT, 'assets/tray.png'));
  if (process.platform === 'darwin') icon = icon.resize({ width: 18, height: 18 }); // メニューバー用
  tray = new Tray(icon);
  tray.setToolTip('Live2D Desktop Mascot');
  const send = (type) => mainWindow?.webContents.send('menu-action', { type });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '表示 / 非表示', click: toggleVisible },
    { label: '位置をリセット', click: resetPosition },
    { type: 'separator' },
    { label: '💬 話しかける', click: () => send('talk') },
    { label: '⚙️ 設定を開く', click: () => { mainWindow.show(); mainWindow.webContents.send('open-settings'); } },
    { label: '📜 クレジット', click: openCredits },
    { type: 'separator' },
    { label: '❌ 終了', click: () => app.quit() }
  ]));
  tray.on('double-click', toggleVisible);
}

function toggleVisible() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) { mainWindow.restore(); mainWindow.show(); return; }
  if (mainWindow.isVisible()) mainWindow.hide();
  else mainWindow.show();
}

// メイン画面の右下に戻す
function resetPosition() {
  if (!mainWindow) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const [w, h] = mainWindow.getSize();
  mainWindow.setPosition(wa.x + wa.width - w - 20, wa.y + wa.height - h);
  mainWindow.show();
  clampToVSCode();
}

// ===== クレジット =====
function openCredits() {
  if (creditsWindow) { creditsWindow.focus(); return; }
  creditsWindow = new BrowserWindow({
    width: 560,
    height: 640,
    title: 'クレジット',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  creditsWindow.loadFile(path.join(__dirname, '../renderer/credits.html'), {
    query: { version: app.getVersion() }
  });
  // リンクは既定のブラウザで開く
  creditsWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  creditsWindow.on('closed', () => { creditsWindow = null; });
}

// 画面全体のマウス位置をウィンドウ相対座標でレンダラーへ送る（視線追従・ヒット判定用）
function startCursorTracking() {
  let lastX = null, lastY = null;
  cursorTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = mainWindow.getContentBounds();
    const x = p.x - b.x, y = p.y - b.y;
    if (x === lastX && y === lastY) return;
    lastX = x; lastY = y;
    mainWindow.webContents.send('cursor', { x, y });
  }, 33);
}

// (x, y) をVS Code領域内に収めた座標を返す（判定はキャラの描画範囲）
function clampPosition(x, y) {
  if (!isTrackingMode || !vscodeRect || !mainWindow) return { x, y };
  const [w, h] = mainWindow.getSize();
  const ins = modelInset || { left: 0, top: 0, right: w, bottom: h };
  const r = vscodeRect;
  const clamp1 = (v, min, max) => (max < min ? min : Math.min(Math.max(v, min), max));
  return {
    x: Math.round(clamp1(x, r.x - ins.left, r.x + r.width - ins.right)),
    y: Math.round(clamp1(y, r.y - ins.top, r.y + r.height - ins.bottom))
  };
}

function clampToVSCode() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [x, y] = mainWindow.getPosition();
  const c = clampPosition(x, y);
  if (c.x !== x || c.y !== y) mainWindow.setPosition(c.x, c.y);
}

ipcMain.on('model-bounds', (event, inset) => {
  modelInset = inset;
  clampToVSCode();
});

// クリック透過の切り替え（キャラの上だけクリックを受ける）
// Linux 用：ウィンドウの形を矩形の集合に切り抜く（外側はクリックが下に抜ける）
ipcMain.on('set-shape', (event, rects) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setShape(rects);
});

ipcMain.on('set-ignore-mouse', (event, ignore) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
});

// サイズ変更（足元の中心を固定したままリサイズ）
ipcMain.on('resize-window', (event, { width, height }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getBounds();
  const w = Math.round(width), h = Math.round(height);
  if (w === b.width && h === b.height) return;
  mainWindow.setBounds({
    x: Math.round(b.x + (b.width - w) / 2),
    y: b.y + b.height - h,
    width: w,
    height: h
  });
});

// モデルファイル選択（model3.json を直接参照）
ipcMain.handle('select-model', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Live2Dモデルを選択',
    filters: [{ name: 'Live2D Model (Cubism 3/4)', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ライブラリへ取り込み（ZIP / フォルダ）。p 省略時はダイアログ
ipcMain.handle('import-model', async (event, p) => {
  if (!p) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'モデルを取り込む（ZIP）',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    p = result.filePaths[0];
  }
  try {
    return { id: library.importModel(p) };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('library-list', () => library.listModels());

ipcMain.handle('library-remove', (event, id) => {
  library.removeModel(id);
  return true;
});

// VOICEVOX（CORS回避のためメインプロセスから叩く）
const VOICEVOX = 'http://127.0.0.1:50021';

// 失敗時は例外を投げずに null を返す（エンジン未起動のたびに長いエラーログが出ないように）
let voicevoxWarned = false;
function voicevoxDown(e) {
  if (!voicevoxWarned) console.log('[voicevox] 接続できません（' + (e.cause?.code || e.message) + '）→ OS音声を使用');
  voicevoxWarned = true;
  return null;
}

ipcMain.handle('voicevox-speakers', async () => {
  try {
    const res = await fetch(`${VOICEVOX}/speakers`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('speakers ' + res.status);
    voicevoxWarned = false;
    return await res.json();
  } catch (e) {
    return voicevoxDown(e);
  }
});

ipcMain.handle('voicevox-synth', async (event, { text, speaker, speed = 1 }) => {
  try {
    const q = await fetch(
      `${VOICEVOX}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
      { method: 'POST', signal: AbortSignal.timeout(10000) }
    );
    if (!q.ok) throw new Error('audio_query ' + q.status);
    const query = await q.json();
    query.speedScale = speed;

    const s = await fetch(`${VOICEVOX}/synthesis?speaker=${speaker}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(30000)
    });
    if (!s.ok) throw new Error('synthesis ' + s.status);
    voicevoxWarned = false;
    return new Uint8Array(await s.arrayBuffer());
  } catch (e) {
    return voicevoxDown(e);
  }
});

ipcMain.on('library-open', () => shell.openPath(library.libraryDir()));

// OSネイティブの右クリックメニュー
ipcMain.on('show-context-menu', (event, state = {}) => {
  const send = (type, value) => mainWindow.webContents.send('menu-action', { type, value });
  const template = [
    { label: '💬 話しかける', click: () => send('talk') },
    { type: 'separator' },
    {
      label: '👀 視線追従',
      type: 'checkbox',
      checked: !!state.gaze,
      click: (item) => send('gaze', item.checked)
    },
    {
      label: '🔊 読み上げ',
      type: 'checkbox',
      checked: !!state.voice,
      click: (item) => send('voice', item.checked)
    },
    { type: 'separator' },
    { label: '📦 モデルを取り込む（ZIP）…', click: () => send('import-model') },
    {
      label: '⚙️ 設定を開く',
      click: () => mainWindow.webContents.send('open-settings')
    },
    {
      label: '📌 VS Code固定モード',
      type: 'checkbox',
      checked: isTrackingMode,
      enabled: tracker.supported,
      click: (item) => {
        isTrackingMode = item.checked;
        mainWindow.webContents.send('mode-changed', isTrackingMode);
        clampToVSCode();
      }
    },
    { type: 'separator' },
    { label: '📜 クレジット', click: openCredits },
    { label: '🙈 隠す（トレイから戻せます）', click: () => mainWindow.hide() },
    {
      label: '❌ 終了',
      click: () => app.quit()
    }
  ];
  Menu.buildFromTemplate(template).popup(mainWindow);
});

// ドラッグ移動（固定モード中は枠内にクランプ）
ipcMain.on('move-window', (event, { mouseX, mouseY }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y } = screen.getCursorScreenPoint();
  const c = clampPosition(x - mouseX, y - mouseY);
  mainWindow.setPosition(c.x, c.y);
});

ipcMain.on('set-tracking-mode', (event, enable) => {
  isTrackingMode = enable && tracker.supported;
  clampToVSCode();
});

app.on('before-quit', () => {
  if (trackerHandle) trackerHandle.stop();
  if (cursorTimer) clearInterval(cursorTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
