// userData/config.json — ユーザーが手で編集する設定（メインプロセス側）
// 無いキーは既定値で補い、足りなければファイルに書き戻す（新しい設定が増えても見える場所に出る）
// 壊れたJSONは上書きせず、既定値で起動する
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  configVersion: 1,
  bridge: {
    enabled: true, // VS Code拡張などからのWebSocket接続を受け付ける
    port: 0        // 0 = 空いているポートを自動で使う。固定したい時だけ番号を書く
  }
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// 既定値に user の値を重ねる（型が違う値は捨てる）
function merge(def, user) {
  const out = {};
  for (const [k, d] of Object.entries(def)) {
    const u = user?.[k];
    if (isObj(d)) out[k] = merge(d, isObj(u) ? u : {});
    else out[k] = typeof u === typeof d ? u : d;
  }
  // 知らないキーも残す（新しい版で追加された設定を古い版が消さないように）
  for (const [k, u] of Object.entries(user || {})) if (!(k in def)) out[k] = u;
  return out;
}

function loadConfig(dir) {
  const file = path.join(dir, 'config.json');
  let user = {};
  let broken = false;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      broken = true;
      console.warn('[config] config.json を読めません。既定値で起動します:', e.message);
    }
  }
  const config = merge(DEFAULTS, user);
  if (!broken && JSON.stringify(config) !== JSON.stringify(user)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    } catch (e) {
      console.warn('[config] config.json を書けません:', e.message);
    }
  }
  return { config, file };
}

module.exports = { loadConfig, DEFAULTS };
