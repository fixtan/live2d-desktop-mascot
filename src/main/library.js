// ユーザーモデルのライブラリ管理（userData/models/<name>/）
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const MODEL_EXT = /\.model3\.json$/i;

function libraryDir() {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 重複しないフォルダ名を作る
function uniqueName(base) {
  const dir = libraryDir();
  const safe = base.replace(/[\\/:*?"<>|]/g, '_').trim() || 'model';
  let name = safe, i = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${safe}_${i++}`;
  return name;
}

// フォルダ内を再帰的に探して最初の model3.json を返す
function findModelFile(dir, depth = 0) {
  if (depth > 6) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const hit = entries.find((e) => e.isFile() && MODEL_EXT.test(e.name));
  if (hit) return path.join(dir, hit.name);
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '__MACOSX') continue;
    const found = findModelFile(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

// ZIP: model3.json のあるフォルダ以下だけを展開
function importZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const modelEntry = entries.find((e) => !e.isDirectory && MODEL_EXT.test(e.entryName) && !e.entryName.startsWith('__MACOSX'));
  if (!modelEntry) throw new Error('ZIPの中に .model3.json が見つかりません');

  const prefix = modelEntry.entryName.includes('/')
    ? modelEntry.entryName.slice(0, modelEntry.entryName.lastIndexOf('/') + 1)
    : '';
  const name = uniqueName(path.basename(modelEntry.entryName).replace(MODEL_EXT, ''));
  const dest = path.join(libraryDir(), name);

  for (const e of entries) {
    if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
    const rel = e.entryName.slice(prefix.length);
    const out = path.resolve(dest, rel);
    if (!out.startsWith(dest + path.sep)) continue; // パストラバーサル対策
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, e.getData());
  }
  return name;
}

// フォルダ: model3.json のあるフォルダ以下をコピー
function importFolder(folderPath) {
  const modelFile = findModelFile(folderPath);
  if (!modelFile) throw new Error('フォルダの中に .model3.json が見つかりません');
  const src = path.dirname(modelFile);
  const name = uniqueName(path.basename(modelFile).replace(MODEL_EXT, ''));
  fs.cpSync(src, path.join(libraryDir(), name), { recursive: true });
  return name;
}

function importModel(p) {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) return importFolder(p);
  if (/\.zip$/i.test(p)) return importZip(p);
  throw new Error('ZIP かフォルダを指定してください');
}

// [{ id, path }]
function listModels() {
  const dir = libraryDir();
  const result = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = findModelFile(path.join(dir, e.name));
    if (file) result.push({ id: e.name, path: file });
  }
  return result;
}

function removeModel(name) {
  const dir = libraryDir();
  const target = path.resolve(dir, name);
  if (!target.startsWith(dir + path.sep)) throw new Error('invalid name');
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = { libraryDir, importModel, listModels, removeModel };
