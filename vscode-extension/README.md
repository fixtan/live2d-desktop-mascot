# Live2D Mascot Bridge

[Live2D Desktop Mascot](https://github.com/fixtan/live2d-desktop-mascot) に VS Code のイベントを送る拡張です。マスコットが起動していれば自動で接続し、終了・再起動しても自動でつなぎ直します。

| イベント | 送る内容 |
|---|---|
| ファイル保存 | `save`（ファイル名・言語） |
| エラー・警告数の変化 | `diagnostics`（1.5 秒デバウンス、変化した時だけ） |
| デバッグ開始 | `debugStart` |
| タスク終了 | `taskEnd`（名前・exit code） |

ステータスバーの `♡ Mascot` が接続中、`Mascot`（切断アイコン）が待機中。クリックで再接続。

コマンド

- `Live2D Mascot: 再接続`
- `Live2D Mascot: しゃべらせる…`

設定

- `live2dMascot.enabled` … 送信のオン／オフ
- `live2dMascot.bridgeFile` … `bridge.json` の場所（空なら既定）
- `live2dMascot.events` … 送るイベントの種類（`save` / `diagnostics` / `debug` / `task`）

VS Code 1.101 以降（Node 22 の標準 WebSocket を使うため、依存パッケージなし）。

## 開発・インストール

```
# 試す：リポジトリのルートを VS Code で開いて F5（「VS Code 拡張を実行」→ 拡張機能開発ホストが開く）

# インストール
npx @vscode/vsce package
code --install-extension live2d-mascot-bridge-0.1.0.vsix
```
