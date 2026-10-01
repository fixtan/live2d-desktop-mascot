# Live2D Desktop Mascot

VS Code のウィンドウ内に常駐する Live2D / VRM デスクトップマスコット（Windows / macOS / Linux）。

<img src="docs/screenshot.webp" width="300" alt="VS Code のエラーに反応するマスコット">

- VS Code の枠内に留まる（キャラごとに切り替え。オフなら自由に動かせる）
- VS Code 拡張と連携して、保存・エラーの増減・デバッグ開始・タスクの成否に反応
- マウスを目で追う・クリック／ダブルクリックで反応・時報・独り言
- キャラ以外の透明部分はクリックが下のアプリに抜ける
- Live2D（Cubism 3 / 4）と VRM（0.x / 1.0）に対応
- 複数のキャラを同時に表示（Live2D と VRM を混ぜても可）。同時にはしゃべらず順番に話す
- モデル切り替え（ZIP／フォルダ／.vrm 取り込み、モデルファイル直接指定）。設定ではサムネ付きの一覧から選べる
- VRM は VRMA モーション（待機・しぐさ）を使える。待機モーション2種を同梱
- ボイスパック（声と字幕とモーションの組み合わせ）
- 声：ボイスパック／VOICEVOX（キャラごとに話者を選べる。ボイスパックのセリフも読む）／ OS 標準音声／ミュート
- 音量に合わせた口パク（Live2D・VRM とも）

## ダウンロード

[Releases](../../releases) から

- `live2d-desktop-mascot-x.x.x-setup.exe` … Windows インストーラー
- `live2d-desktop-mascot-x.x.x-portable.exe` … Windows インストール不要版

- `live2d-desktop-mascot-x.x.x-mac-arm64.dmg` … Mac（Apple Silicon）
- `live2d-desktop-mascot-x.x.x-mac-x64.dmg` … Mac（Intel）

- `live2d-desktop-mascot-x.x.x-linux-x86_64.AppImage` … Linux（どのディストリでも）
- `live2d-desktop-mascot-x.x.x-linux-amd64.deb` … Debian / Ubuntu

- `live2d-mascot-bridge-x.x.x.vsix` … VS Code 拡張（連携用。なくてもマスコット単体で動きます）

> **Windows**：署名していないため「Windows によって PC が保護されました」と表示されます。「詳細情報」→「実行」で起動できます。
>
> **macOS**：署名・公証していないため初回は開けません。「システム設定」→「プライバシーとセキュリティ」→「このまま開く」で起動できます。
> 「壊れているため開けません」と出る場合はターミナルで `xattr -cr "/Applications/Live2D Desktop Mascot.app"` を実行してください。
> macOS では VS Code 追従は使えません（自由に動かせます）。常駐アイコンはメニューバーに出ます。
>
> **Linux**：deb は `sudo apt install ./live2d-desktop-mascot-x.x.x-linux-amd64.deb`。
> AppImage は `chmod +x` してから実行してください（起動しない環境では `--no-sandbox` を付ける）。
> VS Code 追従は使えません（自由に動かせます）。
> GNOME ではトレイアイコンの表示に AppIndicator 拡張が必要です。Wayland ではウィンドウの位置や最前面表示が効かないことがあります。

### VS Code 拡張

`.vsix` を VS Code の拡張機能ビュー「…」→「VSIX からのインストール…」で入れるか、`code --install-extension live2d-mascot-bridge-x.x.x.vsix`。
マスコットが起動していれば自動でつながり、ステータスバーに `♡ Mascot` が出ます。WSL・リモート接続のウィンドウでも使えます。

## 使い方

| 操作 | 動作 |
|---|---|
| ドラッグ | 移動 |
| クリック | 反応（声・しぐさ） |
| ダブルクリック | 挨拶＋時刻 |
| Ctrl＋ホイール | サイズ変更 |
| 右クリック | そのキャラの設定（モデル・声・話者・視線追従・ランダムイベント・時報・VS Code 追従）、設定ウィンドウ、隠す、終了 |
| タスクトレイ | 表示／非表示・位置リセット・終了 |

設定は別ウィンドウで開きます（移動でき、位置は次回も同じ）。「見た目／声／ふるまい」はキャラごと、一番下の「全キャラ共通」はライブラリとモーションの置き場所です。

### 声

| 話し方 | クリック・ランダム（ボイスパックのセリフ） | ひとこと・時報・VS Code への反応 |
|---|---|---|
| ボイスパックだけ | ボイスパックの声 | 字幕だけ |
| VOICEVOX | そのキャラの話者で読む | そのキャラの話者で読む |
| ボイスパック＋OS 音声 | ボイスパックの声 | OS の読み上げ |
| ミュート | 字幕だけ | 字幕だけ |

VOICEVOX は起動していれば使います。起動していない時はボイスパックの声（自作セリフは OS の読み上げ）に戻ります。

### 複数キャラ

設定ウィンドウの一番上の「キャラ」欄の＋でキャラを追加、−で削除します。どのキャラの設定を表示するかもここで選びます。

- モデル・声・話者・ボイスパック・サイズ・VS Code 追従などはキャラごと。位置もキャラごとに覚えて、次の起動で同じ場所に出ます
- VS Code のイベントと時報には代表（1番目のキャラ）だけが反応します
- 同時にはしゃべりません。独り言・時報・VS Code への反応は、ほかのキャラが話し中なら見送り、クリックや「話しかける」は割り込みます
- モデルのライブラリ・モーションは全キャラ共通です
- トレイの「表示 / 非表示」「位置をリセット」は全キャラ、右クリックメニューの「隠す」はそのキャラだけに効きます
- 以前の版の設定は、最初の起動で1体目に引き継がれます

キャラ1体ごとに描画の負荷が増えます。GPU の無い環境では1体（Live2D、または軽い VRM）での利用をおすすめします。

<img src="docs/screenshot-setting.webp" width="300" alt="設定画面">

モデルの ZIP・フォルダ・`.vrm` をキャラの上にドロップすると取り込んで、そのキャラに使います（設定の「取り込む…」でも同じ）。日本語のファイル名を含む ZIP（Windows で作ったもの・Mac で作ったもの）も取り込めます。
取り込んだモデルは設定フォルダ（下記）の `models/` に保存されます。同じ名前のモデルは上書きします。

### サムネ

設定ウィンドウのモデル一覧には、VRM に埋め込まれたサムネが出ます。無いモデル（Live2D など）は頭文字です。
ライブラリのモデルは、一覧のタイルに画像（PNG・JPEG・WebP）をドロップするとサムネを付けられます（`models/<名前>/thumb.*` に保存。埋め込みより優先、取り込み直しても残ります）。
VRM のサムネは [VRM Thumbnail Editor](https://lain-lab.com/featured/vrm-thumbnail-editor/) でも埋め込めます。

対応モデル：

| 形式 | ファイル | 取り込み |
|---|---|---|
| Live2D Cubism 3 / 4 | `.model3.json` | ZIP・フォルダ（`.model3.json` を直接ドロップすると取り込まずに参照） |
| VRM 0.x / 1.0 | `.vrm` | `.vrm` 単体・ZIP |

Cubism 5.3 以降の形式（moc3 ver 6）はまだ読めません。

### VRM のモーション（VRMA）

`.vrma` をキャラの上にドロップすると、設定フォルダの `motions/` に入ります（複数まとめて可）。`.vrma` だけを入れた ZIP をドロップするとまとめて取り込めます（同じ名前は上書き）。モーションは全 VRM モデル共通です。

- 名前が `idle` で始まるもの（`idle.vrma`・`idle2.vrma`・`idle_sit.vrma` …）… 待機。1本終わるたびにランダムに切り替わる
- それ以外 … しぐさ。クリック・独り言・ボイスパックの `motion`（ファイル名の部分一致）で使う

`motions/` に待機が1本も無い時は、同梱の待機モーション（Idle・Idle1）を使います。自分の待機を入れるとそちらに切り替わります。
モーションの前後左右の移動は無視してその場で動きます（上下は残る）。
VRMA が無くても、手を下ろした立ち姿・呼吸・まばたき・視線追従・簡単なしぐさで動きます。

VRM は Live2D より重く、GPU の無い環境（リモートデスクトップ・仮想マシン）では動きがかくつくことがあります。


## 開発

```
npm install          # three の一部ファイルを src/renderer/vendor/ にコピーする処理も走る
npm start            # 起動
npm start -- --devtools # DevTools付き
npm run dist:win     # Windows版ビルド（dist/）
npm run dist:mac     # macOS版ビルド（Mac上で実行）
npm run dist:linux   # Linux版ビルド（Linux上で実行）
```

リポジトリには Live2D の再配布物を含めていません。以下を各自で配置してください。

- `vendor/live2dcubismcore.min.js` … [vendor/README.md](vendor/README.md) 参照
- `assets/haru/` … [ハル](https://www.live2d.com/learn/sample/) の `runtime/` の中身
- `assets/haru_greeter/` … [ハル（受付）](https://www.live2d.com/learn/sample/) の `runtime/` の中身

### 構成

```
src/main/main.js            メインプロセス（キャラごとのウィンドウ・トレイ・IPC・話す順番）
src/main/characters.js      characters.json（キャラの一覧・キャラごとの設定と位置）
src/main/library.js         モデルライブラリ（取り込み・一覧・削除。同名は上書き）
src/main/thumbs.js          サムネ（thumb.* → VRM の埋め込み）
src/main/motions.js         VRMA モーションの置き場所（取り込み・一覧。同梱分と合わせる）
src/main/config.js          config.json の読み込み（既定値の補完）
src/main/bridge.js          WebSocket サーバー（VS Code 拡張との連携）
src/main/tracker/           VS Code位置追跡（OS別。現在 win32 のみ）
src/renderer/app.js         吹き出し・イベント・設定の反映・入力・音声
src/renderer/settings.*     設定ウィンドウ（操作を送り、状態を受け取って表示するだけ）
src/renderer/adapters/      描画アダプタ（live2d.js：PixiJS、vrm.js：three.js。同じメソッドを持つ）
src/shared/formats.js       対応するモデル形式の一覧（形式を増やす時はここに足してアダプタを置く）
src/shared/motions.js       モーションの役割（待機・しぐさ）の決め方
scripts/copy-three-addons.js three の GLTFLoader などを vendor/ にコピー（ビルドに examples が入らないため）
assets/<モデル>/            同梱モデル
assets/motions/             同梱の VRMA（待機）
assets/voices/<名前>/       ボイスパック
vendor/                     Cubism Core
scripts/bridge-send.js      連携のテスト送信
docs/                       README 用の画像
vscode-extension/           VS Code 拡張（Live2D Mascot Bridge）
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
- `on`: 使う場面（`click` / `idle`、連携イベントは下記。省略で click / idle の全場面）

### VS Code 連携（WebSocket）

VS Code 拡張などから、保存・エラー・タスク結果などのイベントを受け取って反応します。
VS Code 側の拡張は [vscode-extension/](vscode-extension/) にあります。

設定フォルダ（トレイの「📂 設定フォルダを開く」）

| OS | 場所 |
|---|---|
| Windows | `%APPDATA%\Live2D Desktop Mascot\` |
| macOS | `~/Library/Application Support/Live2D Desktop Mascot/` |
| Linux | `~/.config/Live2D Desktop Mascot/` |

- `characters.json`：キャラの一覧とキャラごとの設定・位置。アプリが書く（手で編集する場合は終了してから）
- `config.json`：ユーザーが編集する設定。変更は再起動で反映
  ```json
  { "configVersion": 1, "bridge": { "enabled": true, "port": 0 } }
  ```
  `port` が `0` なら空きポートを自動で使う。番号を書くとそのポートを使う（使用中なら自動に切り替え）
- `bridge.json`：起動時にアプリが書き出す接続情報。終了時に削除される。クライアントはこれを読む
  ```json
  { "v": 1, "host": "127.0.0.1", "port": 53811, "token": "…", "pid": 1234, "version": "1.2.0" }
  ```

接続：`ws://127.0.0.1:<port>/?token=<token>`。127.0.0.1 のみで待ち受け、Origin ヘッダー付き（ブラウザ）の接続は拒否します。接続すると `welcome` が返ります。

メッセージ：`{ "v": 1, "type": "...", "payload": { ... }, "ts": 1759110000000 }`

| type | payload | 反応 |
|---|---|---|
| `save` | `{ file?, languageId? }` | ときどき（最短45秒おき） |
| `diagnostics` | `{ errors, warnings }` | エラーが増えた時・0件になった時。変化のたびに送ってよい（接続直後の1回目は基準値として扱う） |
| `debugStart` | `{ name? }` | デバッグ開始 |
| `taskEnd` | `{ name, exitCode }` | 成功／失敗（`exitCode` が無ければ無反応） |
| `say` | `{ text }` | そのまましゃべる（200文字まで） |
| `ping` | — | `pong` を返す |

キャラが複数いる時は、代表（1番目）のキャラが反応します。

ボイスパックの `on` に `save` / `error` / `fixed` / `debug` / `taskOk` / `taskFail` / `connect` を書くと、その場面ではセリフの代わりにその声を使います。

テスト送信：

```
node scripts/bridge-send.js say テストだよ
node scripts/bridge-send.js diagnostics errors=0 errors=3 errors=0
node scripts/bridge-send.js taskEnd name=build,exitCode=1
```

## クレジット

- Live2D Cubism Core — © Live2D Inc.（Live2D Proprietary Software License）
- 同梱モデル・音声「ハル」— Live2D Inc. サンプルデータ
- 同梱モーション「Idle」「Idle1」— lain（本リポジトリと同じ MIT License）
- Electron / PixiJS / pixi-live2d-display / three.js / @pixiv/three-vrm / @pixiv/three-vrm-animation / adm-zip / ws — MIT License
- VRM モデルは同梱していません。各モデルの利用条件に従って使ってください。
- VOICEVOX は同梱していません。音声を公開する場合は「VOICEVOX:キャラ名」の表記が必要です。
