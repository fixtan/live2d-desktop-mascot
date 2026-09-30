// ユーザーモデルのライブラリ管理（userData/models/<name>/）
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { formatOf, isModelFile, isSingleFileModel, modelFileLabel, importLabel } = require('../shared/formats');

// ZIP 内のファイル名の文字コード
// 日本語版 Windows のエクスプローラー等で作った ZIP は Shift_JIS で、UTF-8 の印（EFS フラグ）も無い。
// UTF-8 として厳密に読めなければ Shift_JIS とみなす。Mac で作った ZIP の NFD（濁点分離）は NFC にそろえる
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
let sjis = null;
try { sjis = new TextDecoder('shift_jis'); } catch { console.warn('[library] Shift_JIS デコーダーが使えません'); }

function decodeZipName(buf) {
  let name;
  try { name = utf8Strict.decode(buf); }
  catch { name = sjis ? sjis.decode(buf) : Buffer.from(buf).toString('latin1'); }
  return name.replace(/\\/g, '/').normalize('NFC');
}

const ZIP_DECODER = {
  efs: false,
  encode: (s) => Buffer.from(s, 'utf8'),
  decode: decodeZipName
};

function libraryDir() {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// "haru.model3.json" → "haru"（形式ごとの拡張子を外す）
function modelBaseName(p) {
  const base = path.basename(p);
  return base.replace(formatOf(base).file, '') || base;
}

// 重複しないフォルダ名を作る
function uniqueName(base) {
  const dir = libraryDir();
  const safe = base.replace(/[\\/:*?"<>|]/g, '_').trim() || 'model';
  let name = safe, i = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${safe}_${i++}`;
  return name;
}

// フォルダ内を再帰的に探して最初のモデルファイルを返す
function findModelFile(dir, depth = 0) {
  if (depth > 6) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const hit = entries.find((e) => e.isFile() && isModelFile(e.name));
  if (hit) return path.join(dir, hit.name);
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '__MACOSX') continue;
    const found = findModelFile(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

// ZIP: モデルファイルのあるフォルダ以下だけを展開
// ZIP を開く（日本語のファイル名に対応した decoder 付き）
function openZip(zipPath) {
  return new AdmZip(zipPath, { decoder: ZIP_DECODER });
}

const zipHasModel = (zip) => zip.getEntries().some((e) => !e.isDirectory && isModelFile(e.entryName));

function importZip(zipPath) {
  const zip = openZip(zipPath);
  const entries = zip.getEntries();
  const modelEntry = entries.find((e) => !e.isDirectory && isModelFile(e.entryName) && !e.entryName.startsWith('__MACOSX'));
  if (!modelEntry) throw new Error(`ZIPの中にモデルファイル（${modelFileLabel}）が見つかりません`);

  const prefix = modelEntry.entryName.includes('/')
    ? modelEntry.entryName.slice(0, modelEntry.entryName.lastIndexOf('/') + 1)
    : '';
  const name = uniqueName(modelBaseName(modelEntry.entryName));
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

// フォルダ: モデルファイルのあるフォルダ以下をコピー
function importFolder(folderPath) {
  const modelFile = findModelFile(folderPath);
  if (!modelFile) throw new Error(`フォルダの中にモデルファイル（${modelFileLabel}）が見つかりません`);
  const src = path.dirname(modelFile);
  const name = uniqueName(modelBaseName(modelFile));
  fs.cpSync(src, path.join(libraryDir(), name), { recursive: true });
  return name;
}

// 単体で完結するモデル（.vrm）: ファイル1個を models/<名前>/ にコピー
function importSingleFile(filePath) {
  const name = uniqueName(modelBaseName(filePath));
  const dir = path.join(libraryDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(filePath, path.join(dir, path.basename(filePath)));
  return name;
}

function importModel(p) {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) return importFolder(p);
  if (/\.zip$/i.test(p)) return importZip(p);
  if (isSingleFileModel(p)) return importSingleFile(p);
  throw new Error(`${importLabel} かフォルダを指定してください`);
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

module.exports = { libraryDir, importModel, listModels, removeModel, openZip, zipHasModel };
