const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const tracker = require('./tracker');
const library = require('./library');
const motions = require('./motions');
const { isMotionFile } = require('../shared/motions');
const { loadConfig } = require('./config');
const { startBridge } = require('./bridge');
const { createStore } = require('./characters');
const { thumbnailUrl } = require('./thumbs');
const { FORMATS, importExtensions, importLabel } = require('../shared/formats');

// ===== キャラ =====
// 1キャラ＝透明ウィンドウ1枚。親はメインプロセス（bridge・トレイ・設定ファイルを持つ）
// mascots: id → { id, win, inset }  inset はウィンドウ内でのキャラ描画範囲 {left, top, right, bottom}
const mascots = new Map();
let store = null;       // characters.json（一覧・キャラごとの設定・位置）
const WIN_W = 400, WIN_H = 600; // 作った直後の大きさ（すぐにモデルに合わせて変わる）

let trackerHandle = null;
let vscodeRect = null; // DIP座標のVS Code領域（取れない/最小化中はnull）
let cursorTimer = null;
let tray = null;
let creditsWindow = null;
let settingsWindow = null;
let settingsTarget = null;      // 設定ウィンドウで選んでいるキャラ
const lastStates = new Map();   // id → レンダラーから届いた最新の設定状態
let bridge = null;

const APP_ROOT = path.join(__dirname, '../..');

const liveMascots = () => [...mascots.values()].filter((m) => !m.win.isDestroyed());
const primaryMascot = () => { const m = mascots.get(store.primary()); return m && !m.win.isDestroyed() ? m : null; };
function mascotOf(sender) {
  for (const m of mascots.values()) if (!m.win.isDestroyed() && m.win.webContents === sender) return m;
  return null;
}

// Linux：Electron 38 から Wayland セッションではネイティブ Wayland で動く。
// Wayland ではウィンドウ位置の取得・移動、画面全体のカーソル位置、setShape が使えないため XWayland に固定する
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

// GPU が使えない環境（リモートデスクトップ・VM）では WebGL が拒否されて何も描けない。
// Chromium は SwiftShader（ソフトウェア描画）への自動フォールバックをやめたので明示的に許可する。
// GPU がある環境では使われない。読み込むのはローカルのファイルだけなので "unsafe" の懸念（外部ページの JIT）は当たらない
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

// 多重起動防止
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // もう一度起動された／Dockアイコンがクリックされたら表示を戻す
  const bringBack = () => liveMascots().forEach((m) => { if (m.win.isMinimized()) m.win.restore(); m.win.show(); });
  app.on('second-instance', bringBack);
  app.on('activate', bringBack);
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.fixtan.live2d-desktop-mascot');
    store = createStore(app.getPath('userData'));
    store.list().forEach((id, i) => createMascotWindow(id, { index: i }));
    trackerHandle = tracker.start((rect) => {
      vscodeRect = rect ? screen.screenToDipRect(null, rect) : null;
      clampAll();
    });
    startCursorTracking();
    createTray();
    startBridgeFromConfig();
  });
}

// 画面のどこかに十分見えているか（画面構成が変わって見えない位置になった時は使わない）
function onScreen(b) {
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width - 40 && b.x + b.width > w.x + 40 && b.y >= w.y - 10 && b.y < w.y + w.height - 40);
}

// メイン画面の右下から左へ並べる
function defaultBounds(index, w = WIN_W, h = WIN_H) {
  const wa = screen.getPrimaryDisplay().workArea;
  const x = Math.max(wa.x, wa.x + wa.width - w - 20 - index * 260);
  return { x, y: wa.y + wa.height - h, width: w, height: h };
}

const boundsFromAnchor = (a, w = WIN_W, h = WIN_H) =>
  ({ x: Math.round(a.x - w / 2), y: Math.round(a.bottom - h), width: w, height: h });

function createMascotWindow(id, { index = 0, anchor = null } = {}) {
  const saved = anchor || store.get(id)?.anchor;
  let bounds = saved ? boundsFromAnchor(saved) : null;
  if (!bounds || !onScreen(bounds)) bounds = defaultBounds(index);

  const win = new BrowserWindow({
    ...bounds,
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
  const m = { id, win, inset: null };
  mascots.set(id, m);

  // レンダラーのログ・エラーをターミナルに出す
  win.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
    console.log(`[${id} ${String(level).toUpperCase()}] ${message} (${path.basename(sourceId || '')}:${lineNumber})`);
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error(`[${id} load failed]`, code, desc, url);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    console.error(`[${id} renderer gone]`, details);
  });

  // 足元の位置を覚える（次の起動で同じ場所に出す）
  win.on('move', () => {
    const b = win.getBounds();
    store.setAnchor(id, { x: Math.round(b.x + b.width / 2), bottom: b.y + b.height });
  });
  win.on('closed', () => {
    if (mascots.get(id) === m) mascots.delete(id);
    if (speech.id === id) speech = { id: null, until: 0 };
    if (settingsTarget === id) setSettingsTarget(store.primary());
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { id } });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    // どのデスクトップ（Space）・フルスクリーンアプリの上にも表示
    // skipTransformProcessType: これが無いと Electron が Dock アイコンを消してしまう
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  }

  // npm start -- --devtools で DevTools を別窓で開く（--debug は Node のフラグとして弾かれる）
  if (process.argv.includes('--devtools')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  return m;
}

// 起動時の設定（同期）。settings が null なら既定値。migrate なら localStorage の旧設定を引き継ぐ
ipcMain.on('character-init', (event) => {
  const m = mascotOf(event.sender);
  if (!m) { event.returnValue = null; return; }
  let settings = store.get(m.id)?.settings || null;
  // v1.4 の未リリース版で全体の動作モードを OFF にしていたら、キャラごとの設定に引き継ぐ
  if (settings && !('follow' in settings) && store.getShared('trackingMode') === false) settings = { ...settings, follow: false };
  event.returnValue = {
    id: m.id,
    settings,
    migrate: store.shouldMigrate(m.id),
    primary: m.id === store.primary()
  };
});

// 代表（先頭のキャラ）が変わったら知らせる
function notifyRoles() {
  for (const m of liveMascots()) m.win.webContents.send('role', { primary: m.id === store.primary() });
}

function addCharacter() {
  const base = mascots.get(settingsTarget) || primaryMascot();
  let anchor = null;
  if (base) {
    const b = base.win.getBounds();
    anchor = { x: b.x - 140, bottom: b.y + b.height }; // 今のキャラの左どなり
  }
  const id = store.add();
  createMascotWindow(id, { index: store.list().length - 1, anchor }); // 固定モードの枠内へは model-bounds が届いた時に寄せる
  setSettingsTarget(id);
}

function removeCharacter(id) {
  const m = mascots.get(id);
  const wasPrimary = id === store.primary();
  if (!store.remove(id)) return;
  lastStates.delete(id);
  if (m && !m.win.isDestroyed()) m.win.destroy();
  mascots.delete(id);
  if (speech.id === id) speech = { id: null, until: 0 };
  if (wasPrimary) notifyRoles();
  setSettingsTarget(store.primary());
}

// ===== 話す順番 =====
// 同時にしゃべらないよう、しゃべる前にメインへ申し出る。
//   自動（ランダム・時報・VS Code）：誰かが話し中なら見送り
//   手動（クリック・話しかける・試聴など）：話し中のキャラを止めて割り込む
// 終わったら speech-end。来なくても SPEECH_MAX で解放
const SPEECH_MAX = 60000;
let speech = { id: null, until: 0 };

ipcMain.on('speech-claim', (event, manual) => {
  const m = mascotOf(event.sender);
  if (!m) { event.returnValue = false; return; }
  const now = Date.now();
  const other = speech.id && speech.id !== m.id && now < speech.until ? mascots.get(speech.id) : null;
  if (other && !other.win.isDestroyed()) {
    if (!manual) { event.returnValue = false; return; }
    other.win.webContents.send('speech-stop');
  }
  speech = { id: m.id, until: now + SPEECH_MAX };
  event.returnValue = true;
});

ipcMain.on('speech-end', (event) => {
  const m = mascotOf(event.sender);
  if (m && speech.id === m.id) speech = { id: null, until: 0 };
});

// ===== VS Code拡張との連携（WebSocket） =====
// 反応するのは代表だけ（全員一斉はうるさい）
async function startBridgeFromConfig() {
  const { config } = loadConfig(app.getPath('userData'));
  if (!config.bridge.enabled) { console.log('[bridge] 無効（config.json）'); return; }
  try {
    bridge = await startBridge({
      dir: app.getPath('userData'),
      port: config.bridge.port,
      version: app.getVersion(),
      onEvent: (msg) => primaryMascot()?.win.webContents.send('bridge-event', msg)
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '表示 / 非表示', click: toggleVisible },
    { label: '位置をリセット', click: resetPosition },
    { type: 'separator' },
    { label: '💬 話しかける', click: () => primaryMascot()?.win.webContents.send('menu-action', { type: 'talk' }) },
    { label: '⚙️ 設定を開く', click: () => openSettingsWindow() },
    { label: '📜 クレジット', click: openCredits },
    { label: '📂 設定フォルダを開く', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '❌ 終了', click: () => app.quit() }
  ]));
  tray.on('double-click', toggleVisible);
}

// 1体でも見えていれば全員隠す。全員隠れていれば全員出す
function toggleVisible() {
  const all = liveMascots();
  const anyVisible = all.some((m) => m.win.isVisible() && !m.win.isMinimized());
  for (const m of all) {
    if (anyVisible) m.win.hide();
    else { if (m.win.isMinimized()) m.win.restore(); m.win.show(); }
  }
}

// メイン画面の右下から並べ直す
function resetPosition() {
  store.list().forEach((id, i) => {
    const m = mascots.get(id);
    if (!m || m.win.isDestroyed()) return;
    const [w, h] = m.win.getSize();
    const b = defaultBounds(i, w, h);
    m.win.setPosition(b.x, b.y);
    m.win.show();
    clampToVSCode(m);
  });
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
//   設定ウィンドウ → 'settings-action' → メイン → 選んでいるキャラ
//   各キャラ → 'settings-state' → メイン（characters.json に保存）→ 設定ウィンドウ
const SETTINGS_W = 340, SETTINGS_H = 800;

function settingsWindowFile() { return path.join(app.getPath('userData'), 'settings-window.json'); }

function loadSettingsBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(settingsWindowFile(), 'utf8'));
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
    return onScreen(b) ? b : null;
  } catch { return null; }
}

// 初回：マスコットの横（左に空きがあれば左、無ければ右）
function defaultSettingsBounds() {
  const target = mascots.get(settingsTarget) || primaryMascot();
  const m = target ? target.win.getBounds() : defaultBounds(0);
  const wa = screen.getDisplayMatching(m).workArea;
  const w = SETTINGS_W, h = Math.min(SETTINGS_H, wa.height);
  let x = m.x - w - 8;
  if (x < wa.x) x = Math.min(m.x + m.width + 8, wa.x + wa.width - w);
  const y = Math.max(wa.y, Math.min(m.y + m.height - h, wa.y + wa.height - h));
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

function openSettingsWindow(targetId) {
  setSettingsTarget(targetId || settingsTarget || store.primary());
  const target = mascots.get(settingsTarget);
  if (target && !target.win.isDestroyed() && !target.win.isVisible()) target.win.show();
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return; }
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

function modelLabel(model) {
  if (!model) return '?';
  if (model.startsWith('lib:')) return model.slice(4);
  return path.isAbsolute(model) ? path.basename(model) : model;
}

// 設定ウィンドウに渡す状態：選んでいるキャラの状態＋キャラ一覧
function settingsView() {
  const s = lastStates.get(settingsTarget);
  if (!s) return null;
  const primary = store.primary();
  return {
    ...s,
    target: settingsTarget,
    primary: settingsTarget === primary,
    followSupported: tracker.supported,
    characters: store.list().map((id, i) => ({
      id,
      model: lastStates.get(id)?.settings.model ?? store.get(id)?.settings?.model ?? null,
      modelPath: (() => { const st = lastStates.get(id); return st ? st.modelPaths?.[st.settings.model] ?? null : null; })(),
      label: `${i + 1}: ${modelLabel(lastStates.get(id)?.settings.model ?? store.get(id)?.settings?.model)}${id === primary ? '（代表）' : ''}`
    }))
  };
}

function pushSettingsView() {
  const v = settingsView();
  if (v) settingsWindow?.webContents.send('settings-state', v);
}

function setSettingsTarget(id) {
  if (!store.get(id)) id = store.primary();
  settingsTarget = id;
  pushSettingsView();
}

ipcMain.on('settings-state', (event, state) => {
  const m = mascotOf(event.sender);
  if (!m || !state?.settings) return;
  lastStates.set(m.id, state);
  store.setSettings(m.id, state.settings);
  clampToVSCode(m); // VS Code 追従を入れた時に枠内へ寄せる
  pushSettingsView(); // 他のキャラの変更でも一覧の名前が変わる
});
ipcMain.handle('settings-get-state', () => settingsView());
ipcMain.on('settings-action', (event, action) => {
  const m = mascots.get(settingsTarget);
  if (m && !m.win.isDestroyed()) m.win.webContents.send('settings-action', action);
});
// サムネ：ファイル → data URL（無ければ null）
ipcMain.handle('model-thumbs', (event, files) =>
  Object.fromEntries((Array.isArray(files) ? files : []).filter((f) => typeof f === 'string').map((f) => [f, thumbnailUrl(f)])));
ipcMain.on('settings-select-character', (event, id) => setSettingsTarget(id));
ipcMain.on('character-add', () => addCharacter());
ipcMain.on('character-remove', (event, id) => removeCharacter(id));

// 画面全体のマウス位置をウィンドウ相対座標で各キャラへ送る（視線追従・ヒット判定用）
function startCursorTracking() {
  cursorTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    for (const m of liveMascots()) {
      const b = m.win.getContentBounds();
      const x = p.x - b.x, y = p.y - b.y;
      if (x === m.lastX && y === m.lastY) continue;
      m.lastX = x; m.lastY = y;
      m.win.webContents.send('cursor', { x, y });
    }
  }, 33);
}

// VS Code 追従はキャラごと（Windows のみ）
function follows(m) {
  if (!tracker.supported) return false;
  const st = lastStates.get(m.id)?.settings ?? store.get(m.id)?.settings;
  return st?.follow !== false;
}

// (x, y) をVS Code領域内に収めた座標を返す（判定はキャラの描画範囲）
function clampPosition(m, x, y) {
  if (!follows(m) || !vscodeRect) return { x, y };
  const [w, h] = m.win.getSize();
  const ins = m.inset || { left: 0, top: 0, right: w, bottom: h };
  const r = vscodeRect;
  const clamp1 = (v, min, max) => (max < min ? min : Math.min(Math.max(v, min), max));
  return {
    x: Math.round(clamp1(x, r.x - ins.left, r.x + r.width - ins.right)),
    y: Math.round(clamp1(y, r.y - ins.top, r.y + r.height - ins.bottom))
  };
}

function clampToVSCode(m) {
  if (!m || m.win.isDestroyed()) return;
  const [x, y] = m.win.getPosition();
  const c = clampPosition(m, x, y);
  if (c.x !== x || c.y !== y) m.win.setPosition(c.x, c.y);
}

const clampAll = () => liveMascots().forEach(clampToVSCode);

// 送り主のキャラに対して処理する IPC
const onMascot = (channel, fn) => ipcMain.on(channel, (event, arg) => {
  const m = mascotOf(event.sender);
  if (m) fn(m, arg);
});

onMascot('model-bounds', (m, inset) => {
  m.inset = inset;
  clampToVSCode(m);
});

// クリック透過の切り替え（キャラの上だけクリックを受ける）
// Linux 用：ウィンドウの形を矩形の集合に切り抜く（外側はクリックが下に抜ける）
onMascot('set-shape', (m, rects) => m.win.setShape(rects));

onMascot('set-ignore-mouse', (m, ignore) => m.win.setIgnoreMouseEvents(ignore, { forward: true }));

// サイズ変更（足元の中心を固定したままリサイズ）
onMascot('resize-window', (m, { width, height }) => {
  const b = m.win.getBounds();
  const w = Math.round(width), h = Math.round(height);
  if (w === b.width && h === b.height) return;
  m.win.setBounds({
    x: Math.round(b.x + (b.width - w) / 2),
    y: b.y + b.height - h,
    width: w,
    height: h
  });
});

// ドラッグ移動（固定モード中は枠内にクランプ）
onMascot('move-window', (m, { mouseX, mouseY }) => {
  const { x, y } = screen.getCursorScreenPoint();
  const c = clampPosition(m, x - mouseX, y - mouseY);
  m.win.setPosition(c.x, c.y);
});

// モデルファイル選択（取り込まずに直接参照）
ipcMain.handle('select-model', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'モデルを選択',
    filters: [
      { name: 'モデル', extensions: [...new Set(FORMATS.flatMap((f) => f.dialogExtensions))] },
      ...FORMATS.map((f) => ({ name: f.name, extensions: f.dialogExtensions }))
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ライブラリへ取り込み（ZIP / .vrm / フォルダ）。p 省略時はダイアログ
ipcMain.handle('import-model', async (event, p) => {
  if (!p) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: `モデルを取り込む（${importLabel}）`,
      filters: [{ name: importLabel, extensions: importExtensions }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return null;
    p = result.filePaths[0];
  }
  try {
    // モデルが入っておらず .vrma だけの ZIP はモーションパックとして取り込む
    if (/\.zip$/i.test(p)) {
      const zip = library.openZip(p);
      if (!library.zipHasModel(zip) && zip.getEntries().some((e) => isMotionFile(e.entryName))) {
        const n = motions.importZip(zip);
        broadcastMotionsChanged(event.sender);
        return { motions: n };
      }
    }
    const id = library.importModel(p);
    broadcastLibraryChanged(event.sender);
    return { id };
  } catch (e) {
    return { error: e.message };
  }
});

// ライブラリ・モーションはキャラ共通。変わったら他のキャラにも知らせる（設定ウィンドウの一覧用）
function broadcastLibraryChanged(except) {
  for (const m of liveMascots()) if (m.win.webContents !== except) m.win.webContents.send('library-changed');
}
function broadcastMotionsChanged(except) {
  for (const m of liveMascots()) if (m.win.webContents !== except) m.win.webContents.send('motions-changed');
}

// モーション（VRMA）。全モデル共通のフォルダ
ipcMain.handle('motions-list', () => motions.listMotions());
ipcMain.handle('motions-import', (event, paths) => {
  try {
    const n = motions.importFiles(paths);
    broadcastMotionsChanged(event.sender);
    return { motions: n };
  } catch (e) { return { error: e.message }; }
});
ipcMain.on('motions-open', () => shell.openPath(motions.motionsDir()));

ipcMain.handle('library-list', () => library.listModels());

ipcMain.handle('library-remove', (event, id) => {
  library.removeModel(id);
  broadcastLibraryChanged(event.sender);
  return true;
});

// VOICEVOX（CORS回避のためメインプロセスから叩く）
const VOICEVOX = 'http://127.0.0.1:50021';

// 失敗時は例外を投げずに null を返す（エンジン未起動のたびに長いエラーログが出ないように）
let voicevoxWarned = false;
function voicevoxDown(e) {
  if (!voicevoxWarned) console.log('[voicevox] 接続できません（' + (e.cause?.code || e.message) + '）→ ボイスパック／OS音声を使用');
  voicevoxWarned = true;
  return null;
}

// 話者一覧。右クリックのたびに取りに行かないよう 30 秒覚える
// quick：右クリック用。エンジンが返事をしなくてもメニューを待たせない
let speakersCache = { at: 0, list: null };
async function voicevoxSpeakers({ quick = false } = {}) {
  if (speakersCache.list && Date.now() - speakersCache.at < 30000) return speakersCache.list;
  try {
    const res = await fetch(`${VOICEVOX}/speakers`, { signal: AbortSignal.timeout(quick ? 800 : 3000) });
    if (!res.ok) throw new Error('speakers ' + res.status);
    voicevoxWarned = false;
    speakersCache = { at: Date.now(), list: await res.json() };
    return speakersCache.list;
  } catch (e) {
    speakersCache = { at: 0, list: null };
    return voicevoxDown(e);
  }
}
ipcMain.handle('voicevox-speakers', () => voicevoxSpeakers());

// 合成結果を覚えておく（ボイスパックのセリフは決まっているので、2回目からクリックの反応が待たない）
const synthCache = new Map();
const SYNTH_CACHE_MAX = 64;

ipcMain.handle('voicevox-synth', async (event, { text, speaker, speed = 1 }) => {
  const key = `${speaker}:${speed}:${text}`;
  const hit = synthCache.get(key);
  if (hit) {
    synthCache.delete(key); // 新しい側へ
    synthCache.set(key, hit);
    return hit;
  }
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
    const wav = new Uint8Array(await s.arrayBuffer());
    synthCache.set(key, wav);
    if (synthCache.size > SYNTH_CACHE_MAX) synthCache.delete(synthCache.keys().next().value);
    return wav;
  } catch (e) {
    return voicevoxDown(e);
  }
});

ipcMain.on('library-open', () => shell.openPath(library.libraryDir()));

// OSネイティブの右クリックメニュー（そのキャラの設定）
// 中身はそのキャラから最後に届いた状態（settings-state）で作り、操作は設定ウィンドウと同じ settings-action で送る
const VOICE_MODES = [
  ['pack', 'ボイスパックだけ'],
  ['voicevox', 'VOICEVOX'],
  ['os', 'ボイスパック＋OS 音声'],
  ['mute', 'ミュート（字幕だけ）']
];

function voiceModeOf(st) {
  if (st.mute) return 'mute';
  if (!st.voice) return 'pack';
  return st.ttsEngine === 'os' ? 'os' : 'voicevox';
}

onMascot('show-context-menu', async (m) => {
  const state = lastStates.get(m.id);
  const st = state?.settings || {};
  const act = (type, extra = {}) => m.win.webContents.send('settings-action', { type, ...extra });
  const set = (key, value) => act('set', { key, value });
  const isPrimary = m.id === store.primary();
  const mode = voiceModeOf(st);

  // モデル：同梱・ライブラリ・外部（直接開いたファイル）
  const modelItems = [];
  const radio = (label, value) => ({ label, type: 'radio', checked: st.model === value, click: () => act('model', { value }) });
  if (state?.bundled?.length) {
    modelItems.push({ label: '同梱', enabled: false }, ...state.bundled.map((id) => radio(id, id)));
  }
  if (state?.library?.length) {
    if (modelItems.length) modelItems.push({ type: 'separator' });
    modelItems.push({ label: 'ライブラリ', enabled: false }, ...state.library.map((id) => radio(id, 'lib:' + id)));
  }
  if (st.model && path.isAbsolute(st.model)) {
    modelItems.push({ type: 'separator' }, radio('📁 ' + path.basename(st.model), st.model));
  }
  if (!modelItems.length) modelItems.push({ label: '（モデルがありません）', enabled: false });

  // VOICEVOX の話者：話者 ▸ スタイル。エンジンが起動していなければ灰色
  const speakers = mode === 'voicevox' ? await voicevoxSpeakers({ quick: true }) : null;
  let speakerItem;
  if (speakers) {
    speakerItem = {
      label: '🎙 VOICEVOX の話者',
      submenu: speakers.map((sp) => ({
        // サブメニューを持つ項目にはチェックを付けられないので、今の話者は印で示す
        label: (sp.styles.some((t) => t.id === st.voicevoxSpeaker) ? '● ' : '　') + sp.name,
        submenu: sp.styles.map((t) => ({
          label: t.name,
          type: 'radio',
          checked: t.id === st.voicevoxSpeaker,
          click: () => set('voicevoxSpeaker', t.id)
        }))
      }))
    };
  } else {
    speakerItem = {
      label: mode === 'voicevox' ? '🎙 VOICEVOX の話者（エンジン未起動）' : '🎙 VOICEVOX の話者',
      enabled: false
    };
  }

  const template = [
    { label: '💬 話しかける', click: () => act('talk') },
    { type: 'separator' },
    { label: '👗 モデル', submenu: modelItems },
    {
      label: '🔊 声',
      submenu: VOICE_MODES.map(([value, label]) => ({
        label, type: 'radio', checked: mode === value, click: () => act('voice-mode', { value })
      }))
    },
    speakerItem,
    { type: 'separator' },
    { label: '👀 視線追従', type: 'checkbox', checked: st.gaze !== false, click: (item) => set('gaze', item.checked) },
    { label: '🎲 ランダムイベント', type: 'checkbox', checked: st.events !== false, click: (item) => set('events', item.checked) },
    {
      label: isPrimary ? '🕐 時報' : '🕐 時報（代表のみ）',
      type: 'checkbox',
      checked: st.chime !== false,
      enabled: isPrimary,
      click: (item) => set('chime', item.checked)
    },
    {
      label: tracker.supported ? '📌 VS Code に追従' : '📌 VS Code に追従（Windows のみ）',
      type: 'checkbox',
      checked: follows(m),
      enabled: tracker.supported,
      click: (item) => set('follow', item.checked)
    },
    { type: 'separator' },
    { label: '⚙️ 設定を開く', click: () => openSettingsWindow(m.id) },
    { label: '📜 クレジット', click: openCredits },
    { label: '🙈 隠す（トレイから戻せます）', click: () => m.win.hide() },
    { label: '❌ 終了', click: () => app.quit() }
  ];
  if (m.win.isDestroyed()) return;
  Menu.buildFromTemplate(template).popup(m.win);
});

app.on('before-quit', () => {
  store?.flush();
  if (bridge) bridge.stop();
  if (trackerHandle) trackerHandle.stop();
  if (cursorTimer) clearInterval(cursorTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
