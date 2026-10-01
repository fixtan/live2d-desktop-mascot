// モデルのサムネイル（設定ウィンドウの一覧用）
// 優先順：モデルのフォルダの thumb.png / .jpg / .jpeg / .webp → VRM の埋め込み → null（設定ウィンドウが頭文字を出す）
//   埋め込みは 0.x が meta.texture → textures[].source、1.0 が meta.thumbnailImage
//   thumb.* は設定ウィンドウでタイルに画像をドロップすると入る（ライブラリのモデルだけ）
// VRM は数十 MB あるので全体は読まず、ヘッダ・JSON チャンク・サムネの部分だけを読む
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

const SIZE = 192;           // 一覧に出す大きさ（px、長い辺）
const cache = new Map();    // path → { key, url }
const THUMB_RE = /^thumb\.(png|jpe?g|webp)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

// モデルのフォルダにある thumb.*（無ければ null）
function customThumb(dir) {
  try {
    const f = fs.readdirSync(dir).find((n) => THUMB_RE.test(n));
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}

// 縮めて data URL に。nativeImage が読めない形式（webp など）はそのまま
function toUrl(bytes, ext) {
  const img = nativeImage.createFromBuffer(bytes);
  if (!img.isEmpty()) {
    const { width, height } = img.getSize();
    const small = width >= height ? img.resize({ width: Math.min(SIZE, width) }) : img.resize({ height: Math.min(SIZE, height) });
    return small.toDataURL();
  }
  const mime = MIME[ext];
  if (mime && bytes.length < 4 * 1024 * 1024) return `data:${mime};base64,${bytes.toString('base64')}`;
  return null;
}

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, offset);
  return buf;
}

// 埋め込みサムネのバイト列。無ければ null
function vrmThumbnailBytes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = readAt(fd, 0, 20);
    if (head.readUInt32LE(0) !== 0x46546c67) return null;  // 'glTF'
    const jsonLength = head.readUInt32LE(12);
    if (head.readUInt32LE(16) !== 0x4e4f534a) return null; // 'JSON'
    const json = JSON.parse(readAt(fd, 20, jsonLength).toString('utf8'));

    const vrm0 = json.extensions?.VRM?.meta;
    const vrm1 = json.extensions?.VRMC_vrm?.meta;
    let imageIndex = null;
    if (vrm0?.texture != null && vrm0.texture >= 0) imageIndex = json.textures?.[vrm0.texture]?.source;
    else if (vrm1?.thumbnailImage != null) imageIndex = vrm1.thumbnailImage;
    if (imageIndex == null) return null;

    const image = json.images?.[imageIndex];
    const bv = image?.bufferView != null ? json.bufferViews?.[image.bufferView] : null;
    if (!bv || bv.buffer !== 0 && bv.buffer != null) return null;
    const binStart = 20 + jsonLength + 8; // BIN チャンクのヘッダ（8バイト）の後
    return readAt(fd, binStart + (bv.byteOffset || 0), bv.byteLength);
  } finally {
    fs.closeSync(fd);
  }
}

// 小さくした data URL。サムネが無い・読めない時は null
// dir：thumb.* を探すフォルダ（ライブラリのモデルはそのモデルのフォルダ）
function thumbnailUrl(file, dir = path.dirname(file)) {
  try {
    const custom = customThumb(dir);
    const key = [fs.statSync(file).mtimeMs, custom, custom && fs.statSync(custom).mtimeMs].join('|');
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.url;
    let url = null;
    if (custom) url = toUrl(fs.readFileSync(custom), path.extname(custom).slice(1).toLowerCase());
    if (!url && /\.vrm$/i.test(file)) {
      const bytes = vrmThumbnailBytes(file);
      if (bytes) url = toUrl(bytes, 'png');
    }
    cache.set(file, { key, url });
    return url;
  } catch (e) {
    console.warn('[thumbs] 読めません:', file, e.message);
    return null;
  }
}

// thumb.* を入れ替える（前のものは消す）
function setCustomThumb(dir, image) {
  const ext = path.extname(image).slice(1).toLowerCase();
  if (!MIME[ext]) throw new Error('PNG・JPEG・WebP の画像にしてね');
  for (const n of fs.readdirSync(dir)) if (THUMB_RE.test(n)) fs.rmSync(path.join(dir, n), { force: true });
  fs.copyFileSync(image, path.join(dir, 'thumb.' + (ext === 'jpeg' ? 'jpg' : ext)));
}

module.exports = { thumbnailUrl, customThumb, setCustomThumb };
