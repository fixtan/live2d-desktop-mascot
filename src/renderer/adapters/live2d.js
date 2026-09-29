// Live2D（Cubism 3/4）用アダプタ。
// 将来のVRMアダプタも同じメソッドを持たせる：
//   load(url) / setHeight(px) / getSize() / setPosition(x, y) / getBounds()
//   focus(x, y) / resetFocus() / listMotions() / playMotion(m) / setExpression(name)
//   setMouth(level) / setModelSound(on) / hitTest(x, y) / dispose()

// file:// でも読めるよう XHR で取得（fetch は file: を扱えない）
function xhrGet(url, responseType) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = responseType;
    x.onload = () => ((x.status === 0 || x.status < 400) && x.response
      ? resolve(x.response)
      : reject(new Error(`読み込めません（${x.status}）: ${url}`)));
    x.onerror = () => reject(new Error('読み込めません: ' + url));
    x.send();
  });
}

class Live2DAdapter {
  constructor(canvas) {
    this.app = new PIXI.Application({
      view: canvas,
      backgroundAlpha: 0,
      autoStart: true,
      resizeTo: window,
      antialias: true,
      preserveDrawingBuffer: true // ヒット判定でreadPixelsするため
    });
    this.model = null;
    // キャラが実際に描かれている範囲（モデル内部座標）。キャンバスの余白を含まない
    this.box = { left: 0, top: 0, right: 1, bottom: 1 };
    this.mouth = null; // null = モーションに任せる
    this._px = new Uint8Array(4);
    this._onBeforeUpdate = () => this._applyMouth();
  }

  // 読み込みに成功した時だけ差し替える（失敗時は今のモデルが残る）
  async load(url) {
    await Live2DAdapter.checkMocVersion(url);
    const model = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false });

    if (this.model) {
      this.app.stage.removeChild(this.model);
      this.model.destroy();
    }

    this.model = model;
    model.anchor.set(0, 0);
    model.scale.set(1);
    this.box = this._measureContent(model);
    this.app.stage.addChild(model);
    model.internalModel.on('beforeModelUpdate', this._onBeforeUpdate);
    this._ensureIdleGroup();
  }

  // moc3 の形式バージョンが Cubism Core の対応範囲か確かめる。
  // ヘッダーは "MOC3" の次の 1 バイトがバージョン（Cubism 5.3 で書き出すと 6）。
  // 対応外だと Core が "Unknown error" で落ちるだけなので、先に分かる形で止める
  static async checkMocVersion(settingsUrl) {
    const json = await xhrGet(settingsUrl, 'json');
    const moc = json?.FileReferences?.Moc;
    if (!moc) return;
    const bytes = new Uint8Array(await xhrGet(new URL(moc, settingsUrl).href, 'arraybuffer'), 0, 5);
    if (String.fromCharCode(...bytes.slice(0, 4)) !== 'MOC3') return; // 判定できない時は Core に任せる
    const version = bytes[4];
    const latest = window.Live2DCubismCore?.Version?.csmGetLatestMocVersion?.() ?? 5;
    if (version > latest) {
      const err = new Error(`moc3 ver ${version} には未対応です（このアプリは ver ${latest} まで）`);
      err.code = 'UNSUPPORTED_MOC';
      err.mocVersion = version;
      throw err;
    }
  }

  // "Idle" グループが無いモデル（受付版ハルなど）は、ファイル名に idle を含む
  // モーションを Idle グループとして登録し、待機中に自動再生させる
  _ensureIdleGroup() {
    const mm = this.model.internalModel.motionManager;
    const idleName = mm.groups.idle;
    if (mm.definitions[idleName]?.length) return;
    const idleDefs = [];
    for (const group of Object.keys(mm.definitions)) {
      for (const def of mm.definitions[group] || []) {
        if (/idle/i.test(def.File || def.file || '')) idleDefs.push(def);
      }
    }
    if (!idleDefs.length) return;
    mm.definitions[idleName] = idleDefs;
    mm.motionGroups[idleName] = [];
  }

  // 描かれている範囲を頂点から測る。
  // model.width / getBounds() はキャンバス全体の大きさで、上や左右に余白の多いモデルだと
  // キャラが小さく表示され、吹き出しが頭から離れる。
  // 非表示・透明のパーツ（差分用の腕など）は除く。モーションで少しはみ出す分の余裕を足す
  _measureContent(model) {
    const im = model.internalModel;
    const fallback = { left: 0, top: 0, right: im.width, bottom: im.height };
    try {
      const core = im.coreModel;
      im.pose?.updateParameters(core, 0); // pose3.json の差分パーツ（腕の切り替え等）を片方だけ表示に
      core.update(); // 初期ポーズで頂点を計算させる
      const lt = im.localTransform;
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      const n = core.getDrawableCount();
      for (let i = 0; i < n; i++) {
        if (core.getDrawableOpacity(i) < 0.01) continue;
        if (core.getDrawableDynamicFlagIsVisible && !core.getDrawableDynamicFlagIsVisible(i)) continue;
        const v = im.getDrawableVertices(i); // キャンバス座標（px）
        for (let k = 0; k < v.length; k += 2) {
          const x = lt.a * v[k] + lt.c * v[k + 1] + lt.tx;
          const y = lt.b * v[k] + lt.d * v[k + 1] + lt.ty;
          if (x < l) l = x; if (x > r) r = x;
          if (y < t) t = y; if (y > b) b = y;
        }
      }
      if (!(r > l && b > t)) return fallback;
      const mx = (r - l) * 0.04, my = (b - t) * 0.02;
      return {
        left: Math.max(0, l - mx), top: Math.max(0, t - my),
        right: Math.min(im.width, r + mx), bottom: Math.min(im.height, b + my)
      };
    } catch (e) {
      console.warn('描画範囲を測れません。キャンバス全体を使います:', e);
      return fallback;
    }
  }

  // 表示高さ(px)を指定してスケールを決める（キャラの描画範囲の高さ）
  setHeight(px) {
    if (!this.model) return;
    this.model.scale.set(px / (this.box.bottom - this.box.top));
  }

  getSize() {
    if (!this.model) return { width: 0, height: 0 };
    const s = this.model.scale.x;
    return { width: (this.box.right - this.box.left) * s, height: (this.box.bottom - this.box.top) * s };
  }

  // キャラの描画範囲の中心を (x, y) に置く
  setPosition(x, y) {
    if (!this.model) return;
    const s = this.model.scale.x;
    this.model.x = x - ((this.box.left + this.box.right) / 2) * s;
    this.model.y = y - ((this.box.top + this.box.bottom) / 2) * s;
  }

  // キャラの描画範囲（ウィンドウ内の座標）
  getBounds() {
    if (!this.model) return null;
    const s = this.model.scale.x, m = this.model;
    return {
      left: m.x + this.box.left * s, top: m.y + this.box.top * s,
      right: m.x + this.box.right * s, bottom: m.y + this.box.bottom * s
    };
  }

  focus(x, y) {
    if (this.model) this.model.focus(x, y);
  }

  resetFocus() {
    if (this.model) this.model.internalModel.focusController.focus(0, 0);
  }

  // 待機以外のモーション一覧 [{ group, index, file, sound }]
  listMotions() {
    const defs = this.model?.internalModel?.motionManager?.definitions || {};
    const list = [];
    for (const group of Object.keys(defs)) {
      if (/idle/i.test(group)) continue;
      (defs[group] || []).forEach((def, index) => {
        const file = def.File || def.file || '';
        if (/idle/i.test(file)) return;
        list.push({ group, index, file, sound: def.Sound || def.sound || null });
      });
    }
    return list;
  }

  playMotion(m) {
    if (!this.model || !m) return;
    this.model.motion(m.group, m.index, PIXI.live2d.MotionPriority.FORCE);
  }

  setExpression(name) {
    if (this.model) this.model.expression(name);
  }

  // 口パク 0〜1（nullでモーションに任せる）
  setMouth(level) {
    this.mouth = level;
  }

  _applyMouth() {
    if (this.mouth == null || !this.model) return;
    const im = this.model.internalModel;
    for (const id of im.lipSyncIds || []) {
      im.coreModel.setParameterValueById(id, this.mouth);
    }
  }

  // モーション付属の音声（model3.jsonのSound）
  setModelSound(on) {
    PIXI.live2d.config.sound = !!on;
  }

  // 不透明ピクセルの上か
  hitTest(x, y) {
    if (!this.model) return false;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    const r = this.app.renderer.resolution;
    const gl = this.app.renderer.gl;
    this.app.renderer.renderTexture.bind(null);
    gl.readPixels(Math.floor(x * r), Math.floor(this.app.view.height - 1 - y * r), 1, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, this._px);
    return this._px[3] > 16;
  }

  dispose() {
    if (this.model) this.model.destroy();
    this.model = null;
    this.app.destroy(false, { children: true });
  }
}

window.Live2DAdapter = Live2DAdapter;
