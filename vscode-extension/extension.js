// Live2D Mascot Bridge — VS Code のイベントを Live2D Desktop Mascot に WebSocket で送る
//
// マスコットが書き出す bridge.json（host / port / token / pid）を読んで接続する。
// マスコットが起動していない・終了した時は 5 秒おきに読み直して、つながるまで待つ。
// プロトコルはリポジトリの README「VS Code 連携（WebSocket）」を参照。
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROTOCOL = 1;
const APP_DIR = 'Live2D Desktop Mascot'; // マスコットの productName ＝ userData のフォルダ名
const RETRY_MS = 5000;
const DIAG_DEBOUNCE_MS = 1500;

// Node 22（VS Code 1.101+）は標準の WebSocket を持つ。無い環境では ws を探す
const WebSocketImpl = globalThis.WebSocket ?? (() => { try { return require('ws'); } catch { return null; } })();

const cfg = () => vscode.workspace.getConfiguration('live2dMascot');

function bridgeFilePath() {
  const custom = cfg().get('bridgeFile');
  if (custom) return custom;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_DIR, 'bridge.json');
    case 'darwin': return path.join(home, 'Library', 'Application Support', APP_DIR, 'bridge.json');
    default: return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_DIR, 'bridge.json');
  }
}

// bridge.json を読む。無い・壊れている・書いたプロセスが死んでいる時は null
function readBridgeInfo() {
  let info;
  try { info = JSON.parse(fs.readFileSync(bridgeFilePath(), 'utf8')); } catch { return null; }
  if (!info || info.v !== PROTOCOL || !info.port || !info.token) return null;
  if (info.pid) {
    try { process.kill(info.pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; }
  }
  return info;
}

class Bridge {
  constructor(log, { onConnected, onStatus }) {
    this.log = log;
    this.onConnected = onConnected;
    this.onStatus = onStatus;
    this.ws = null;
    this.connected = false;
    this.running = false;
    this.retryTimer = null;
    this.waitingLogged = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null;
    this.setConnected(false);
  }

  reconnect() {
    this.stop();
    this.waitingLogged = false;
    this.start();
  }

  setConnected(on) {
    this.connected = on;
    this.onStatus(on ? 'connected' : this.running ? 'waiting' : 'off');
  }

  scheduleRetry() {
    if (!this.running || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, RETRY_MS);
  }

  connect() {
    if (!this.running || this.ws) return;
    if (!WebSocketImpl) {
      this.log.error('WebSocket が使えません（VS Code 1.101 以降が必要）');
      return;
    }
    const info = readBridgeInfo();
    if (!info) {
      if (!this.waitingLogged) this.log.info(`マスコットを待っています（${bridgeFilePath()}）`);
      this.waitingLogged = true;
      this.setConnected(false);
      this.scheduleRetry();
      return;
    }

    const url = `ws://${info.host || '127.0.0.1'}:${info.port}/?token=${encodeURIComponent(info.token)}`;
    let ws;
    try { ws = new WebSocketImpl(url); } catch (e) {
      this.log.warn('接続できません:', e.message);
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === 'welcome' && !this.connected) {
        this.log.info(`接続しました（port ${info.port}、マスコット v${msg.payload?.version ?? '?'}）`);
        this.waitingLogged = false;
        this.setConnected(true);
        this.onConnected();
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.connected) this.log.info('切断されました');
      this.ws = null;
      this.setConnected(false);
      this.scheduleRetry();
    };
    ws.onerror = () => {}; // 続けて close が来るのでそちらで処理する
  }

  send(type, payload = {}) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ v: PROTOCOL, type, payload, ts: Date.now() }));
    return true;
  }
}

function countDiagnostics() {
  let errors = 0, warnings = 0;
  for (const [, list] of vscode.languages.getDiagnostics()) {
    for (const d of list) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    }
  }
  return { errors, warnings };
}

function activate(context) {
  const log = vscode.window.createOutputChannel('Live2D Mascot', { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'live2dMascot.reconnect';
  context.subscriptions.push(log, status);

  const eventOn = (name) => cfg().get('events')?.[name] !== false;

  // ===== 診断（エラー・警告数）：変化したらデバウンスして送る =====
  let lastDiag = null;
  let diagTimer = null;
  const sendDiagnostics = (force = false) => {
    if (!eventOn('diagnostics')) return;
    const d = countDiagnostics();
    if (!force && lastDiag && d.errors === lastDiag.errors && d.warnings === lastDiag.warnings) return;
    if (bridge.send('diagnostics', { ...d, workspace: vscode.workspace.name })) lastDiag = d;
  };

  const bridge = new Bridge(log, {
    // 接続直後に今の件数を送る（マスコット側はこれを基準値として扱う）
    onConnected: () => { lastDiag = null; sendDiagnostics(true); },
    onStatus: (s) => {
      if (s === 'off') { status.hide(); return; }
      const on = s === 'connected';
      status.text = on ? '$(heart) Mascot' : '$(debug-disconnect) Mascot';
      status.tooltip = on ? 'Live2D Mascot：接続中（クリックで再接続）' : 'Live2D Mascot：マスコットを待っています（クリックで再接続）';
      status.show();
    }
  });
  context.subscriptions.push({ dispose: () => bridge.stop() });

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      clearTimeout(diagTimer);
      diagTimer = setTimeout(() => sendDiagnostics(), DIAG_DEBOUNCE_MS);
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!eventOn('save')) return;
      bridge.send('save', { file: path.basename(doc.fileName), languageId: doc.languageId, workspace: vscode.workspace.name });
    }),

    vscode.debug.onDidStartDebugSession((s) => {
      if (!eventOn('debug') || s.parentSession) return; // 子セッションは数えない
      bridge.send('debugStart', { name: s.name, type: s.type, workspace: vscode.workspace.name });
    }),

    vscode.tasks.onDidEndTaskProcess((e) => {
      if (!eventOn('task')) return;
      const payload = { name: e.execution.task.name, source: e.execution.task.source, workspace: vscode.workspace.name };
      if (Number.isInteger(e.exitCode)) payload.exitCode = e.exitCode; // 無い時はマスコット側で無反応
      bridge.send('taskEnd', payload);
    }),

    vscode.commands.registerCommand('live2dMascot.reconnect', () => {
      if (!cfg().get('enabled')) { vscode.window.showInformationMessage('Live2D Mascot は無効になっています（live2dMascot.enabled）'); return; }
      bridge.reconnect();
    }),

    vscode.commands.registerCommand('live2dMascot.say', async () => {
      const text = await vscode.window.showInputBox({ prompt: 'マスコットにしゃべらせる言葉' });
      if (!text) return;
      if (!bridge.send('say', { text })) vscode.window.showWarningMessage('マスコットに接続していません');
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('live2dMascot.enabled')) {
        if (cfg().get('enabled')) bridge.start(); else bridge.stop();
      } else if (e.affectsConfiguration('live2dMascot.bridgeFile')) {
        if (cfg().get('enabled')) bridge.reconnect();
      }
    })
  );

  if (cfg().get('enabled')) bridge.start();
  else status.hide();
}

function deactivate() {}

module.exports = { activate, deactivate };
