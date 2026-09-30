// モーション（VRMA）のファイルと役割の決まり。
// 役割の決め方はここだけ。将来「役割ごとに個別に選ぶ」方式にする時もここを差し替える
const MOTION_FILE = /\.vrma$/i;

const isMotionFile = (p) => MOTION_FILE.test(p);
const isIdle = (name) => /^idle/i.test(name);

// files: [{ name, ... }] → { idle: [...], gestures: [...] }
// 名前が idle で始まるもの（idle, idle2, idle_sit …）は待機。1回流し終わるたびにランダムに切り替わる
// それ以外はしぐさ（クリック・ランダムイベント・ボイスパックの motion との部分一致）
function motionRoles(files) {
  const idle = [], gestures = [];
  for (const f of files) (isIdle(f.name) ? idle : gestures).push(f);
  return { idle, gestures };
}

// ユーザーの motions/ と同梱（assets/motions/）を合わせる。
// 待機：ユーザーに1本でもあればユーザーの分だけ、無ければ同梱の分（自分の待機を入れたら切り替わる）
// しぐさ：両方。同じ名前はユーザー側を優先
function mergeMotions(user, bundled) {
  const userHasIdle = user.some((f) => isIdle(f.name));
  const names = new Set(user.map((f) => f.name.toLowerCase()));
  const extra = bundled.filter((f) => !names.has(f.name.toLowerCase()) && (!isIdle(f.name) || !userHasIdle));
  return [...user, ...extra];
}

module.exports = { isMotionFile, motionRoles, mergeMotions };
