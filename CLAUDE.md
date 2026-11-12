# Amime 開発ガイド(AIエージェント向け)

Cosense の記法と操作感を独自に再現する、Cloudflare Workers 上のリアルタイム共同編集ノート。あなたはこのプロジェクトのオーナーとして開発する。

## 最初に読むもの

1. `docs/conventions.md` — 規約。特に「判断の優先順位と矛盾の解き方」
2. `docs/feature-matrix.md` — いまの進み具合
3. `docs/user-stories/README.md` — 取り組むストーリーの受け入れ基準
4. `docs/adr/` — 関係する設計判断

## 進め方

- **テスト先行。** 失敗するテストを書く → 失敗を確認する → 最小の実装で通す → 整理する。実装ファイルの隣に `*.test.ts(x)` を置く。
- ロジックはまず `packages/` に純粋関数として書く。UIと保存先はそれを呼ぶ薄い層にする。
- 作業を終える前に `pnpm check` を通す。UIやAPIを変えたら `pnpm test:e2e` も通す。
- 機能を完了したら `docs/feature-matrix.md` の状態を更新する。
- 設計判断をしたら、同じ変更でADRを追加する。採用済みのADRは書き換えず、新しいADRで置き換える。
- 後から戻せる技術判断は自分で決めて記録する。費用・公開範囲・外部アカウント・法務に関わる判断は依頼者に確認する。

## 守ること

- 本家(Cosense)のソースコード・CSS・画像・文言を参照・複製しない。根拠は公開ヘルプと観察できる挙動に限る(ADR-0002)。
- Cloudflare の操作は `cf` CLI と `cloudflare.config.ts` で行う。Wrangler の設定ファイルを追加しない。`cf` はベータ版なので、コマンドや設定は記憶に頼らず `cf cli search "<やりたいこと>"` と `--help`、公式文書で確認する。
- 認証(P4)が入るまで、書き込みできるAPIを公開環境に置かない(ADR-0009)。
- Lint の規則を無効にするときは、理由をコメントに書く。テストを `.skip` / `.only` のままにしない。
- コミットとPRタイトルは Conventional Commits(例: `feat(parser): 内部リンクを解析する`)。件名は日本語。

## コマンド

| コマンド           | 内容                      |
| ------------------ | ------------------------- |
| `pnpm test:watch`  | 単体テストを監視実行      |
| `pnpm test:server` | サーバーのテスト(workerd) |
| `pnpm lint:fix`    | Lint と整形の自動修正     |
| `pnpm typecheck`   | 型検査                    |
| `pnpm check`       | CIと同じ検査(E2Eを除く)   |
| `pnpm test:e2e`    | E2Eテスト(E2E用にビルド)  |
