# デプロイと、リポジトリの初期設定

`main` に入った変更は、検査を通ったあと、Cloudflare の本番へ自動で出ます([ADR-0037](adr/0037-ci-and-deploy-workflows.md))。最初は無効になっているので、この文書の手順で有効にします。

> ワークフローは、手元で確かめられるところまで(ビルド、`cf deploy --dry-run`、各手順のシェル)しか確かめていません。**実際の Cloudflare アカウントへのデプロイは、まだ一度も行っていません**(2026-11-14 時点)。最初の実行で問題が出たら、この文書とワークフローを直してください。

## ワークフロー

| ファイル                       | いつ動くか                   | すること                                                              |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------- |
| `.github/workflows/ci.yml`     | PRを出したとき、更新したとき | 検査(lint、型、未使用コード、テスト先行、単体、サーバー、ビルド、E2E) |
| `.github/workflows/deploy.yml` | `main` に入ったとき、手動    | 同じ検査を `main` の内容で行い、通ったら、本番へデプロイする          |

本番へのデプロイは、次の順に進みます。

1. Cloudflare に入るための値(APIトークン、アカウントID)が、登録されているかを確かめる。なければ、ここで止まる。
2. 本番用にビルドし、開発用のログインが無効になっていることを確かめる。
3. `cf deploy --prebuilt --mode production` で出す。どのコミットを出したかが、Cloudflare の側でも分かるように、印(コミットの先頭12文字)と件名を付ける。
4. 本番のURL(`APP_URL`)の `/api/health` が応えるかを確かめる。

Actions の画面で `Deploy` を選び、「Run workflow」を押すと、手動で出し直せます(シークレットを登録し直したあとなど)。

## 1. ブランチ保護(推奨)

GitHub の Settings → Branches(または Rulesets)で、`main` に次を設定します。

- PRを必須にする
- 次のステータスチェックを必須にする
  - `規約(lint / 型 / 未使用コード / テスト先行)`
  - `単体テストとカバレッジ`
  - `サーバーのテスト(Workers ランタイム)`
  - `ビルドとデプロイ検証(dry-run)`
  - `E2Eテスト`
- マージ方法を squash merge のみにする(PRタイトルがコミットになるため)

## 2. Cloudflare へのデプロイを有効にする

1. Cloudflare のダッシュボードで、APIトークンを作ります。Workers のスクリプトと、D1 を編集できる権限が要ります(「Edit Cloudflare Workers」のひな形に、アカウントの「D1: Edit」を足す)。
2. GitHub の Settings → Secrets and variables → Actions で、次を登録します。

   | 種類     | 名前                    | 値                        |
   | -------- | ----------------------- | ------------------------- |
   | Secret   | `CLOUDFLARE_API_TOKEN`  | 作成したAPIトークン       |
   | Secret   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウントID |
   | Variable | `DEPLOY_ENABLED`        | `true`                    |

3. (任意)Settings → Environments で `production` を作り、承認者を設定すると、本番デプロイの前に承認を挟めます。

D1 のデータベース(`amime`)は、最初のデプロイで、自動で作られます(`cf deploy` の `--provision` は、既定で有効)。利用者とログインの状態の表は、Worker が、最初の要求のときに作ります。

> 必要な権限は、`cf` の公式文書([CI での使い方](https://developers.cloudflare.com/cf/ci/))で確かめてください。この文書を書いたときは、公式文書を開けず、Wrangler での経験から書いています。権限が足りなければ、デプロイのログに、足りない権限が出ます。

## 3. ログインとプロジェクトの設定(シークレット)

ログインと、プロジェクトの作成には、次の3つの値が要ります。値は、リポジトリに入れず、Worker のシークレットとして渡します。

| 名前                   | 値                                                                                                 | ないとき                         |
| ---------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- |
| `GOOGLE_CLIENT_ID`     | Google Cloud の OAuth クライアントのID                                                             | Google でログインできない        |
| `GOOGLE_CLIENT_SECRET` | 同じクライアントのシークレット                                                                     | Google でログインできない        |
| `PROJECT_CREATORS`     | プロジェクトを作ってよい人のメールアドレス(カンマ区切り)。`*` なら、ログインしていれば誰でも作れる | **誰も、プロジェクトを作れない** |

1. Google Cloud のコンソールで、OAuth クライアント(種類は「ウェブ アプリケーション」)を作ります。「承認済みのリダイレクト URI」に、`https://(本番のドメイン)/api/auth/callback/google` を登録します。手元で試すなら、`http://localhost:5173/api/auth/callback/google` も登録します。
2. GitHub の Settings → Secrets and variables → Actions に、上の3つを Secret として登録します。本番デプロイが、これをシークレットのファイルにして、`cf deploy --secrets-file` で渡します。
3. 登録したら、`Deploy` を手動で動かして、出し直します(シークレットは、デプロイのときに Worker へ渡るため)。
4. 最初のプロジェクトは、`PROJECT_CREATORS` に入れた人が、ログインして、トップで作ります。

なくてもデプロイはできます(そのときは、ワークフローに注意が出ます)。Google でのログインの設定が済むまでは、誰もログインできないので、公開環境では何も読み書きできません。

手元で Google でのログインを試すときは、`apps/web/.dev.vars.example` を `.dev.vars` という名前で写して、値を入れます。値がなければ、開発用のログイン(名前を入れるだけ)だけが使えます。

> この節の手順は、実際の Google アカウントと Cloudflare では、まだ確かめていません(2026-11-14 時点)。

## 4. 本番のURL

最初のデプロイが済むと、`https://amime.(アカウントのサブドメイン).workers.dev` で開けます(Cloudflare のダッシュボードの、Worker の画面に出ます)。

- このURLを、リポジトリ変数 `APP_URL` に入れます(例: `https://amime.example.workers.dev`)。デプロイのたびに、`/api/health` が応えるかを確かめるようになります。
- Google のリダイレクト URI(3 の 1)も、このURLで登録します。
- 自分のドメインで出すときは、`apps/web/cloudflare.config.ts` の `worker` に `domains: ["notes.example.com"]` を足します(ドメインは、同じ Cloudflare アカウントで管理しているもの)。`APP_URL` と、Google のリダイレクト URI も、そのドメインに変えます。

## 5. プレビュー環境(任意。既定では無効)

リポジトリ変数 `PREVIEW_ENABLED` を `true` にすると、PRの検査が通ったあと、ブランチ名のプレビュー環境にデプロイします(`cf previews deploy`)。フォークと Dependabot のPRは、対象外です。

既定では無効にしています。

- プレビュー環境では、ログインできません。Google は、登録したリダイレクトURIにしか戻さないためです([ADR-0032](adr/0032-login-and-sessions.md))。見られるのは、ログインしていないときの画面だけです。
- プレビューが、本番と同じデータ(D1、Durable Object)につながるかどうかを、確かめていません。
- 閉じたPRのプレビューを消す仕組みは、ありません(`cf previews delete` で、手で消します)。

## 6. 手元からデプロイする

```sh
pnpm --filter @amime/web exec cf auth login
pnpm build
# シークレットを、JSON か .env の形のファイルで渡す(ファイルは、リポジトリに入れない)。
pnpm --filter @amime/web exec cf deploy --prebuilt --mode production --secrets-file ../../secrets.json
```

## 注意

- ページを読み書きできるのは、権限のある人だけです。権限は、要求のたびに確かめます([ADR-0033](adr/0033-projects-and-access.md))。
- Durable Object のクラスを削除・改名するときは、`cloudflare.config.ts` の `exports` に状態(`deleted` / `renamed`)を残す必要があります。Cloudflare の文書で手順を確認してから行ってください。
- デプロイを前のバージョンに戻しても、Durable Object や D1 のデータは戻りません。保存形式を変える変更は、古い形式も読めるようにしてからデプロイします。
- 開発用のログイン(名前を入れるだけでログインできる)は、手元での開発と自動テストでだけ使えます。デプロイした環境では無効です([ADR-0032](adr/0032-login-and-sessions.md))。
