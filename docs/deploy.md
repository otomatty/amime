# デプロイと、リポジトリの初期設定

CIのデプロイは、最初は無効になっています。この文書の手順で有効にします。

> この手順のうち、GitHub Actions 上での実行と、実際の Cloudflare アカウントへのデプロイは、まだ一度も実行していません(2026-11-12 時点)。ローカルでは、ビルドと `cf deploy --dry-run` までを確認済みです。最初の実行で問題が出た場合は、この文書とワークフローを直してください。

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

1. Cloudflare のダッシュボードで、Workers を編集できる権限のAPIトークンを作ります。
2. GitHub の Settings → Secrets and variables → Actions で、次を登録します。

   | 種類     | 名前                    | 値                        |
   | -------- | ----------------------- | ------------------------- |
   | Secret   | `CLOUDFLARE_API_TOKEN`  | 作成したAPIトークン       |
   | Secret   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare のアカウントID |
   | Variable | `DEPLOY_ENABLED`        | `true`                    |

3. (任意)Settings → Environments で `production` を作り、承認者を設定すると、本番デプロイの前に承認を挟めます。

有効にすると、次のように動きます。

- PR: 検査がすべて通ると、ブランチ名のプレビュー環境にデプロイします(フォークからのPRは対象外)。
- `main`: 検査がすべて通ると、本番にデプロイします。

## 3. ログインとプロジェクトの設定(シークレット)

ログインと、プロジェクトの作成には、次の3つの値が要ります。値は、リポジトリに入れず、Worker のシークレットとして渡します。

| 名前                   | 値                                                                                                 | ないとき                         |
| ---------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- |
| `GOOGLE_CLIENT_ID`     | Google Cloud の OAuth クライアントのID                                                             | Google でログインできない        |
| `GOOGLE_CLIENT_SECRET` | 同じクライアントのシークレット                                                                     | Google でログインできない        |
| `PROJECT_CREATORS`     | プロジェクトを作ってよい人のメールアドレス(カンマ区切り)。`*` なら、ログインしていれば誰でも作れる | **誰も、プロジェクトを作れない** |

1. Google Cloud のコンソールで、OAuth クライアント(種類は「ウェブ アプリケーション」)を作ります。「承認済みのリダイレクト URI」に、`https://(本番のドメイン)/api/auth/callback/google` を登録します。手元で試すなら、`http://localhost:5173/api/auth/callback/google` も登録します。
2. GitHub の Settings → Secrets and variables → Actions に、上の3つを Secret として登録します。CIの本番デプロイが、これをシークレットのファイルにして、`cf deploy --secrets-file` で渡します。
3. 最初のプロジェクトは、`PROJECT_CREATORS` に入れた人が、ログインして、トップで作ります。

プレビュー環境(PRごとのURL)では、ログインできません。Google は、登録したリダイレクトURIにしか戻さないためです([ADR-0032](adr/0032-login-and-sessions.md))。

手元で Google でのログインを試すときは、`apps/web/.dev.vars.example` を `.dev.vars` という名前で写して、値を入れます。値がなければ、開発用のログイン(名前を入れるだけ)だけが使えます。

> この節の手順は、実際の Google アカウントと Cloudflare では、まだ確かめていません(2026-11-14 時点)。

## 4. 手元からデプロイする

```sh
pnpm --filter @amime/web exec cf auth login
pnpm build
# シークレットを、JSON か .env の形のファイルで渡す(ファイルは、リポジトリに入れない)。
pnpm --filter @amime/web exec cf deploy --prebuilt --mode production --secrets-file ../../secrets.json
```

## 注意

- ページを読み書きできるのは、権限のある人だけです。権限は、要求のたびに確かめます([ADR-0033](adr/0033-projects-and-access.md))。Google でのログインの設定(シークレット)が済むまでは、誰もログインできないので、公開環境では何も読み書きできません。
- Durable Object のクラスを削除・改名するときは、`cloudflare.config.ts` の `exports` に状態(`deleted` / `renamed`)を残す必要があります。Cloudflare の文書で手順を確認してから行ってください。
- デプロイを前のバージョンに戻しても、Durable Object や D1 のデータは戻りません。保存形式を変える変更は、古い形式も読めるようにしてからデプロイします。
- 開発用のログイン(名前を入れるだけでログインできる)は、手元での開発と自動テストでだけ使えます。デプロイした環境では無効です([ADR-0032](adr/0032-login-and-sessions.md))。
