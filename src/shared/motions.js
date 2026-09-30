// モーション（VRMA）のファイルと役割の決まり。
// 役割の決め方はここだけ。将来「役割ごとに個別に選ぶ」方式にする時もここを差し替える
const MOTION_FILE = /\.vrma$/i;

const isMotionFile = (p) => MOTION_FILE.test(p);

// files: [{ name, ... }] → { idle: [...], gestures: [...] }
// 名前が idle で始まるもの（idle, idle2, idle_sit …）は待機。1回流し終わるたびにランダムに切り替わる
// それ以外はしぐさ（クリック・ランダムイベント・ボイスパックの motion との部分一致）
function motionRoles(files) {
  const idle = [], gestures = [];
  for (const f of files) (/^idle/i.test(f.name) ? idle : gestures).push(f);
  return { idle, gestures };
}

module.exports = { isMotionFile, motionRoles };
