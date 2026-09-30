// userData/characters.json — 表示するキャラの一覧と、キャラごとの設定・位置（メインプロセスが持つ）
//   { version: 1, characters: [{ id: 'c1', settings: {...} | null, anchor: { x, bottom } | null }] }
// 先頭のキャラが代表（VS Code のイベント・時報に反応する）
// settings の中身はマスコット側（app.js）の DEFAULTS が決める。ここは形を見ずに預かるだけ
// anchor は窓の下端中央（窓の大きさはモデルで変わるので、足元の位置で覚える）
const fs = require('fs');
const path = require('path');

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function createStore(dir) {
  const file = path.join(dir, 'characters.json');
  let list = [];
  let fresh = false; // ファイルが無かった（初回。c1 は localStorage の設定を引き継ぐ）
  let saveTimer = null;

  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    list = (Array.isArray(data.characters) ? data.characters : [])
      .filter((c) => isObj(c) && typeof c.id === 'string' && c.id)
      .map((c) => ({
        id: c.id,
        settings: isObj(c.settings) ? c.settings : null,
        anchor: isObj(c.anchor) && Number.isFinite(c.anchor.x) && Number.isFinite(c.anchor.bottom) ? c.anchor : null
      }));
  } catch (e) {
    if (e.code === 'ENOENT') fresh = true;
    else console.warn('[characters] characters.json を読めません。1体で起動します:', e.message);
  }
  if (!list.length) list = [{ id: 'c1', settings: null, anchor: null }];

  function writeNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, characters: list }, null, 2) + '\n');
    } catch (e) {
      console.warn('[characters] characters.json を書けません:', e.message);
    }
  }
  // スライダー操作やドラッグで何度も来るのでまとめて書く
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(writeNow, 500); };

  const find = (id) => list.find((c) => c.id === id);

  function nextId() {
    let n = 1;
    while (find('c' + n)) n++;
    return 'c' + n;
  }

  return {
    list: () => list.map((c) => c.id),
    primary: () => list[0].id,
    get: (id) => find(id) || null,
    // 引き継ぎは最初の起動の c1 だけ
    shouldMigrate: (id) => fresh && id === list[0].id && !find(id).settings,
    add() {
      const c = { id: nextId(), settings: null, anchor: null };
      list.push(c);
      writeNow();
      return c.id;
    },
    remove(id) {
      if (list.length <= 1) return false;
      const i = list.findIndex((c) => c.id === id);
      if (i < 0) return false;
      list.splice(i, 1);
      writeNow();
      return true;
    },
    setSettings(id, settings) {
      const c = find(id);
      if (!c || !isObj(settings)) return;
      c.settings = settings;
      save();
    },
    setAnchor(id, anchor) {
      const c = find(id);
      if (!c) return;
      c.anchor = anchor;
      save();
    },
    flush: () => { if (saveTimer) writeNow(); }
  };
}

module.exports = { createStore };
