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
import { VRMAnimationLoaderPlugin, createVRMAnimationHumanoidTracks, createVRMAnimationExpressionTracks } from '@pixiv/three-vrm-animation';

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

// VRMA の読み込み結果（url → Promise<VRMAnimation>）。モデルを替えても使い回す
const vrmaCache = new Map();
function loadVRMA(url) {
  if (!vrmaCache.has(url)) {
    const p = xhrGet(url).then(async (buffer) => {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
      const gltf = await loader.parseAsync(buffer, new URL('.', url).href);
      const anim = gltf.userData.vrmAnimations?.[0];
      if (!anim) throw new Error('VRMA ではありません: ' + url);
      return anim;
    });
    p.catch(() => vrmaCache.delete(url)); // 失敗したら次回やり直す
    vrmaCache.set(url, p);
  }
  return vrmaCache.get(url);
}

// VRMA → AnimationClip。視線（lookAt）のトラックは入れない（カーソル追従と取り合うため）
function createClip(anim, vrm, name) {
  const h = createVRMAnimationHumanoidTracks(anim, vrm.humanoid, vrm.meta.metaVersion);
  const tracks = [...h.translation.values(), ...h.rotation.values()];
  if (vrm.expressionManager) {
    const e = createVRMAnimationExpressionTracks(anim, vrm.expressionManager);
    tracks.push(...e.preset.values(), ...e.custom.values());
  }
  return new THREE.AnimationClip(name, anim.duration, tracks);
}

// 手を下ろした立ち姿（正規化ボーン、VRM 1.0 の向きで書く。0.x は _rot が x・z の符号を反転する）
const REST_POSE = {
  leftUpperArm: [0, 0, -1.3],
  rightUpperArm: [0, 0, 1.3],
  leftLowerArm: [0, -0.15, 0],
  rightLowerArm: [0, 0.15, 0]
};

// VRMA の待機モーションが無い時の、手続きで作るしぐさ。file はボイスパックの motion との部分一致に使う
const GESTURES = [
  { file: 'nod', expression: 'happy', duration: 1.2 },
  { file: 'tilt', expression: 'relaxed', duration: 1.6 },
  { file: 'surprised', expression: 'surprised', duration: 1.2 },
  { file: 'happy', expression: 'happy', duration: 1.8 }
];

const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();

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

    // VRMA：{ idle: [{ name, url }], gestures: [...] }（役割分けは app.js 側）
    this.motionSet = { idle: [], gestures: [] };
    this._motionKey = '';
    this._motionToken = 0;
    this.mixer = null;
    this.idleActions = [];         // 待機（1本流し終わるたびにランダムに切り替え）
    this.gestureActions = new Map(); // name → action
    this.activeAction = null;

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

    this._stopMotions();
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
    this._prepareMotions(); // 読み込みは待たない（揃うまでは手続きの待機）
  }

  // ===== VRMA =====
  setMotions(set) {
    const key = JSON.stringify(set);
    if (key === this._motionKey) return;
    this._motionKey = key;
    this.motionSet = set;
    this._prepareMotions();
  }

  _stopMotions() {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.idleActions = [];
    this.gestureActions = new Map();
    this.activeAction = null;
  }

  // 今のモデル用に VRMA をクリップにする。待機が1本も無ければ手続きの待機のまま
  // （しぐさだけの VRMA は、終わった後に戻る姿勢が無いので使わない）
  async _prepareMotions() {
    const token = ++this._motionToken;
    const vrm = this.vrm;
    this._stopMotions();
    const { idle, gestures } = this.motionSet;
    if (!vrm || !idle.length) return;

    const build = async (m) => {
      try { return { name: m.name, clip: createClip(await loadVRMA(m.url), vrm, m.name) }; }
      catch (e) { console.warn('VRMA を読めません:', m.name, e); return null; }
    };
    const [idleClips, gestureClips] = await Promise.all([
      Promise.all(idle.map(build)), Promise.all(gestures.map(build))
    ]);
    if (token !== this._motionToken || vrm !== this.vrm) return; // 途中でモデルや一覧が変わった
    const ok = (list) => list.filter(Boolean);
    if (!ok(idleClips).length) return;

    const mixer = new THREE.AnimationMixer(vrm.scene);
    const once = (clip) => {
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      return a;
    };
    this.mixer = mixer;
    this.idleActions = ok(idleClips).map((c) => once(c.clip));
    this.gestureActions = new Map(ok(gestureClips).map((c) => [c.name, once(c.clip)]));
    mixer.addEventListener('finished', (e) => this._onActionFinished(e.action));
    this.activeAction = this._pickIdle(null);
    this.activeAction.reset().play();
    console.log(`[vrm] VRMA 待機 ${this.idleActions.length} / しぐさ ${this.gestureActions.size}`);
  }

  _pickIdle(prev) {
    const list = this.idleActions;
    const others = list.length > 1 ? list.filter((a) => a !== prev) : list;
    return others[Math.floor(Math.random() * others.length)];
  }

  // 待機が終わったら次の待機へ、しぐさが終わったら待機へ（なめらかに切り替える）
  _onActionFinished(action) {
    if (action !== this.activeAction) return;
    const next = this._pickIdle(this.idleActions.includes(action) ? action : null);
    if (next === action) { action.reset().play(); return; } // 待機が1本だけ：そのまま繰り返す
    next.reset().play();
    action.crossFadeTo(next, this.idleActions.includes(action) ? 0.8 : 0.4, false);
    this.activeAction = next;
  }

  _playGestureAction(action) {
    const prev = this.activeAction;
    action.reset().play();
    if (prev && prev !== action) prev.crossFadeTo(action, 0.3, false);
    this.activeAction = action;
  }

  // 正規化ボーンの回転（VRM 1.0 の向きで指定）
  _rot(name, x, y, z) {
    this.vrm.humanoid.getNormalizedBoneNode(name)?.rotation.set(x * this.flip, y, z * this.flip);
  }

  // 今の回転に足す（VRMA の姿勢の上に視線追従などを重ねる）
  _addRot(name, x, y, z) {
    if (!x && !y && !z) return;
    const node = this.vrm.humanoid.getNormalizedBoneNode(name);
    if (!node) return;
    _euler.set(x * this.flip, y, z * this.flip);
    node.quaternion.multiply(_quat.setFromEuler(_euler));
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

  // しぐさの VRMA があればそれ、無ければ手続きのしぐさ
  listMotions() {
    if (!this.vrm) return [];
    if (this.gestureActions.size) return [...this.gestureActions.keys()].map((file) => ({ file, vrma: true, sound: null }));
    return GESTURES.map((g) => ({ ...g, sound: null }));
  }

  playMotion(m) {
    if (!this.vrm || !m) return;
    if (m.vrma) {
      const a = this.gestureActions.get(m.file);
      if (a) this._playGestureAction(a);
      return;
    }
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
    // モーション・表情は実時間で進める（描画が遅い環境でもスローにならない）。
    // 揺れもの（vrm.update）は大きな刻みで暴れるので 0.1 秒で頭打ち。隠れていた後の大きな飛びは捨てる
    const raw = this.timer.getDelta();
    const dt = raw > 1 ? 0 : raw;
    const t = this.timer.getElapsed();
    const vrm = this.vrm;
    if (vrm) {
      const g = this._updateGesture(dt);
      this._updateHeadTurn(dt);
      if (this.mixer) {
        // VRMA：モーションの姿勢の上に、視線追従としぐさの分を足す。
        // 先に立ち姿へ戻す（モーションに含まれないボーンはそのまま残るので、足し算が毎フレーム積み重ならないように）
        this._applyRestPose();
        for (const n of ['spine', 'chest', 'upperChest', 'neck', 'head']) this._rot(n, 0, 0, 0);
        this.mixer.update(dt);
        this._addRot('neck', -this.headPitch * 0.3, this.headYaw * 0.3, 0);
        this._addRot('head', -this.headPitch * 0.7 + g.x, this.headYaw * 0.7, g.z);
      } else {
        // 手続きの待機：手を下ろした立ち姿＋呼吸と小さな揺れ
        this._applyRestPose();
        this._rot('spine', Math.sin(t * 1.6) * 0.015, 0, Math.sin(t * 0.5) * 0.02);
        this._rot(vrm.humanoid.getNormalizedBoneNode('chest') ? 'chest' : 'upperChest', Math.sin(t * 1.6 + 0.6) * 0.02, 0, 0);
        // 頭：視線追従（y・x）＋ゆらぎ＋しぐさ。首にも少し分ける
        this._rot('neck', -this.headPitch * 0.3, this.headYaw * 0.3, 0);
        this._rot('head', -this.headPitch * 0.7 + g.x, this.headYaw * 0.7, Math.sin(t * 0.7) * 0.03 + g.z);
      }
      this._updateFace(dt);
      vrm.update(Math.min(dt, 0.1));
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
    this._motionToken++;
    this._stopMotions();
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

window.VRMAdapter = VRMAdapter;
