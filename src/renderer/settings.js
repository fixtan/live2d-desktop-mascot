// 設定ウィンドウ。値は持たず、操作をマスコットへ送り、返ってきた状態を表示する
//   操作：ipcRenderer.send('settings-action', { type, key?, value? })
//   状態：'settings-state' { settings, bundled, library, voicePacks, target, primary, followSupported, characters }
//   どのキャラの設定を出すかはメインが持つ（settings-select-character で切り替え）
const { ipcRenderer, webUtils } = require('electron');
const path = require('path');

const $ = (id) => document.getElementById(id);
const act = (type, extra = {}) => ipcRenderer.send('settings-action', { type, ...extra });
const set = (key, value) => act('set', { key, value });

let state = null;

// ドラッグ中・入力中の部品は上書きしない（スライダーが指から逃げないように）
const idle = (el) => el !== document.activeElement;

// ===== モデル一覧（エクスプローラ風） =====
// サムネは VRM の埋め込みだけ。無いモデルは頭文字。一度取ったサムネはここで覚える
const thumbCache = new Map(); // file → data URL | null
let gridKey = '';

async function loadThumbs(files) {
  const need = files.filter((f) => f && !thumbCache.has(f));
  if (!need.length) return;
  const got = await ipcRenderer.invoke('model-thumbs', need);
  for (const f of need) thumbCache.set(f, got[f] ?? null);
}

function thumbBox(el, file, label) {
  el.innerHTML = '';
  const url = file ? thumbCache.get(file) : null;
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    el.appendChild(img);
  } else {
    const span = document.createElement('span');
    span.className = 'initial';
    span.textContent = [...(label || '?')][0].toUpperCase();
    el.appendChild(span);
  }
}

async function fillModelGrid(s) {
  const grid = $('model-grid');
  const external = path.isAbsolute(s.settings.model) ? [s.settings.model] : [];
  const groups = [
    ['同梱', s.bundled.map((id) => [id, id])],
    ['ライブラリ', s.library.map((id) => [id, 'lib:' + id])],
    ['外部', external.map((p) => ['📁 ' + path.basename(p), p])]
  ].filter(([, items]) => items.length);

  // 一覧が変わった時だけ作り直す（スライダー操作のたびに状態が届くため）
  const key = JSON.stringify(groups);
  if (key !== gridKey) {
    gridKey = key;
    await loadThumbs(groups.flatMap(([, items]) => items.map(([, v]) => s.modelPaths?.[v])));
    grid.innerHTML = '';
    for (const [label, items] of groups) {
      const h = document.createElement('div');
      h.className = 'group';
      h.textContent = label;
      grid.appendChild(h);
      for (const [text, value] of items) {
        const tile = document.createElement('button');
        tile.className = 'model-tile';
        tile.dataset.value = value;
        tile.title = text;
        const box = document.createElement('div');
        box.className = 'thumb';
        thumbBox(box, s.modelPaths?.[value], text.replace(/^📁 /, ''));
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = text;
        tile.append(box, name);
        tile.onclick = () => { tile.blur(); act('model', { value }); };
        if (value.startsWith('lib:')) acceptThumbDrop(tile, s.modelPaths?.[value], text);
        grid.appendChild(tile);
      }
    }
  }
  for (const tile of grid.querySelectorAll('.model-tile')) {
    const on = tile.dataset.value === state.settings.model;
    if (on && !tile.classList.contains('selected')) tile.scrollIntoView({ block: 'nearest' });
    tile.classList.toggle('selected', on);
  }
}

// タイルに画像をドロップ → 確認してから、そのモデルのフォルダに thumb.* として入れる（ライブラリのモデルだけ）
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
function acceptThumbDrop(tile, file, name) {
  if (!file) return;
  tile.addEventListener('dragover', (e) => { e.preventDefault(); tile.classList.add('drop'); });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop'));
  tile.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    tile.classList.remove('drop');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const image = webUtils.getPathForFile(f);
    if (!IMAGE_RE.test(image)) { alert('サムネにできるのは PNG・JPEG・WebP の画像だけです'); return; }
    const info = await ipcRenderer.invoke('thumb-info', file);
    if (!info.editable) return;
    const verb = info.exists ? '入れ替えますか？' : '追加しますか？';
    if (!confirm(`「${name}」にサムネ画像「${path.basename(image)}」を${verb}`)) return;
    const res = await ipcRenderer.invoke('thumb-set', { file, image });
    if (res.error) { alert(res.error); return; }
    thumbCache.delete(file);
    gridKey = ''; // 作り直す
    render(state);
  });
}

// 一覧の外に落とした画像で窓が画像に置き換わらないように
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function fillCharacterThumb(s) {
  const c = s.characters.find((x) => x.id === s.target);
  await loadThumbs([c?.modelPath]);
  const label = c?.model ? (c.model.startsWith('lib:') ? c.model.slice(4) : path.basename(c.model)) : '?';
  thumbBox($('character-thumb'), c?.modelPath, label);
}

function fillCharacterSelect(s) {
  const sel = $('character-select');
  if (idle(sel)) {
    sel.innerHTML = '';
    for (const c of s.characters) sel.add(new Option(c.label, c.id));
    sel.value = s.target;
  }
  $('btn-remove-character').disabled = s.characters.length <= 1;
}

function fillVoiceSelect(s) {
  const sel = $('voice-pack-select');
  if (!idle(sel)) return;
  sel.innerHTML = '';
  sel.add(new Option('なし', ''));
  for (const name of s.voicePacks) sel.add(new Option(name, name));
  sel.value = s.settings.voicePack;
}

// 声の出し方（マスコット側の voiceModeOf と同じ）
function voiceModeOf(st) {
  if (st.mute) return 'mute';
  if (!st.voice) return 'pack';
  return st.ttsEngine === 'os' ? 'os' : 'voicevox';
}

const VOICE_HINTS = {
  pack: 'ボイスパックの声で話す。自作セリフ（ひとこと・時報など）は字幕だけ',
  voicevox: 'ボイスパックのセリフも自作セリフも、この話者で話す。VOICEVOX が起動していない時はボイスパックの声',
  os: 'ボイスパックの声＋自作セリフは OS の読み上げ',
  mute: '音を出さない。字幕としぐさだけ'
};

function render(s) {
  if (!s) return;
  const prevMode = state ? voiceModeOf(state.settings) : null;
  state = s;
  const st = s.settings;
  const mode = voiceModeOf(st);

  fillCharacterSelect(s);
  fillCharacterThumb(s);
  fillModelGrid(s);
  $('btn-remove-model').disabled = !st.model.startsWith('lib:');
  fillVoiceSelect(s);

  const setVal = (id, v) => { if (idle($(id))) $(id).value = v; };
  setVal('voice-mode-select', mode);
  $('voice-mode-hint').textContent = VOICE_HINTS[mode];
  setVal('speed-range', st.voicevoxSpeed);
  setVal('height-range', st.height);
  setVal('opacity-range', st.opacity);
  $('speed-val').textContent = '×' + Number(st.voicevoxSpeed).toFixed(2);
  $('height-val').textContent = st.height + ' px';
  $('opacity-val').textContent = Math.round(st.opacity * 100) + '%';

  $('gaze-check').checked = st.gaze;
  $('events-check').checked = st.events;
  $('chime-check').checked = st.chime;
  $('chime-check').disabled = !s.primary;
  $('chime-row').classList.toggle('disabled', !s.primary);
  $('chime-note').textContent = s.primary ? '' : '（代表のみ）';
  $('follow-check').checked = s.followSupported && st.follow !== false;
  $('follow-check').disabled = !s.followSupported;
  $('follow-row').classList.toggle('disabled', !s.followSupported);
  $('follow-note').textContent = s.followSupported ? '' : '（Windows のみ）';

  $('voicevox-settings').style.display = mode === 'voicevox' ? 'block' : 'none';
  if (mode === 'voicevox' && prevMode !== 'voicevox') refreshSpeakers();
  else if ($('speaker-select').options.length && idle($('speaker-select'))) {
    $('speaker-select').value = String(st.voicevoxSpeaker);
  }
}

// VOICEVOX の話者一覧（メインプロセス経由）
async function refreshSpeakers() {
  const sel = $('speaker-select');
  const credit = $('voicevox-credit');
  sel.innerHTML = '';
  const speakers = await ipcRenderer.invoke('voicevox-speakers');
  if (!speakers) {
    sel.add(new Option('エンジンに接続できません', ''));
    sel.disabled = true;
    credit.textContent = 'VOICEVOX（127.0.0.1:50021）を起動してね';
    return;
  }
  for (const sp of speakers) {
    for (const style of sp.styles) {
      const opt = new Option(`${sp.name}（${style.name}）`, style.id);
      opt.dataset.name = sp.name;
      sel.add(opt);
    }
  }
  sel.disabled = false;
  sel.value = String(state?.settings.voicevoxSpeaker ?? '');
  if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  credit.textContent = 'VOICEVOX:' + (sel.selectedOptions[0]?.dataset.name || '');
}

// ===== 操作 =====
$('character-select').onchange = (e) => {
  e.target.blur();
  ipcRenderer.send('settings-select-character', e.target.value);
};
$('btn-add-character').onclick = () => ipcRenderer.send('character-add');
$('btn-remove-character').onclick = () => {
  if (!state || state.characters.length <= 1) return;
  const c = state.characters.find((x) => x.id === state.target);
  if (confirm(`「${c?.label || state.target}」を消す？`)) ipcRenderer.send('character-remove', state.target);
};
$('btn-import-model').onclick = () => act('import-model');
$('btn-select-file').onclick = () => act('select-model-file');
$('btn-open-library').onclick = () => ipcRenderer.send('library-open');
$('btn-open-motions').onclick = () => ipcRenderer.send('motions-open');
$('btn-remove-model').onclick = () => {
  const m = state?.settings.model || '';
  if (!m.startsWith('lib:')) return;
  if (confirm(`「${m.slice(4)}」をライブラリから削除する？`)) act('remove-model');
};
$('voice-pack-select').onchange = (e) => { e.target.blur(); act('voice-pack', { value: e.target.value }); };
$('btn-test-voice').onclick = () => act('test-voice');
$('btn-test-tts').onclick = () => act('test-tts');
$('voice-mode-select').onchange = (e) => { e.target.blur(); act('voice-mode', { value: e.target.value }); };
$('speaker-select').onchange = (e) => {
  set('voicevoxSpeaker', Number(e.target.value));
  $('voicevox-credit').textContent = 'VOICEVOX:' + (e.target.selectedOptions[0]?.dataset.name || '');
  e.target.blur();
};
$('speed-range').oninput = (e) => set('voicevoxSpeed', parseFloat(e.target.value));
$('height-range').oninput = (e) => set('height', parseFloat(e.target.value));
$('opacity-range').oninput = (e) => set('opacity', parseFloat(e.target.value));
$('gaze-check').onchange = (e) => set('gaze', e.target.checked);
$('follow-check').onchange = (e) => set('follow', e.target.checked);
$('events-check').onchange = (e) => set('events', e.target.checked);
$('chime-check').onchange = (e) => set('chime', e.target.checked);

// スライダーは離したらフォーカスを外す（以降の状態更新を反映させる）
for (const id of ['speed-range', 'height-range', 'opacity-range']) {
  $(id).addEventListener('change', (e) => e.target.blur());
}

window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

// ===== 状態の受信 =====
ipcRenderer.on('settings-state', (event, s) => render(s));

(async () => {
  render(await ipcRenderer.invoke('settings-get-state'));
})();
