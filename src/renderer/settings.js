// 設定ウィンドウ。値は持たず、操作をマスコットへ送り、返ってきた状態を表示する
//   操作：ipcRenderer.send('settings-action', { type, key?, value? })
//   状態：'settings-state' { settings, bundled, library, voicePacks, target, primary, followSupported, characters }
//   どのキャラの設定を出すかはメインが持つ（settings-select-character で切り替え）
const { ipcRenderer } = require('electron');
const path = require('path');

const $ = (id) => document.getElementById(id);
const act = (type, extra = {}) => ipcRenderer.send('settings-action', { type, ...extra });
const set = (key, value) => act('set', { key, value });

let state = null;

// ドラッグ中・入力中の部品は上書きしない（スライダーが指から逃げないように）
const idle = (el) => el !== document.activeElement;

function fillModelSelect(s) {
  const sel = $('model-select');
  if (!idle(sel)) return;
  sel.innerHTML = '';
  const group = (label, items) => {
    if (!items.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    items.forEach(([text, value]) => g.appendChild(new Option(text, value)));
    sel.appendChild(g);
  };
  group('同梱', s.bundled.map((id) => [id, id]));
  group('ライブラリ', s.library.map((id) => [id, 'lib:' + id]));
  if (path.isAbsolute(s.settings.model)) {
    group('外部', [['📁 ' + path.basename(s.settings.model), s.settings.model]]);
  }
  sel.value = s.settings.model;
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
  fillModelSelect(s);
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
$('model-select').onchange = (e) => { e.target.blur(); act('model', { value: e.target.value }); };
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
