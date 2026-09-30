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

// 手を下ろした立ち姿（正規化ボーン、VRM 1.0 の向きで書く。0.x は _rot が x・z の符号を反転する）
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
    this.flip = 1;
    this.box = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)); // モデル座標（m）
    this.mouth = null;
    this.gesture = null;
    this.gestureT = 0;
    this.blinkT = 2 + Math.random() * 3;
    this.focusOn = false;
    this.headYaw = 0;   // 視線追従で頭が向く角度（なめらかに追う）
    this.headPitch = 0;
    this._px = new Uint8Array(4);

    this.timer = new THREE.Timer();
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
    this._loop = (ts) => { this._raf = requestAnimationFrame(this._loop); this._update(ts); };
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
    // VRM 0.x は rotateVRM0 で向きをそろえても、正規化ボーンの x・z 回転が 1.0 と逆になる
    this.flip = vrm.meta?.metaVersion === '0' ? -1 : 1;

    this._applyRestPose();
    vrm.update(0);
    this.box = this._measure(vrm);
    this.mouth = null;
    this.gesture = null;
  }

  // 正規化ボーンの回転（VRM 1.0 の向きで指定）
  _rot(name, x, y, z) {
    this.vrm.humanoid.getNormalizedBoneNode(name)?.rotation.set(x * this.flip, y, z * this.flip);
  }

  _applyRestPose() {
    for (const [name, [x, y, z]] of Object.entries(REST_POSE)) this._rot(name, x, y, z);
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

  _update(ts) {
    this.timer.update(ts);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t = this.timer.getElapsed();
    const vrm = this.vrm;
    if (vrm) {
      this._applyRestPose();
      // 待機：呼吸と小さな揺れ
      this._rot('spine', Math.sin(t * 1.6) * 0.015, 0, Math.sin(t * 0.5) * 0.02);
      this._rot(vrm.humanoid.getNormalizedBoneNode('chest') ? 'chest' : 'upperChest', Math.sin(t * 1.6 + 0.6) * 0.02, 0, 0);
      const g = this._updateGesture(dt);
      this._updateHeadTurn(dt);
      // 頭：視線追従（y・x）＋ゆらぎ＋しぐさ。首にも少し分ける
      this._rot('neck', -this.headPitch * 0.3, this.headYaw * 0.3, 0);
      this._rot('head', -this.headPitch * 0.7 + g.x, this.headYaw * 0.7, Math.sin(t * 0.7) * 0.03 + g.z);
      this._updateFace(dt);
      vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  }

  // 視線の先へ頭を向ける（目は lookAt が動かす。頭は角度の一部だけ追い、上限を付ける）
  _updateHeadTurn(dt) {
    let yaw = 0, pitch = 0;
    if (this.focusOn) {
      const head = this.vrm.humanoid.getNormalizedBoneNode('head');
      if (head) {
        const p = head.getWorldPosition(new THREE.Vector3());
        const d = this.lookTarget.position.clone().sub(p);
        const clamp = (v, m) => Math.max(-m, Math.min(m, v));
        yaw = clamp(Math.atan2(d.x, d.z) * 0.5, 0.45);
        pitch = clamp(Math.atan2(d.y, d.z) * 0.5, 0.3);
      }
    }
    const k = Math.min(1, dt * 5);
    this.headYaw += (yaw - this.headYaw) * k;
    this.headPitch += (pitch - this.headPitch) * k;
  }

  // しぐさを進めて、頭に足す回転 { x, z } を返す
  _updateGesture(dt) {
    const off = { x: 0, z: 0 };
    const g = this.gesture;
    if (!g) return off;
    this.gestureT += dt;
    const k = this.gestureT / g.duration; // 0〜1
    if (k >= 1) { this.gesture = null; this.setExpression(null); return off; }
    const env = Math.sin(Math.PI * k); // 立ち上がって戻る
    if (g.file === 'nod') off.x = Math.sin(k * Math.PI * 4) * 0.18 * env;
    else if (g.file === 'tilt') off.z = 0.25 * env;
    else if (g.file === 'surprised') off.x = -0.12 * env;
    this.vrm.expressionManager?.setValue(g.expression, env);
    return off;
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
