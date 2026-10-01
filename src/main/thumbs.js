// モデルのサムネイル（設定ウィンドウの一覧用）
// VRM に埋め込まれたサムネだけを使う（0.x は meta.texture → textures[].source、1.0 は meta.thumbnailImage）。
// 無いモデル（Live2D・サムネ無しの VRM）は null（設定ウィンドウが頭文字で代わりを出す）
// VRM は数十 MB あるので全体は読まず、ヘッダ・JSON チャンク・サムネの部分だけを読む
const fs = require('fs');
const { nativeImage } = require('electron');

const SIZE = 192;           // 一覧に出す大きさ（px、長い辺）
const cache = new Map();    // path → { mtime, url }

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
function thumbnailUrl(file) {
  try {
    if (!/\.vrm$/i.test(file)) return null;
    const mtime = fs.statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.url;
    let url = null;
    const bytes = vrmThumbnailBytes(file);
    if (bytes) {
      const img = nativeImage.createFromBuffer(bytes); // PNG・JPEG
      if (!img.isEmpty()) {
        const { width, height } = img.getSize();
        const small = width >= height ? img.resize({ width: Math.min(SIZE, width) }) : img.resize({ height: Math.min(SIZE, height) });
        url = small.toDataURL();
      }
    }
    cache.set(file, { mtime, url });
    return url;
  } catch (e) {
    console.warn('[thumbs] 読めません:', file, e.message);
    return null;
  }
}

module.exports = { thumbnailUrl };
