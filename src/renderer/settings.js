// 設定ウィンドウ。値は持たず、操作をマスコットへ送り、返ってきた状態を表示する
//   操作：ipcRenderer.send('settings-action', { type, key?, value? })
//   状態：'settings-state' { settings, bundled, library, voicePacks }
const { ipcRenderer } = require('electron');
const path = require('path');
const { importLabel } = require('../shared/formats');

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
  group('操作', [[`${importLabel} を取り込む…`, '__import__'], ['モデルファイルを直接開く…', '__file__']]);
  sel.value = s.settings.model;
}

function fillVoiceSelect(s) {
  const sel = $('voice-pack-select');
  if (!idle(sel)) return;
  sel.innerHTML = '';
  sel.add(new Option('なし', ''));
  for (const name of s.voicePacks) sel.add(new Option(name, name));
  sel.value = s.settings.voicePack;
}

function render(s) {
  if (!s) return;
  const prevEngine = state?.settings.ttsEngine;
  state = s;
  const st = s.settings;

  fillModelSelect(s);
  $('btn-remove-model').disabled = !st.model.startsWith('lib:');
  fillVoiceSelect(s);

  const setVal = (id, v) => { if (idle($(id))) $(id).value = v; };
  setVal('engine-select', st.ttsEngine);
  setVal('speed-range', st.voicevoxSpeed);
  setVal('height-range', st.height);
  setVal('opacity-range', st.opacity);
  $('speed-val').textContent = '×' + Number(st.voicevoxSpeed).toFixed(2);
  $('height-val').textContent = st.height + ' px';
  $('opacity-val').textContent = Math.round(st.opacity * 100) + '%';

  $('gaze-check').checked = st.gaze;
  $('voice-check').checked = st.voice;
  $('events-check').checked = st.events;
  $('chime-check').checked = st.chime;

  $('voicevox-settings').style.display = st.ttsEngine === 'voicevox' ? 'block' : 'none';
  if (st.ttsEngine === 'voicevox' && prevEngine !== 'voicevox') refreshSpeakers();
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

function renderMode({ on, supported }) {
  const sel = $('mode-select');
  sel.value = on ? 'vscode' : 'free';
  sel.disabled = !supported;
  $('mode-hint').textContent = supported ? '' : 'VS Code 追従は Windows のみ対応です';
}

// ===== 操作 =====
$('model-select').onchange = (e) => {
  const v = e.target.value;
  e.target.blur();
  if (v === '__file__') { e.target.value = state.settings.model; act('select-model-file'); }
  else if (v === '__import__') { e.target.value = state.settings.model; act('import-model'); }
  else act('model', { value: v });
};
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
$('engine-select').onchange = (e) => { e.target.blur(); set('ttsEngine', e.target.value); };
$('speaker-select').onchange = (e) => {
  set('voicevoxSpeaker', Number(e.target.value));
  $('voicevox-credit').textContent = 'VOICEVOX:' + (e.target.selectedOptions[0]?.dataset.name || '');
  e.target.blur();
};
$('speed-range').oninput = (e) => set('voicevoxSpeed', parseFloat(e.target.value));
$('height-range').oninput = (e) => set('height', parseFloat(e.target.value));
$('opacity-range').oninput = (e) => set('opacity', parseFloat(e.target.value));
$('mode-select').onchange = (e) => { e.target.blur(); ipcRenderer.send('set-tracking-mode', e.target.value === 'vscode'); };
$('gaze-check').onchange = (e) => set('gaze', e.target.checked);
$('voice-check').onchange = (e) => set('voice', e.target.checked);
$('events-check').onchange = (e) => set('events', e.target.checked);
$('chime-check').onchange = (e) => set('chime', e.target.checked);

// スライダーは離したらフォーカスを外す（以降の状態更新を反映させる）
for (const id of ['speed-range', 'height-range', 'opacity-range']) {
  $(id).addEventListener('change', (e) => e.target.blur());
}

window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });

// ===== 状態の受信 =====
ipcRenderer.on('settings-state', (event, s) => render(s));
ipcRenderer.on('tracking-changed', (event, m) => renderMode(m));

(async () => {
  render(await ipcRenderer.invoke('settings-get-state'));
  renderMode(await ipcRenderer.invoke('tracking-get'));
})();
