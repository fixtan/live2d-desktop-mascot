// VS Codeウィンドウ位置の追跡。OSごとの実装を切り替える。
// 実装は start(onRect) を持ち、{ stop() } を返す。
// onRect(rect | null) — rect は物理ピクセルの {x, y, width, height}、取れない時は null。

function createTracker() {
  switch (process.platform) {
    case 'win32':
      return require('./win32');
    // case 'darwin': return require('./darwin');  // TODO
    default:
      return { start: () => ({ stop() {} }), supported: false };
  }
}

module.exports = createTracker();
