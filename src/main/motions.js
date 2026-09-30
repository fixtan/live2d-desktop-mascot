// VRM 用モーション（VRMA）の置き場所 userData/motions/。全モデル共通。
// どのファイルが何に使われるか（待機・しぐさ）は renderer 側の shared/motions.js が名前で決める
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { isMotionFile } = require('../shared/motions');

function motionsDir() {
  const dir = path.join(app.getPath('userData'), 'motions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// [{ name: 'idle2', path }]（名前順）
function listMotions() {
  const dir = motionsDir();
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && isMotionFile(e.name))
    .map((e) => ({ name: e.name.replace(/\.vrma$/i, ''), path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

// 同じ名前のファイルは上書き（モーションパックの入れ替え）
function importFiles(paths) {
  const dir = motionsDir();
  let n = 0;
  for (const p of paths) {
    if (!isMotionFile(p)) continue;
    fs.copyFileSync(p, path.join(dir, path.basename(p)));
    n++;
  }
  return n;
}

// ZIP 内の .vrma をフォルダ構成を無視して展開（上書き）
function importZip(zip) {
  const dir = motionsDir();
  let n = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory || e.entryName.startsWith('__MACOSX') || !isMotionFile(e.entryName)) continue;
    const name = path.basename(e.entryName);
    fs.writeFileSync(path.join(dir, name), e.getData());
    n++;
  }
  return n;
}

module.exports = { motionsDir, listMotions, importFiles, importZip };
