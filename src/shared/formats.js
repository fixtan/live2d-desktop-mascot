// 対応しているモデル形式の一覧。形式を増やすときはここに1件足し、adapters/ にアダプタを置く。
// main（ライブラリ・ダイアログ）と renderer（同梱モデル・ドロップ・アダプタの選択）の両方から使う
const FORMATS = [
  {
    id: 'live2d',
    name: 'Live2D (Cubism 3/4)',
    file: /\.model3\.json$/i,     // モデルの入口になるファイル
    label: '.model3.json',        // メッセージ表示用
    singleFile: false,            // true = ファイル1個で完結（単体で取り込める）。false = 同じフォルダの他のファイルも要る
    dialogExtensions: ['json'],   // ファイル選択ダイアログのフィルタ
    adapter: 'Live2DAdapter'      // renderer の window に置かれるアダプタのクラス名
  },
  {
    id: 'vrm',
    name: 'VRM (0.x / 1.0)',
    file: /\.vrm$/i,
    label: '.vrm',
    singleFile: true,
    dialogExtensions: ['vrm'],
    adapter: 'VRMAdapter',
    module: './adapters/vrm.js'   // ES モジュール。必要になった時に app.js が import() する（app.js からの相対）
  }
];

function formatOf(p) {
  return FORMATS.find((f) => f.file.test(p)) || null;
}

const isModelFile = (p) => !!formatOf(p);

// 単体で取り込めるモデルファイルか（.vrm など）
const isSingleFileModel = (p) => !!formatOf(p)?.singleFile;

// 取り込みダイアログで選べる拡張子（ZIP ＋ 単体で完結する形式）
const importExtensions = ['zip', ...FORMATS.filter((f) => f.singleFile).flatMap((f) => f.dialogExtensions)];
const importLabel = ['ZIP', ...FORMATS.filter((f) => f.singleFile).map((f) => f.label)].join(' / ');

// 「.model3.json / .vrm」のような表示用の文字列
const modelFileLabel = FORMATS.map((f) => f.label).join(' / ');

module.exports = { FORMATS, formatOf, isModelFile, isSingleFileModel, modelFileLabel, importExtensions, importLabel };
