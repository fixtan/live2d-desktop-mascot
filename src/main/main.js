const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const tracker = require('./tracker');
const library = require('./library');
const { loadConfig } = require('./config');
const { startBridge } = require('./bridge');

let mainWindow;
let isTrackingMode = tracker.supported;
let trackerHandle = null;
let vscodeRect = null; // DIP座標のVS Code領域（取れない/最小化中はnull）
let modelInset = null; // ウィンドウ内でのキャラ描画範囲 {left, top, right, bottom}
let cursorTimer = null;
let tray = null;
let creditsWindow = null;
let settingsWindow = null;
let lastSettingsState = null; // レンダラーから届いた最新の設定状態（設定ウィンドウを開いた直後に渡す）
let bridge = null;

const APP_ROOT = path.join(__dirname, '../..');

// Linux：Electron 38 から Wayland セッションではネイティブ Wayland で動く。
// Wayland ではウィンドウ位置の取得・移動、画面全体のカーソル位置、setShape が使えないため XWayland に固定する
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

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
    startBridgeFromConfig();
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
    roundedCorners: false, // Electron 43 から Linux でも既定 true。透明窓の角でキャラが欠けないように
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // レンダラーのログ・エラーをターミナルに出す
  mainWindow.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    console.log(`[renderer ${String(level).toUpperCase()}] ${message} (${path.basename(sourceId || '')}:${lineNumber})`);
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

  // npm start -- --devtools で DevTools を別窓で開く（--debug は Node のフラグとして弾かれる）
  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  trackerHandle = tracker.start((rect) => {
    vscodeRect = rect ? screen.screenToDipRect(null, rect) : null;
    clampToVSCode();
  });
  startCursorTracking();
}

// ===== VS Code拡張との連携（WebSocket） =====
async function startBridgeFromConfig() {
  const { config } = loadConfig(app.getPath('userData'));
  if (!config.bridge.enabled) { console.log('[bridge] 無効（config.json）'); return; }
  try {
    bridge = await startBridge({
      dir: app.getPath('userData'),
      port: config.bridge.port,
      version: app.getVersion(),
      onEvent: (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bridge-event', msg);
      }
    });
  } catch (e) {
    console.error('[bridge] 起動できません:', e.message);
  }
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
    { label: '⚙️ 設定を開く', click: openSettingsWindow },
    { label: '📜 クレジット', click: openCredits },
    { label: '📂 設定フォルダを開く', click: () => shell.openPath(app.getPath('userData')) },
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

// ===== 設定ウィンドウ =====
// 設定の値と反映はマスコット側（app.js）が持つ。設定ウィンドウは操作を送り、状態を受け取って表示するだけ
//   設定ウィンドウ → 'settings-action' → メイン → マスコット
//   マスコット → 'settings-state' → メイン → 設定ウィンドウ
const SETTINGS_W = 340, SETTINGS_H = 760;

function settingsWindowFile() { return path.join(app.getPath('userData'), 'settings-window.json'); }

function loadSettingsBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(settingsWindowFile(), 'utf8'));
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
    // 画面構成が変わって見えない位置になっていたら使わない
    const visible = screen.getAllDisplays().some(({ workArea: w }) =>
      b.x < w.x + w.width - 40 && b.x + b.width > w.x + 40 && b.y >= w.y - 10 && b.y < w.y + w.height - 40);
    return visible ? b : null;
  } catch { return null; }
}

// 初回：マスコットの横（左に空きがあれば左、無ければ右）
function defaultSettingsBounds() {
  const m = mainWindow.getBounds();
  const wa = screen.getDisplayMatching(m).workArea;
  const w = SETTINGS_W, h = Math.min(SETTINGS_H, wa.height);
  let x = m.x - w - 8;
  if (x < wa.x) x = Math.min(m.x + m.width + 8, wa.x + wa.width - w);
  const y = Math.max(wa.y, Math.min(m.y + m.height - h, wa.y + wa.height - h));
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

function openSettingsWindow() {
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return; }
  if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  settingsWindow = new BrowserWindow({
    ...(loadSettingsBounds() || defaultSettingsBounds()),
    minWidth: 300,
    minHeight: 400,
    title: 'マスコット設定',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    backgroundColor: '#252526',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('close', () => {
    try { fs.writeFileSync(settingsWindowFile(), JSON.stringify(settingsWindow.getBounds())); } catch {}
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function notifyTrackingMode() {
  settingsWindow?.webContents.send('tracking-changed', { on: isTrackingMode, supported: tracker.supported });
}

ipcMain.on('settings-state', (event, state) => {
  lastSettingsState = state;
  settingsWindow?.webContents.send('settings-state', state);
});
ipcMain.handle('settings-get-state', () => lastSettingsState);
ipcMain.on('settings-action', (event, action) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings-action', action);
});
ipcMain.handle('tracking-get', () => ({ on: isTrackingMode, supported: tracker.supported }));

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
    { label: '⚙️ 設定を開く', click: openSettingsWindow },
    {
      label: '📌 VS Code固定モード',
      type: 'checkbox',
      checked: isTrackingMode,
      enabled: tracker.supported,
      click: (item) => {
        isTrackingMode = item.checked;
        notifyTrackingMode();
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
  notifyTrackingMode();
  clampToVSCode();
});

app.on('before-quit', () => {
  if (bridge) bridge.stop();
  if (trackerHandle) trackerHandle.stop();
  if (cursorTimer) clearInterval(cursorTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
