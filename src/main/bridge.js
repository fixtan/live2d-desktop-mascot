// VS Code拡張などから WebSocket でイベントを受け取る（Electron に依存しない）
//
// - 127.0.0.1 にだけバインドする
// - Origin ヘッダー付き（＝ブラウザ）の接続は拒否する
// - 接続先は userData/bridge.json に書き出す（起動ごとに更新、終了時に削除）
//   { v, app, version, host, port, token, pid, startedAt }
// - 接続URL：ws://127.0.0.1:<port>/?token=<token>
// - メッセージ：{ v: 1, type: string, payload?: object, ts?: number }（JSON テキスト）
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PROTOCOL = 1;
const HOST = '127.0.0.1';
const MAX_PAYLOAD = 64 * 1024;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {object} opt
 * @param {string} opt.dir        bridge.json を置くフォルダ（userData）
 * @param {number} [opt.port=0]   希望ポート。使用中なら自動に切り替える
 * @param {string} opt.version    アプリのバージョン
 * @param {(msg: {type: string, payload: object, ts: number, client: number}) => void} opt.onEvent
 *   接続・切断は type 'connect' / 'disconnect' として届く
 */
async function startBridge({ dir, port = 0, version, onEvent }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const file = path.join(dir, 'bridge.json');

  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('WebSocket only\n');
  });

  let actualPort;
  try {
    actualPort = await listen(server, port);
  } catch (e) {
    if (e.code !== 'EADDRINUSE' || port === 0) throw e;
    console.warn(`[bridge] ポート ${port} は使用中。自動で空きポートを使います`);
    actualPort = await listen(server, 0);
  }

  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_PAYLOAD,
    verifyClient: (info, cb) => {
      if (info.origin) return cb(false, 403, 'Forbidden'); // ブラウザからの接続
      const t = new URL(info.req.url, 'http://x').searchParams.get('token');
      if (!t || !safeEqual(t, token)) return cb(false, 401, 'Unauthorized');
      cb(true);
    }
  });

  // 接続ごとに番号を振る（VS Code はウィンドウごとに拡張ホストが立つので複数つながる）
  let seq = 0;
  const emit = (msg) => {
    try { onEvent(msg); } catch (e) { console.warn('[bridge] イベント処理エラー:', e); }
  };

  wss.on('connection', (ws) => {
    const client = ++seq;
    console.log(`[bridge] 接続 #${client}（${wss.clients.size}）`);
    emit({ type: 'connect', payload: {}, ts: Date.now(), client });
    ws.send(JSON.stringify({
      v: PROTOCOL,
      type: 'welcome',
      payload: { app: 'live2d-desktop-mascot', version, protocol: PROTOCOL },
      ts: Date.now()
    }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || msg.v !== PROTOCOL || typeof msg.type !== 'string') return;
      if (msg.type === 'ping') { ws.send(JSON.stringify({ v: PROTOCOL, type: 'pong', ts: Date.now() })); return; }
      if (msg.type === 'connect' || msg.type === 'disconnect') return; // 予約済み
      const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
      emit({ type: msg.type, payload, ts: Number(msg.ts) || Date.now(), client });
    });

    ws.on('close', () => {
      console.log(`[bridge] 切断 #${client}（${wss.clients.size}）`);
      emit({ type: 'disconnect', payload: {}, ts: Date.now(), client });
    });
    ws.on('error', () => {}); // 相手の異常終了など。close が続くのでここでは何もしない
  });

  const info = {
    v: PROTOCOL,
    app: 'live2d-desktop-mascot',
    version,
    host: HOST,
    port: actualPort,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString()
  };
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(file, JSON.stringify(info, null, 2) + '\n');
  console.log(`[bridge] ws://${HOST}:${actualPort} で待機（${file}）`);

  let stopped = false;
  return {
    info,
    file,
    clientCount: () => wss.clients.size,
    // before-quit から同期的に呼べるよう、ファイル削除は同期で行う
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cur.token === token) fs.unlinkSync(file);
      } catch {}
      for (const c of wss.clients) c.terminate();
      wss.close();
      server.close();
    }
  };
}

module.exports = { startBridge, PROTOCOL };
