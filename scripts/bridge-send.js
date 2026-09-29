#!/usr/bin/env node
// マスコットへイベントを送るテスト用クライアント（拡張ができるまでの動作確認用）
//
//   node scripts/bridge-send.js say テストだよ
//   node scripts/bridge-send.js diagnostics errors=0 errors=3 errors=0
//   node scripts/bridge-send.js taskEnd name=build,exitCode=1
//   node scripts/bridge-send.js debugStart
//
// payload は key=value をカンマ区切り（数値・true/false は変換）。JSON（{...}）もそのまま使える。
// say だけは、ただの文字列を text として扱う。
// payload を複数並べると、1本の接続で 1.5 秒おきに順に送る。
// bridge.json の場所は MASCOT_BRIDGE_FILE で上書きできる。
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const APP_DIR = 'Live2D Desktop Mascot'; // package.json の productName ＝ Electron の userData フォルダ名

function bridgeFile() {
  if (process.env.MASCOT_BRIDGE_FILE) return process.env.MASCOT_BRIDGE_FILE;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_DIR, 'bridge.json');
    case 'darwin': return path.join(home, 'Library', 'Application Support', APP_DIR, 'bridge.json');
    default: return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_DIR, 'bridge.json');
  }
}

const [type, ...args] = process.argv.slice(2);
if (!type) {
  console.error('usage: bridge-send.js <type> [key=value,... | JSON | text(say)] ...');
  process.exit(2);
}

function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function parsePayload(arg) {
  if (arg.trim().startsWith('{')) return JSON.parse(arg);
  if (type === 'say' && !/^text=/.test(arg)) return { text: arg };
  const out = {};
  for (const pair of arg.split(',')) {
    const i = pair.indexOf('=');
    if (i < 1) throw new Error(`key=value の形になっていません: ${pair}`);
    out[pair.slice(0, i).trim()] = parseValue(pair.slice(i + 1).trim());
  }
  return out;
}

// 接続前に全部パースしておく（途中で落ちないように）
let payloads;
try {
  payloads = args.length ? args.map(parsePayload) : [{}];
} catch (e) {
  console.error('payload を読めません:', e.message);
  process.exit(2);
}

let info;
try {
  info = JSON.parse(fs.readFileSync(bridgeFile(), 'utf8'));
} catch (e) {
  console.error('bridge.json を読めません（マスコットが起動していない？）:', bridgeFile());
  process.exit(1);
}

const ws = new WebSocket(`ws://${info.host}:${info.port}/?token=${encodeURIComponent(info.token)}`);
ws.on('error', (e) => { console.error('接続失敗:', e.message); process.exit(1); });
ws.on('unexpected-response', (req, res) => { console.error('拒否されました:', res.statusCode); process.exit(1); });

ws.on('message', async (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type !== 'welcome') return;
  console.log('welcome:', msg.payload);
  for (let i = 0; i < payloads.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500));
    const payload = payloads[i];
    ws.send(JSON.stringify({ v: 1, type, payload, ts: Date.now() }));
    console.log('sent:', type, payload);
  }
  setTimeout(() => ws.close(), 300);
});
