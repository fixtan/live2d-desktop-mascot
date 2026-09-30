// three/examples/jsm のうち VRM アダプタが使うファイルを src/renderer/vendor/three-addons/ にコピーする。
// electron-builder は node_modules/<パッケージ>/examples を必ず除外するため、node_modules から直接は読めない。
// npm install の後に自動で実行される（package.json の postinstall）。コピー先は .gitignore 済み
const fs = require('fs');
const path = require('path');

const FILES = [
  'loaders/GLTFLoader.js',
  'utils/BufferGeometryUtils.js',
  'utils/SkeletonUtils.js'
];

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules/three/examples/jsm');
const dest = path.join(root, 'src/renderer/vendor/three-addons');

for (const f of FILES) {
  fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
}
console.log(`[three-addons] ${FILES.length} ファイルをコピー → src/renderer/vendor/three-addons/`);
