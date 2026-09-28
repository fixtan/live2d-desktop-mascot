// Live2D（Cubism 3/4）用アダプタ。
// 将来のVRMアダプタも同じメソッドを持たせる：
//   load(url) / setHeight(px) / getSize() / setPosition(x, y) / getBounds()
//   focus(x, y) / resetFocus() / listMotions() / playMotion(m) / setExpression(name)
//   setMouth(level) / setModelSound(on) / hitTest(x, y) / dispose()

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
    this.naturalW = 1;
    this.naturalH = 1;
    this.mouth = null; // null = モーションに任せる
    this._px = new Uint8Array(4);
    this._onBeforeUpdate = () => this._applyMouth();
  }

  // 読み込みに成功した時だけ差し替える（失敗時は今のモデルが残る）
  async load(url) {
    const model = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false });

    if (this.model) {
      this.app.stage.removeChild(this.model);
      this.model.destroy();
    }

    this.model = model;
    model.anchor.set(0.5, 0.5);
    model.scale.set(1);
    this.naturalW = model.width;
    this.naturalH = model.height;
    this.app.stage.addChild(model);
    model.internalModel.on('beforeModelUpdate', this._onBeforeUpdate);
    this._ensureIdleGroup();
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

  // 表示高さ(px)を指定してスケールを決める（モデルごとの元サイズ差を吸収）
  setHeight(px) {
    if (!this.model) return;
    this.model.scale.set(px / this.naturalH);
  }

  getSize() {
    if (!this.model) return { width: 0, height: 0 };
    return { width: this.model.width, height: this.model.height };
  }

  setPosition(x, y) {
    if (!this.model) return;
    this.model.x = x;
    this.model.y = y;
  }

  getBounds() {
    if (!this.model) return null;
    const b = this.model.getBounds();
    return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
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
