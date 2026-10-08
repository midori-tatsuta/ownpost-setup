# OwnPost（オウンポスト）

X・X記事・Threads・Instagram・Facebookページに予約投稿できる、自分専用のツールです。
このリポジトリは、OwnPostをあなたのCloudflareに設置・更新するためのものです。

- 設置と更新：「Actions」→「OwnPostを設置・更新」→「Run workflow」
- 必要な設定（「Settings」→「Secrets and variables」→「Actions」→「Secrets」）
  - `OWNPOST_KEY`：購入者コード（Brainの記事に書かれています）
  - `CLOUDFLARE_API_TOKEN`：CloudflareのAPIトークン
  - `CLOUDFLARE_ACCOUNT_ID`：CloudflareのアカウントID
  - `ADMIN_PASSWORD`：管理画面のパスワード（8文字以上）
  - `ENCRYPTION_KEY`：暗号化の合言葉（20文字以上。あとから変えないでください）
- 毎週自動で更新したいとき：「Variables」に `AUTO_UPDATE` = `true` を追加

このリポジトリは**非公開（Private）**にしてください。設置すると `app/` にOwnPostのコードが入ります。
`app/` を改造しても、更新のときにあなたの変更は残ります（新しい版と同じ場所を変えていた場合は、プルリクエストで知らせます）。

詳しい手順は、購入したBrainの記事にあります。
