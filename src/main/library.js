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

// 取り込み先のフォルダ名。同じ名前があれば上書きする（間違えて何度もドロップしても増えないように）
function targetName(base) {
  const dir = libraryDir();
  const name = base.replace(/[\\/:*?"<>|]/g, '_').trim() || 'model';
  const dest = path.resolve(dir, name);
  if (!dest.startsWith(dir + path.sep)) throw new Error('invalid name');
  fs.rmSync(dest, { recursive: true, force: true });
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
  const name = targetName(modelBaseName(modelEntry.entryName));
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
  const name = targetName(modelBaseName(modelFile));
  fs.cpSync(src, path.join(libraryDir(), name), { recursive: true });
  return name;
}

// 単体で完結するモデル（.vrm）: ファイル1個を models/<名前>/ にコピー
function importSingleFile(filePath) {
  const name = targetName(modelBaseName(filePath));
  const dir = path.join(libraryDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(filePath, path.join(dir, path.basename(filePath)));
  return name;
}

const THUMB_RE = /^thumb\.(png|jpe?g|webp)$/i;

function importModel(p) {
  // ライブラリの中のものを取り込み直すと、上書きの前に自分を消してしまう
  if (path.resolve(p).startsWith(libraryDir() + path.sep)) throw new Error('ライブラリに入っているモデルです。設定のモデル一覧から選んでね');
  const stat = fs.statSync(p);
  let name;
  if (stat.isDirectory()) name = keepingThumbs(() => importFolder(p));
  else if (/\.zip$/i.test(p)) name = keepingThumbs(() => importZip(p));
  else if (isSingleFileModel(p)) name = keepingThumbs(() => importSingleFile(p));
  else throw new Error(`${importLabel} かフォルダを指定してください`);
  return name;
}

// 同じ名前で取り込み直してもサムネ（thumb.*）は残す。取り込んだ物に thumb.* があればそちらを使う
function keepingThumbs(doImport) {
  const dir = libraryDir();
  const saved = new Map(); // フォルダ名 → [{ name, data }]
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const files = fs.readdirSync(path.join(dir, e.name)).filter((n) => THUMB_RE.test(n));
    if (files.length) saved.set(e.name, files.map((n) => ({ name: n, data: fs.readFileSync(path.join(dir, e.name, n)) })));
  }
  const name = doImport();
  const kept = saved.get(name);
  const dest = path.join(dir, name);
  if (kept && !fs.readdirSync(dest).some((n) => THUMB_RE.test(n))) {
    for (const t of kept) fs.writeFileSync(path.join(dest, t.name), t.data);
  }
  return name;
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

// ライブラリのモデルなら、そのモデルのフォルダ（models/<名前>/）。違えば null
function modelFolderOf(file) {
  const dir = libraryDir();
  const rel = path.relative(dir, path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return path.join(dir, rel.split(path.sep)[0]);
}

module.exports = { libraryDir, modelFolderOf, importModel, listModels, removeModel, openZip, zipHasModel };
