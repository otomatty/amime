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

## 3. 手元からデプロイする

```sh
pnpm --filter @amime/web exec cf auth login
pnpm build
pnpm --filter @amime/web exec cf deploy --prebuilt --mode production
```

## 注意

- 認証(P4)が入るまで、書き込みできるAPIを公開環境に置きません([ADR-0009](adr/0009-auth-and-access.md))。
- Durable Object のクラスを削除・改名するときは、`cloudflare.config.ts` の `exports` に状態(`deleted` / `renamed`)を残す必要があります。Cloudflare の文書で手順を確認してから行ってください。
- デプロイを前のバージョンに戻しても、Durable Object や D1 のデータは戻りません。保存形式を変える変更は、古い形式も読めるようにしてからデプロイします。
- ログインの仕組み(P4)ができるまで、デプロイした環境ではページの保存と読み込みが無効です(`/api/pages/*` は、WebSocket の接続も含めて 403 を返します)。有効になるのは、手元での開発とテストだけです([ADR-0017](adr/0017-page-storage-and-api.md))。
