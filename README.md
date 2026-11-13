# Amime(網目)

行とリンクで知識をつなぐ、チーム向けのリアルタイム共同編集ノートです。Cloudflare Workers 上で動きます。

Helpfeel Cosense の記法と操作感を参考に、独自に実装しています。Helpfeel 社とは無関係の独立したプロジェクトで、同社の名称・デザイン・コードは使用していません([ADR-0002](docs/adr/0002-scope-and-non-goals.md))。

**現在の状態: P3(リンク・一覧・検索)まで完了。次は P4(認証とプロジェクト)。** 記法の表示と編集(P1)に加えて、ページを保存して読み込めます(`/ページ名` を開く)。同じページを開いている他の人の変更とカーソルは、その場で届きます。同じ行を同時に書き換えても、どちらの入力も残ります。通信が切れているあいだに書いたものは端末内に残り、つながったら送られます(P2)。トップにはページの一覧が並び、ページの下には関連するページが並びます。名前を変えると、そのページへのリンクも書き換わります。名前の一部や本文の言葉から、ページを探せます(P3)。ログインの仕組み(P4)ができるまで、保存と配信は手元の開発環境でだけ動き、公開環境では無効です。

## はじめる

Node.js 22.18 以上と pnpm が必要です。

```sh
pnpm install
pnpm dev          # 開発サーバー
pnpm test:watch   # 単体テストを監視実行
pnpm check        # CIと同じ検査を一通り実行(E2Eを除く)
```

E2Eテストは、ビルドしてから実行します。

```sh
pnpm --filter @amime/e2e exec playwright install chromium   # 初回のみ
pnpm test:e2e
```

## 構成

```
apps/web          デプロイ単位。SPA(src/client)と Worker(src/server)
packages/shared       共通の型と小さな関数
packages/parser       記法の解析
packages/editor-core  エディタのモデル
packages/sync         変更の表現と適用
e2e               ブラウザを使う結合テスト
scripts           リポジトリ運用のスクリプト
docs              規約、ADR、ユーザーストーリー
```

## ドキュメント

| 文書                                             | 内容                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| [docs/conventions.md](docs/conventions.md)       | コーディング規約、テストの書き方、矛盾の解き方 |
| [docs/user-stories](docs/user-stories/README.md) | ユーザーストーリーと受け入れ基準               |
| [docs/feature-matrix.md](docs/feature-matrix.md) | 機能一覧と再現度                               |
| [docs/adr](docs/adr/)                            | 設計判断の記録                                 |
| [docs/deploy.md](docs/deploy.md)                 | デプロイとリポジトリの初期設定                 |
