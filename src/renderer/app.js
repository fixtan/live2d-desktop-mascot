const { ipcRenderer, webUtils } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

// ===== パス =====
const ASSETS_DIR = fileURLToPath(new URL('../../assets/', location.href));
const VOICES_DIR = path.join(ASSETS_DIR, 'voices');

// assets/<name>/*.model3.json を同梱モデルとして列挙
function listBundledModels() {
  const result = [];
  try {
    for (const dir of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name === 'voices') continue;
      const file = fs.readdirSync(path.join(ASSETS_DIR, dir.name)).find((f) => /\.model3\.json$/i.test(f));
      if (file) result.push({ id: dir.name, path: path.join(ASSETS_DIR, dir.name, file) });
    }
  } catch (e) { console.warn('assets走査失敗:', e); }
  return result;
}

// assets/voices/<name>/voices.json をボイスパックとして列挙
function listVoicePacks() {
  try {
    return fs.readdirSync(VOICES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(VOICES_DIR, d.name, 'voices.json')))
      .map((d) => d.name);
  } catch { return []; }
}

// ===== 設定 =====
const DEFAULTS = {
  model: 'haru_greeter', // 同梱モデルのフォルダ名、またはmodel3.jsonの絶対パス
  voicePack: 'haru',     // assets/voices/<name>、空文字でなし
  height: 480,
  opacity: 1,
  gaze: true,
  voice: false,          // 自作セリフの読み上げ
  ttsEngine: 'voicevox', // 'voicevox' | 'os'（VOICEVOXが無ければOSに切り替え）
  voicevoxSpeaker: 8,    // 話者スタイルID
  voicevoxSpeed: 1.0,
  events: true,
  chime: true
};

const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('mascot-settings-v3') || '{}') }; }
  catch { return { ...DEFAULTS }; }
})();

function saveSettings() {
  try { localStorage.setItem('mascot-settings-v3', JSON.stringify(settings)); } catch {}
}

// ===== レイアウト定数 =====
const PAD = 16;
const BUBBLE_SPACE = 110;
const MIN_W = 320;
const MIN_H = 460;

// ===== 状態 =====
const $ = (id) => document.getElementById(id);
const settingsModal = $('settings-modal');
const bubble = $('bubble');

const mascot = new Live2DAdapter($('stage'));
mascot.setModelSound(false); // 声はボイスパックから鳴らす（字幕と一致させるため）

let voices = [];          // [{ url, text, motion }]
let isDragging = false;
let dragStartX = 0, dragStartY = 0;
let downScreenX = 0, downScreenY = 0;
let ignoring = false;

// ===== モデル =====
// model の値：同梱 "haru_greeter" / ライブラリ "lib:<名前>" / 外部 "C:\...\x.model3.json"
let libraryModels = [];

async function refreshLibrary() {
  libraryModels = await ipcRenderer.invoke('library-list');
}

function resolveModelPath(model) {
  if (!model) return null;
  if (model.startsWith('lib:')) return libraryModels.find((m) => m.id === model.slice(4))?.path || null;
  if (path.isAbsolute(model)) return model;
  return listBundledModels().find((m) => m.id === model)?.path || null;
}

// ZIP / フォルダをライブラリに取り込んで表示
async function importModel(p) {
  const res = await ipcRenderer.invoke('import-model', p);
  if (!res) return;
  if (res.error) { say('取り込めなかったよ…\n' + res.error, 5000, { tts: false }); return; }
  await refreshLibrary();
  loadModel('lib:' + res.id);
}

async function removeLibraryModel() {
  const model = settings.model;
  if (!model.startsWith('lib:')) return;
  if (!confirm(`「${model.slice(4)}」をライブラリから削除する？`)) return;
  await loadModel(DEFAULTS.model, { announce: false });
  await ipcRenderer.invoke('library-remove', model.slice(4));
  await refreshLibrary();
  refreshModelSelect();
}

async function loadModel(model, { announce = true } = {}) {
  const p = resolveModelPath(model);
  try {
    if (!p || !fs.existsSync(p)) throw new Error('model not found: ' + model);
    await mascot.load(pathToFileURL(p).href);
  } catch (err) {
    console.error('モデル読み込みエラー:', err);
    if (model !== DEFAULTS.model) {
      say('モデルを読み込めなかったよ…\nデフォルトに戻すね', undefined, { tts: false });
      return loadModel(DEFAULTS.model, { announce: false });
    }
    say('デフォルトモデルが見つからないよ\nassets を確認して', undefined, { tts: false });
    return false;
  }

  settings.model = model;
  saveSettings();
  refreshModelSelect();
  if (!settings.gaze) mascot.resetFocus();
  applyHeight(settings.height);
  if (announce) say(greeting());
  return true;
}

async function selectModelFile() {
  const p = await ipcRenderer.invoke('select-model');
  if (p) loadModel(p);
}

// ===== ボイスパック =====
function loadVoicePack(name) {
  voices = [];
  settings.voicePack = name || '';
  saveSettings();
  if (!name) return;
  try {
    const dir = path.join(VOICES_DIR, name);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'voices.json'), 'utf8'));
    voices = (data.voices || [])
      .map((v) => ({ ...v, abs: path.resolve(dir, v.file) }))
      .filter((v) => {
        if (fs.existsSync(v.abs)) return true;
        console.warn('音声ファイルが無い:', v.abs);
        return false;
      })
      .map((v) => ({ abs: v.abs, text: v.text || '', motion: v.motion || null, on: v.on || null }));
  } catch (e) {
    console.warn('ボイスパック読み込み失敗:', e);
  }
}

// ===== 音声再生（WebAudio。音量から口パクを作る） =====
let audioCtx = null;
let currentSource = null;
let lipRAF = null;
let mouthLevel = 0;
let playToken = 0; // 後から来た再生要求を優先するための番号

function stopVoice() {
  playToken++;
  if (currentSource) { try { currentSource.stop(); } catch {} currentSource = null; }
  cancelAnimationFrame(lipRAF);
  mouthLevel = 0;
  mascot.setMouth(null);
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

// wavなどのバイト列を再生。token が古くなっていたら何もしない
async function playAudioData(data, token) {
  audioCtx ||= new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const buffer = await audioCtx.decodeAudioData(toArrayBuffer(data));
  if (token !== playToken) return;

  // 音源ごとの音量差を吸収：一番大きい区間の音量で口の開きを正規化
  const ch = buffer.getChannelData(0);
  const WIN = 1024;
  let peak = 0;
  for (let i = 0; i < ch.length; i += WIN) {
    const end = Math.min(ch.length, i + WIN);
    let s = 0;
    for (let j = i; j < end; j++) s += ch[j] * ch[j];
    peak = Math.max(peak, Math.sqrt(s / (end - i)));
  }
  const gain = peak > 0 ? 1 / peak : 1;

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  analyser.connect(audioCtx.destination);

  const wave = new Float32Array(analyser.fftSize);
  const tick = () => {
    analyser.getFloatTimeDomainData(wave);
    let sum = 0;
    for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
    const level = Math.sqrt(sum / wave.length) * gain; // 0〜1
    const target = level < 0.12 ? 0 : Math.min(1, level * 1.2); // 小さい音は閉じる
    mouthLevel += (target - mouthLevel) * 0.5; // なめらかに
    mascot.setMouth(mouthLevel);
    lipRAF = requestAnimationFrame(tick);
  };

  src.onended = () => {
    if (currentSource !== src) return;
    currentSource = null;
    cancelAnimationFrame(lipRAF);
    mascot.setMouth(null);
  };
  currentSource = src;
  src.start();
  tick();
}

// 場面に合う声を選ぶ（on 未指定の声はどの場面でも使う）
function voicesFor(scene) {
  return voices.filter((v) => !v.on || v.on.includes(scene));
}

// 声＋字幕＋しぐさ。しぐさはファイル名の部分一致で探し、無ければ適当に選ぶ
function playVoice(v = pick(voices)) {
  if (!v) return false;
  stopVoice();
  const token = playToken;

  const motions = mascot.listMotions();
  const matched = v.motion && motions.find((m) => m.file.includes(v.motion));
  mascot.playMotion(matched || pick(motions));

  fs.promises.readFile(v.abs)
    .then((data) => playAudioData(data, token))
    .catch((e) => console.warn('ボイス再生失敗:', e));

  if (v.text) say(v.text, undefined, { tts: false });
  return true;
}

// ===== サイズ・配置 =====
function applyHeight(h) {
  h = Math.round(Math.min(1000, Math.max(200, h)));
  settings.height = h;
  saveSettings();
  $('height-range').value = h;

  mascot.setHeight(h);
  const size = mascot.getSize();
  const w = Math.max(MIN_W, Math.ceil(size.width) + PAD * 2);
  const wh = Math.max(MIN_H, BUBBLE_SPACE + Math.ceil(size.height) + PAD);
  ipcRenderer.send('resize-window', { width: w, height: wh });
  layout();
}

function layout() {
  const size = mascot.getSize();
  mascot.setPosition(window.innerWidth / 2, window.innerHeight - PAD - size.height / 2);
  const b = mascot.getBounds();
  if (b) ipcRenderer.send('model-bounds', b);
  positionBubble();
}

window.addEventListener('resize', layout);

// ===== モーション =====
const pick = (arr) => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);

function playMotion() {
  mascot.playMotion(pick(mascot.listMotions()));
}

// ===== 吹き出し・読み上げ =====
let bubbleTimer = null;

function positionBubble() {
  if (!bubble.classList.contains('show')) return;
  const b = mascot.getBounds();
  if (!b) return;
  bubble.style.top = Math.max(4, b.top - bubble.offsetHeight - 10) + 'px';
}

function say(text, ms, { tts = true } = {}) {
  bubble.textContent = text;
  bubble.classList.add('show');
  positionBubble();
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms || Math.max(3000, text.length * 180));
  if (tts && settings.voice) speak(text);
}

// 自作セリフの読み上げ。VOICEVOXが使えなければOS音声に切り替える
async function speak(text) {
  stopVoice();
  const token = playToken;
  if (settings.ttsEngine === 'voicevox') {
    try {
      const wav = await ipcRenderer.invoke('voicevox-synth', {
        text,
        speaker: settings.voicevoxSpeaker,
        speed: settings.voicevoxSpeed
      });
      if (token !== playToken) return;
      if (wav) { await playAudioData(wav, token); return; }
    } catch (e) {
      console.warn('VOICEVOX再生失敗:', e);
      if (token !== playToken) return;
    }
  }
  speakOS(text);
}

function speakOS(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  const v = speechSynthesis.getVoices().find((v) => v.lang.startsWith('ja'));
  if (v) u.voice = v;
  u.pitch = 1.3;
  u.rate = 1.1;
  speechSynthesis.speak(u);
}
if ('speechSynthesis' in window) speechSynthesis.getVoices();

// VOICEVOXの話者一覧で選択肢を作る
async function refreshSpeakerSelect() {
  const sel = $('speaker-select');
  const credit = $('voicevox-credit');
  sel.innerHTML = '';
  try {
    const speakers = await ipcRenderer.invoke('voicevox-speakers');
    if (!speakers) throw new Error('offline');
    for (const sp of speakers) {
      for (const st of sp.styles) {
        const opt = new Option(`${sp.name}（${st.name}）`, st.id);
        opt.dataset.name = sp.name;
        sel.add(opt);
      }
    }
    sel.value = String(settings.voicevoxSpeaker);
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    sel.disabled = false;
    credit.textContent = 'VOICEVOX:' + (sel.selectedOptions[0]?.dataset.name || '');
  } catch (e) {
    sel.add(new Option('エンジンに接続できません', ''));
    sel.disabled = true;
    credit.textContent = 'VOICEVOX（127.0.0.1:50021）を起動してね';
  }
}

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return 'おはよう！今日もがんばろう';
  if (h >= 10 && h < 17) return 'こんにちは！';
  if (h >= 17 && h < 23) return 'こんばんは。無理しないでね';
  return 'こんな時間まで…そろそろ寝よう？';
}

function timeText() {
  const d = new Date();
  return `今は ${d.getHours()}時${String(d.getMinutes()).padStart(2, '0')}分だよ`;
}

const IDLE_LINES = [
  'たまには休憩しよう',
  'コミットした？',
  '水分補給わすれずに',
  'エラー出てない？',
  'いい感じに進んでる？',
  '肩まわしてみて'
];

function talk() {
  playMotion();
  say(`${greeting()}\n${timeText()}`);
}

// ランダムイベント（60〜180秒ごと）：半分はボイス、残りはしぐさ＋ひとこと
function scheduleRandomEvent() {
  setTimeout(() => {
    if (settings.events && !isDragging) {
      const idleVoices = voicesFor('idle');
      if (idleVoices.length && Math.random() < 0.5) {
        playVoice(pick(idleVoices));
      } else {
        playMotion();
        if (Math.random() < 0.5) say(pick(IDLE_LINES));
      }
    }
    scheduleRandomEvent();
  }, 60000 + Math.random() * 120000);
}
scheduleRandomEvent();

// 時報（毎時0分）
let lastChimeHour = new Date().getHours();
setInterval(() => {
  const d = new Date();
  if (d.getMinutes() !== 0 || d.getHours() === lastChimeHour) return;
  lastChimeHour = d.getHours();
  if (!settings.chime) return;
  playMotion();
  say(`${d.getHours()}時になったよ`);
}, 15000);

// ===== クリック透過 =====
function updateHit(x, y) {
  const settingsOpen = settingsModal.style.display === 'block';
  const hit = isDragging || settingsOpen || mascot.hitTest(x, y);
  if (hit === !ignoring) return;
  ignoring = !hit;
  ipcRenderer.send('set-ignore-mouse', ignoring);
}

ipcRenderer.on('cursor', (event, { x, y }) => {
  if (settings.gaze) mascot.focus(x, y);
  updateHit(x, y);
});

// ===== マウス操作 =====
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ipcRenderer.send('show-context-menu', { gaze: settings.gaze, voice: settings.voice });
});

window.addEventListener('mousedown', (e) => {
  if (e.button === 0 && !settingsModal.contains(e.target)) {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    downScreenX = e.screenX;
    downScreenY = e.screenY;
  }
});

window.addEventListener('mousemove', (e) => {
  if (isDragging) {
    ipcRenderer.send('move-window', { mouseX: dragStartX, mouseY: dragStartY });
  } else {
    updateHit(e.clientX, e.clientY);
  }
});

window.addEventListener('mouseup', () => { isDragging = false; });

// クリック：ボイスがあれば半分の確率でしゃべる、なければしぐさ。
// ダブルクリックと区別するため少し待つ
let clickTimer = null;
window.addEventListener('click', (e) => {
  if (settingsModal.contains(e.target)) return;
  if (Math.abs(e.screenX - downScreenX) > 3 || Math.abs(e.screenY - downScreenY) > 3) return;
  if (e.detail > 1) return;
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    const clickVoices = voicesFor('click');
    if (clickVoices.length && Math.random() < 0.5) playVoice(pick(clickVoices));
    else playMotion();
  }, 250);
});

window.addEventListener('dblclick', (e) => {
  if (settingsModal.contains(e.target)) return;
  clearTimeout(clickTimer);
  talk();
});

window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || settingsModal.contains(e.target)) return;
  e.preventDefault();
  applyHeight(settings.height * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
}, { passive: false });

// モデルのドラッグ&ドロップ（キャラの上にドロップ）
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const p = webUtils.getPathForFile(file);
  if (/\.model3\.json$/i.test(p)) { loadModel(p); return; }         // 外部参照
  if (/\.zip$/i.test(p) || fs.statSync(p).isDirectory()) { importModel(p); return; } // 取り込み
  say('ZIP・フォルダ・.model3.json をドロップしてね', undefined, { tts: false });
});

// ===== メインプロセスからのイベント =====
function openSettings() {
  refreshModelSelect();
  if (settings.ttsEngine === 'voicevox') refreshSpeakerSelect();
  settingsModal.style.display = 'block';
  ignoring = false;
  ipcRenderer.send('set-ignore-mouse', false);
}

ipcRenderer.on('open-settings', openSettings);

ipcRenderer.on('mode-changed', (event, on) => {
  $('mode-select').value = on ? 'vscode' : 'free';
});

ipcRenderer.on('menu-action', (event, { type, value }) => {
  if (type === 'talk') talk();
  else if (type === 'gaze') setGaze(value);
  else if (type === 'voice') setSetting('voice', value);
  else if (type === 'select-model') selectModelFile();
  else if (type === 'import-model') importModel();
});

// ===== 設定UI =====
function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  syncSettingsUI();
}

function setGaze(on) {
  setSetting('gaze', on);
  if (!on) mascot.resetFocus();
}

function applyOpacity(val) {
  settings.opacity = parseFloat(val);
  saveSettings();
  $('stage').style.opacity = val;
}

function refreshModelSelect() {
  const sel = $('model-select');
  sel.innerHTML = '';
  const group = (label, items) => {
    if (!items.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    items.forEach(([text, value]) => g.appendChild(new Option(text, value)));
    sel.appendChild(g);
  };
  group('同梱', listBundledModels().map((m) => [m.id, m.id]));
  group('ライブラリ', libraryModels.map((m) => [m.id, 'lib:' + m.id]));
  if (path.isAbsolute(settings.model)) {
    group('外部', [['📁 ' + path.basename(settings.model), settings.model]]);
  }
  group('操作', [['ZIPを取り込む…', '__import__'], ['model3.jsonを直接開く…', '__file__']]);
  sel.value = settings.model;
  $('btn-remove-model').disabled = !settings.model.startsWith('lib:');
}

function refreshVoiceSelect() {
  const sel = $('voice-pack-select');
  sel.innerHTML = '';
  sel.add(new Option('なし', ''));
  for (const name of listVoicePacks()) sel.add(new Option(name, name));
  sel.value = settings.voicePack;
}

function syncSettingsUI() {
  $('height-range').value = settings.height;
  $('opacity-range').value = settings.opacity;
  $('gaze-check').checked = settings.gaze;
  $('voice-check').checked = settings.voice;
  $('engine-select').value = settings.ttsEngine;
  $('speed-range').value = settings.voicevoxSpeed;
  $('voicevox-settings').style.display = settings.ttsEngine === 'voicevox' ? 'block' : 'none';
  $('events-check').checked = settings.events;
  $('chime-check').checked = settings.chime;
}

$('close-settings').onclick = () => { settingsModal.style.display = 'none'; };
$('model-select').onchange = (e) => {
  const v = e.target.value;
  if (v === '__file__') { e.target.value = settings.model; selectModelFile(); }
  else if (v === '__import__') { e.target.value = settings.model; importModel(); }
  else loadModel(v);
};
$('btn-open-library').onclick = () => ipcRenderer.send('library-open');
$('btn-remove-model').onclick = removeLibraryModel;
$('voice-pack-select').onchange = (e) => loadVoicePack(e.target.value);
$('btn-test-voice').onclick = () => { if (!playVoice()) say('ボイスがないよ', undefined, { tts: false }); };
$('mode-select').onchange = (e) => ipcRenderer.send('set-tracking-mode', e.target.value === 'vscode');
$('height-range').oninput = (e) => applyHeight(parseFloat(e.target.value));
$('opacity-range').oninput = (e) => applyOpacity(e.target.value);
$('gaze-check').onchange = (e) => setGaze(e.target.checked);
$('voice-check').onchange = (e) => setSetting('voice', e.target.checked);
$('engine-select').onchange = (e) => {
  setSetting('ttsEngine', e.target.value);
  if (e.target.value === 'voicevox') refreshSpeakerSelect();
};
$('speaker-select').onchange = (e) => {
  setSetting('voicevoxSpeaker', Number(e.target.value));
  $('voicevox-credit').textContent = 'VOICEVOX:' + (e.target.selectedOptions[0]?.dataset.name || '');
};
$('speed-range').oninput = (e) => setSetting('voicevoxSpeed', parseFloat(e.target.value));
$('btn-test-tts').onclick = () => { playMotion(); say(`${greeting()}\n${timeText()}`, undefined, { tts: false }); speak(`${greeting()}。${timeText()}`); };
$('events-check').onchange = (e) => setSetting('events', e.target.checked);
$('chime-check').onchange = (e) => setSetting('chime', e.target.checked);

// ===== 起動 =====
syncSettingsUI();
refreshVoiceSelect();
applyOpacity(settings.opacity);
loadVoicePack(settings.voicePack);
refreshLibrary().then(() => loadModel(settings.model));
