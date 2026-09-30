// VRM（0.x / 1.0）用アダプタ。three.js + @pixiv/three-vrm。
// メソッドは Live2DAdapter と同じ（app.js の NO_MODEL を参照）。
// ES モジュールなので app.js が必要になった時に import() で読み込む（Live2D だけの人は three を読まない）。
//
// 座標：モデルはメートル単位のまま動かさず、正射影カメラの範囲で大きさを決める
// （モデルを拡大すると揺れもの・コライダーの物理が狂うため）。
// ワールド座標 × this.ppm = ウィンドウの px。y はウィンドウ座標と逆向き（上が +）。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// file:// でも読めるよう XHR で取得（fetch は file: を扱えない）
function xhrGet(url) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () => ((x.status === 0 || x.status < 400) && x.response
      ? resolve(x.response)
      : reject(new Error(`読み込めません（${x.status}）: ${url}`)));
    x.onerror = () => reject(new Error('読み込めません: ' + url));
    x.send();
  });
}

// 手を下ろした立ち姿（正規化ボーン。VRM 0.x も rotateVRM0 後は同じ向き）
const REST_POSE = {
  leftUpperArm: [0, 0, -1.3],
  rightUpperArm: [0, 0, 1.3],
  leftLowerArm: [0, -0.15, 0],
  rightLowerArm: [0, 0.15, 0]
};

// 手続きで作るしぐさ（VRMA 対応までのつなぎ）。file はボイスパックの motion との部分一致に使う
const GESTURES = [
  { file: 'nod', expression: 'happy', duration: 1.2 },
  { file: 'tilt', expression: 'relaxed', duration: 1.6 },
  { file: 'surprised', expression: 'surprised', duration: 1.2 },
  { file: 'happy', expression: 'happy', duration: 1.8 }
];

class VRMAdapter {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true // ヒット判定で readPixels するため
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, -1, -100, 100);
    this.camera.position.set(0, 0, 50);
    const light = new THREE.DirectionalLight(0xffffff, Math.PI); // three-vrm の例と同じ
    light.position.set(1, 1, 1).normalize();
    this.scene.add(light);

    this.ppm = 300;                // 1m あたりの px（setHeight で決まる）
    this.group = new THREE.Group(); // 位置はここで持つ（vrm.scene は触らない）
    this.scene.add(this.group);
    this.lookTarget = new THREE.Object3D();
    this.scene.add(this.lookTarget);

    this.vrm = null;
    this.box = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)); // モデル座標（m）
    this.mouth = null;
    this.gesture = null;
    this.gestureT = 0;
    this.blinkT = 2 + Math.random() * 3;
    this.focusOn = false;
    this._px = new Uint8Array(4);

    this.clock = new THREE.Clock();
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
    this._loop = () => { this._raf = requestAnimationFrame(this._loop); this._update(); };
    this._loop();
  }

  async load(url) {
    const buffer = await xhrGet(url);
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.parseAsync(buffer, new URL('.', url).href);
    const vrm = gltf.userData.vrm;
    if (!vrm) {
      throw Object.assign(new Error('VRM ではない glTF: ' + url), { userMessage: 'VRM の情報が入っていないファイルみたい…' });
    }
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons?.(vrm.scene);
    VRMUtils.rotateVRM0(vrm); // 0.x は後ろ向きなので 1.0 と同じ向きにそろえる
    vrm.scene.traverse((o) => { o.frustumCulled = false; });

    if (this.vrm) {
      this.group.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
    }
    this.vrm = vrm;
    this.group.add(vrm.scene);
    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;

    this._applyRestPose();
    vrm.update(0);
    this.box = this._measure(vrm);
    this.mouth = null;
    this.gesture = null;
  }

  _applyRestPose() {
    const h = this.vrm.humanoid;
    for (const [name, [x, y, z]] of Object.entries(REST_POSE)) {
      h.getNormalizedBoneNode(name)?.rotation.set(x, y, z);
    }
  }

  // 立ち姿で描かれている範囲（m）。スキンの変形込みで測り、揺れものの分の余裕を足す
  _measure(vrm) {
    vrm.scene.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(vrm.scene.matrixWorld).invert();
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    vrm.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      if (o.isSkinnedMesh) o.computeBoundingBox(); else if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      tmp.copy(o.isSkinnedMesh ? o.boundingBox : o.geometry.boundingBox)
        .applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      box.union(tmp);
    });
    if (box.isEmpty()) return new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.2), new THREE.Vector3(0.3, 1.6, 0.2));
    const size = box.getSize(new THREE.Vector3());
    box.min.x -= size.x * 0.04; box.max.x += size.x * 0.04;
    box.max.y += size.y * 0.02;
    return box;
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    Object.assign(this.camera, { left: 0, right: w / this.ppm, top: 0, bottom: -h / this.ppm });
    this.camera.updateProjectionMatrix();
  }

  _scale() { return this.ppm; }

  setHeight(px) {
    if (!this.vrm) return;
    this.ppm = px / (this.box.max.y - this.box.min.y);
    this._resize();
  }

  getSize() {
    if (!this.vrm) return { width: 0, height: 0 };
    const s = this._scale();
    return { width: (this.box.max.x - this.box.min.x) * s, height: (this.box.max.y - this.box.min.y) * s };
  }

  // 描画範囲の中心を (x, y)（ウィンドウ座標）に置く
  setPosition(x, y) {
    if (!this.vrm) return;
    const s = this._scale();
    const cx = (this.box.min.x + this.box.max.x) / 2, cy = (this.box.min.y + this.box.max.y) / 2;
    const nx = x / s - cx, ny = -y / s - cy;
    const moved = Math.abs(nx - this.group.position.x) + Math.abs(ny - this.group.position.y) > 1e-4;
    this.group.position.set(nx, ny, 0);
    if (moved) {
      this.group.updateMatrixWorld(true);
      this.vrm.springBoneManager?.reset(); // 瞬間移動で髪が振り回されないように
    }
    this._resetLookTarget();
  }

  getBounds() {
    if (!this.vrm) return null;
    const s = this._scale(), p = this.group.position;
    return {
      left: (p.x + this.box.min.x) * s, right: (p.x + this.box.max.x) * s,
      top: -(p.y + this.box.max.y) * s, bottom: -(p.y + this.box.min.y) * s
    };
  }

  // 視線：カーソル（ウィンドウ座標）の少し手前を見る
  focus(x, y) {
    if (!this.vrm) return;
    this.focusOn = true;
    this.lookTarget.position.set(x / this.ppm, -y / this.ppm, this._headZ() + 2); // 2m 手前
  }

  resetFocus() {
    this.focusOn = false;
    this._resetLookTarget();
  }

  _headZ() {
    const head = this.vrm?.humanoid.getNormalizedBoneNode('head');
    return head ? head.getWorldPosition(new THREE.Vector3()).z : 0;
  }

  _resetLookTarget() {
    if (this.focusOn || !this.vrm) return;
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    const p = head ? head.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
    this.lookTarget.position.set(p.x, p.y, p.z + 5);
  }

  listMotions() {
    return this.vrm ? GESTURES.map((g) => ({ ...g, sound: null })) : [];
  }

  playMotion(m) {
    if (!this.vrm || !m) return;
    this.gesture = m;
    this.gestureT = 0;
  }

  setExpression(name) {
    const em = this.vrm?.expressionManager;
    if (!em) return;
    for (const n of ['happy', 'angry', 'sad', 'relaxed', 'surprised']) em.setValue(n, n === name ? 1 : 0);
  }

  setMouth(level) { this.mouth = level; }

  setModelSound() {} // VRM に付属音声は無い

  hitTest(x, y) {
    if (!this.vrm) return false;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    const gl = this.renderer.getContext();
    const r = this.renderer.getPixelRatio();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(Math.floor(x * r), Math.floor(this.canvas.height - 1 - y * r), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._px);
    return this._px[3] > 16;
  }

  _update() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    const vrm = this.vrm;
    if (vrm) {
      const h = vrm.humanoid;
      this._applyRestPose();
      // 待機：呼吸と小さな揺れ
      const spine = h.getNormalizedBoneNode('spine');
      const chest = h.getNormalizedBoneNode('chest') || h.getNormalizedBoneNode('upperChest');
      const head = h.getNormalizedBoneNode('head');
      spine?.rotation.set(Math.sin(t * 1.6) * 0.015, 0, Math.sin(t * 0.5) * 0.02);
      chest?.rotation.set(Math.sin(t * 1.6 + 0.6) * 0.02, 0, 0);
      head?.rotation.set(0, 0, Math.sin(t * 0.7) * 0.03);
      this._updateGesture(dt, head);
      this._updateFace(dt);
      vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  }

  _updateGesture(dt, head) {
    const g = this.gesture;
    if (!g) return;
    this.gestureT += dt;
    const k = this.gestureT / g.duration; // 0〜1
    if (k >= 1) { this.gesture = null; this.setExpression(null); return; }
    const env = Math.sin(Math.PI * k); // 立ち上がって戻る
    if (head) {
      if (g.file === 'nod') head.rotation.x += Math.sin(k * Math.PI * 4) * 0.18 * env;
      else if (g.file === 'tilt') head.rotation.z += 0.25 * env;
      else if (g.file === 'surprised') head.rotation.x -= 0.12 * env;
    }
    this.vrm.expressionManager?.setValue(g.expression, env);
  }

  _updateFace(dt) {
    const em = this.vrm.expressionManager;
    if (!em) return;
    // まばたき
    this.blinkT -= dt;
    let blink = 0;
    if (this.blinkT < 0.15) blink = Math.sin(Math.max(0, this.blinkT) / 0.15 * Math.PI);
    if (this.blinkT < 0) { this.blinkT = 2 + Math.random() * 4; blink = 0; }
    em.setValue('blink', this.gesture?.expression === 'happy' ? 0 : blink);
    // 口パク（null の間は閉じる）
    em.setValue('aa', this.mouth == null ? 0 : this.mouth);
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

window.VRMAdapter = VRMAdapter;
