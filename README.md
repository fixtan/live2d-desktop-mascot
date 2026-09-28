# Live2D Desktop Mascot

VS Code のウィンドウ内に常駐する Live2D デスクトップマスコット（Windows）。

- VS Code の枠内に留まる（フリーモードで自由移動も可）
- マウスを目で追う・クリック／ダブルクリックで反応・時報・独り言
- キャラ以外の透明部分はクリックが下のアプリに抜ける
- モデル切り替え（ZIP／フォルダ取り込み、model3.json 直接指定）
- ボイスパック（声と字幕とモーションの組み合わせ）
- 読み上げ：VOICEVOX（起動していれば）／ Windows 標準音声
- 音量に合わせた口パク

## ダウンロード

[Releases](../../releases) から

- `Live2D Desktop Mascot Setup x.x.x.exe` … インストーラー
- `Live2D Desktop Mascot-x.x.x-portable.exe` … インストール不要版

> 署名していないため、初回起動時に「Windows によって PC が保護されました」と表示されます。
> 「詳細情報」→「実行」で起動できます。

## 使い方

| 操作 | 動作 |
|---|---|
| ドラッグ | 移動 |
| クリック | 反応（声・しぐさ） |
| ダブルクリック | 挨拶＋時刻 |
| Ctrl＋ホイール | サイズ変更 |
| 右クリック | メニュー（設定・モデル取り込み・クレジットなど） |
| タスクトレイ | 表示／非表示・位置リセット・終了 |

モデルの ZIP やフォルダをキャラの上にドロップすると取り込めます。
取り込んだモデルは `%APPDATA%\Live2D Desktop Mascot\models\` に保存されます。

対応モデル：Live2D Cubism 3 / 4（.model3.json）

## 開発

```
npm install
npm start            # 起動
npm start -- --debug # DevTools付き
npm run dist:win     # Windows版ビルド（dist/）
```

リポジトリには Live2D の再配布物を含めていません。以下を各自で配置してください。

- `vendor/live2dcubismcore.min.js` … [vendor/README.md](vendor/README.md) 参照
- `assets/haru/` … [ハル](https://www.live2d.com/learn/sample/) の `runtime/` の中身
- `assets/haru_greeter/` … [ハル（受付）](https://www.live2d.com/learn/sample/) の `runtime/` の中身

### 構成

```
src/main/main.js            メインプロセス（ウィンドウ・トレイ・IPC）
src/main/library.js         モデルライブラリ（取り込み・一覧・削除）
src/main/tracker/           VS Code位置追跡（OS別。現在 win32 のみ）
src/renderer/app.js         吹き出し・イベント・設定・入力・音声
src/renderer/adapters/      描画アダプタ（live2d.js）
assets/<モデル>/            同梱モデル
assets/voices/<名前>/       ボイスパック
vendor/                     Cubism Core
```

### ボイスパック

`assets/voices/<名前>/voices.json`

```json
{
  "voices": [
    { "file": "../../haru/sounds/haru_normal_01.wav", "text": "お疲れ様です", "motion": "haru_normal_01", "on": ["idle"] }
  ]
}
```

- `file`: voices.json からの相対パス
- `text`: 吹き出しの字幕（空なら出さない）
- `motion`: モーションファイル名の部分一致（無ければランダム）
- `on`: 使う場面（`click` / `idle`。省略で全場面）

## クレジット

- Live2D Cubism Core — © Live2D Inc.（Live2D Proprietary Software License）
- 同梱モデル・音声「ハル」— Live2D Inc. サンプルデータ
- Electron / PixiJS / pixi-live2d-display / adm-zip — MIT License
- VOICEVOX は同梱していません。音声を公開する場合は「VOICEVOX:キャラ名」の表記が必要です。
