# コーディング規約

この文書は Amime の開発ルールをまとめたものです。機械的に検査できるルールは Lint・型・CI に実装してあり、各項目の末尾に **[検査: …]** として検査手段を書いています。検査のないルールはレビューで確認します。

## 1. 判断の優先順位と矛盾の解き方

情報どうしが食い違ったときは、次の順で上にあるものを正とします。

1. 法的・安全上の制約([ADR-0002](adr/0002-scope-and-non-goals.md))
2. ユーザーストーリーの受け入れ基準([user-stories](user-stories/README.md))
3. ADR([adr](adr/))
4. テスト
5. コード
6. コメント・README

矛盾を見つけたら、次の手順で解消します。

1. **下位を直す。** コードがテストと食い違えばコードを、テストがADRと食い違えばテストを直します。
2. **上位が誤りなら、上位を明示的に変える。** 黙って逸脱しません。ADRは書き換えず、新しいADRで置き換えます。採用後のADRで変えてよいのは「状態」の行だけで、置き換えや一部変更をしたADRへのリンクをそこに書きます([ADR-0011](adr/0011-adr-status-line.md))。
3. **誰が決めるかを可逆性で分ける。** 後から戻せる技術判断は開発者(オーナー)が決めてADRに残します。費用・公開範囲・外部アカウント・法務に関わる判断は、プロダクトの依頼者に確認します。
4. **決着を検査に落とす。** 決めた内容はテストか Lint ルールにして、同じ矛盾が再発しないようにします。

ツールどうしの規則が衝突した場合は、型検査 > Lint > 整形 の順で優先します。意味に関わる規則ほど上です。例: `process.env["X"]` の書き方について Biome の `useLiteralKeys` と tsc の `noPropertyAccessFromIndexSignature` が衝突するため、Biome 側を無効にしています。

## 2. ディレクトリ構成

```
apps/web/                 デプロイ単位(1つの Worker = SPA + API + Durable Object)
  src/client/             React のSPA
    app/                  アプリの枠(ルーティング、レイアウト)
    features/<機能>/      機能ごとの画面とロジック
  src/server/             Worker
    index.ts              Worker の入口
    app.ts                HTTP API(Hono)。大きくなったら routes/ に分ける
    durable-objects/      Durable Object
packages/                 実行環境に依存しない純粋なロジック
  shared/                 共通の型と小さな関数
  parser/                 記法の解析
  editor-core/            エディタのモデル(行・カーソル・コマンド)
  sync/                   変更の表現と適用(クライアントとサーバーで共用)
e2e/                      ブラウザを使う結合テスト(Playwright)
scripts/                  リポジトリ運用のスクリプト(lib/ にロジック、直下に実行入口)
docs/                     ADR、ユーザーストーリー、規約
```

### 依存の向き

```
apps/web/src/client ─┐
                     ├─→ packages/* ─→ packages/shared
apps/web/src/server ─┘
```

- `packages/*` は `apps/*` に依存しません。React、Hono、`cloudflare:*`、`node:*` も読み込みません。**[検査: Biome `noRestrictedImports`]**
- `packages/*` では DOM と Workers のAPIを使いません。ブラウザと Workers の両方で動かすためです。**[検査: tsconfig の `lib` と `types` に含めないため型エラーになる]**
- `client` と `server` は互いを読み込みません。共有したい型やロジックは `packages/` に置きます。**[検査: Biome `noRestrictedImports`]**
- パッケージ間の依存は `package.json` に宣言したものだけです。**[検査: pnpm の厳格な node_modules と knip]**
- 判断に迷うロジックは、まず `packages/` に純粋関数として書きます。UIと保存先は、それを呼ぶ薄い層にします。

## 3. TypeScript

- `strict` に加えて `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` などを有効にしています([tsconfig.base.json](../tsconfig.base.json))。**[検査: tsc]**
- `any`、non-null アサーション(`!`)、`enum`、`namespace` は使いません。**[検査: Biome]**
- 型アサーション(`as`)は、ブランド型の生成と外部データの境界に限ります。
- インポートには拡張子 `.ts` / `.tsx` を付け、型だけのインポートは `import type` にします。**[検査: tsc, Biome]**
- default export は使いません。フレームワークが要求する設定ファイルと Worker の入口だけが例外です。**[検査: Biome]**
- 関数は入力を書き換えず、新しい値を返します。データの型は `readonly` で宣言します。
- IDなど取り違えやすい文字列はブランド型にします(例: `LineId`、`TitleLc`)。

## 4. 命名

| 対象               | 規則                           | 例               |
| ------------------ | ------------------------------ | ---------------- |
| ファイル           | kebab-case **[検査: Biome]**   | `line-view.tsx`  |
| 型だけのファイル   | `types.ts` または `*.types.ts` | `types.ts`       |
| テスト             | 実装の隣に `*.test.ts(x)`      | `indent.test.ts` |
| 型・コンポーネント | PascalCase                     | `LineView`       |
| 関数・変数         | camelCase                      | `parseIndent`    |
| 定数               | UPPER_SNAKE_CASE               | `SAMPLE_LINES`   |
| Durable Object     | `<役割>DO`                     | `PageDO`         |

識別子は英語、コメントとテスト名とドキュメントは日本語で書きます。コメントには「何をしているか」ではなく「なぜそうしているか」を書きます。

## 5. エラー処理

- **想定内の失敗**(入力の不備、競合、見つからない)は `Result` 型で返します。例外にしません。
- **不変条件の違反**(呼び出し側のバグでしか起きない状態)は `invariant()` で例外にします。捕捉して続行しません。
- `console` は使いません。ログの方針は P2 でADRにします。**[検査: Biome `noConsole`]**

## 6. テスト

### テスト先行(TDD)

1. **Red**: 振る舞いを表すテストを書き、失敗することを確認します。
2. **Green**: テストを通す最小限の実装を書きます。
3. **Refactor**: テストを通したまま整理します。

CIは次の3点を検査します。

- 変更した実装ファイルの隣に、対応するテストファイルがあること。**[検査: `pnpm check:tdd`]**
- 種別が `feat` / `fix` のPRが、テストの変更を含むこと。**[検査: `pnpm check:tdd`]**
- `packages/*` と `scripts/lib` のカバレッジが 100%、`client` が 80% 以上であること。**[検査: `pnpm test:coverage`]**

テスト対象外になるのは、振る舞いを持たないファイル(`index.ts`、`types.ts`、`*.types.ts`、`*.d.ts`)と起動コード(`main.tsx`)だけです。

「先に書いたか」という順序そのものは機械では検査できません。上の3点は、テストなしで実装が入ることを防ぐための代用です。

### 書き方

- テスト名は、利用者から見た振る舞いを日本語の文で書きます(例: 「インデントされた行では、新しい行が同じインデントを引き継ぐ」)。
- 1つのテストで確かめる振る舞いは1つにします。準備・実行・検証を空行で区切ります。
- 実装の内部構造ではなく、公開している入出力を検証します。
- 「どんな入力でも成り立つ性質」は fast-check のプロパティテストで書きます(例: 差分を適用すると必ず目的の状態になる)。同期と解析では必須です。
- `.only` と `.skip` はコミットしません。**[検査: Biome]**

### どの層で何を確かめるか

| 層             | 場所                  | 実行環境             | 確かめること                                         |
| -------------- | --------------------- | -------------------- | ---------------------------------------------------- |
| 単体           | `packages/*`          | Node                 | 記法、エディタの操作、同期の規則。仕様のほぼすべて   |
| コンポーネント | `apps/web/src/client` | Node + jsdom         | 表示と操作の結び付き                                 |
| サーバー       | `apps/web/src/server` | workerd              | APIの応答、Durable Object の保存と復元               |
| E2E            | `e2e/`                | 実ブラウザ + workerd | 利用者の主要な流れが端から端まで動くこと(少数に絞る) |

## 7. サーバー(Workers / Durable Objects)

- Cloudflare の操作は `cf` CLI と `cloudflare.config.ts` で行います。Wrangler の設定ファイルは追加しません([ADR-0003](adr/0003-platform-cloudflare.md))。
- Durable Object は「調整が必要な最小単位」ごとに1インスタンスにします(1ページ = 1 `PageDO`)。全体で1つのインスタンスは作りません。
- 正となるデータは常に SQLite に置きます。メモリ上の値はキャッシュとして扱い、先に保存してから更新します。
- 関連する複数の書き込みは `transactionSync` でまとめ、途中に `await` を挟みません。
- Durable Object は RPC メソッドで呼びます。`fetch` ハンドラは WebSocket の受け口にだけ使います。
- テストでは、テストごとに別の名前のインスタンスを使います。

## 8. クライアント

- 画面とそのロジックは `features/<機能>/` に機能ごとにまとめます。
- コンポーネントは表示に専念させ、判断は `packages/` の純粋関数に任せます。
- 色や寸法はCSS変数で定義します。デザインは独自のもので、他サービスのCSSや画像は複製しません([ADR-0002](adr/0002-scope-and-non-goals.md))。

## 9. コミットとPR

- コミットとPRタイトルは Conventional Commits 形式にします。**[検査: commitlint]**
  - 形式: `種別(スコープ): 件名`。例: `feat(parser): 内部リンクを解析する`
  - 種別: `feat` `fix` `refactor` `perf` `test` `docs` `chore` `ci` `build` `style` `revert`
  - スコープ: `shared` `parser` `editor-core` `sync` `web` `e2e` `ci` `docs` `deps` `repo`
- `main` へは必ずPR経由でマージし、squash merge にします。PRタイトルがそのままコミットになります。
- **CIがすべて通ったPRは、開発者(オーナー)がそのままマージしてよい**(依頼者の了承、2026-11-12)。Dependabot の依存更新のPRも同じ扱いにします。
- レビューボット(CodeRabbit など)の指摘は、マージの前にすべて仕分けします。
  - 正しく、小さく直せるもの: そのPRで直す。
  - 正しいが大きいもの: Issue にして、指摘に Issue へのリンクを返信する。
  - 当たらないもの: 理由を返信して見送る。
- 1つのPRは1つのユーザーストーリー(またはその一部)に対応させ、小さく保ちます。
- 設計判断を伴う変更は、同じPRでADRを追加します。

## 10. よく使うコマンド

| コマンド                      | 内容                                |
| ----------------------------- | ----------------------------------- |
| `pnpm dev`                    | 開発サーバーを起動                  |
| `pnpm test:watch`             | 単体テストを監視実行(TDDの基本)     |
| `pnpm test:server`            | サーバーのテストを workerd 上で実行 |
| `pnpm lint:fix`               | Lint と整形を自動修正               |
| `pnpm check`                  | CIと同じ検査を一通り実行(E2Eを除く) |
| `pnpm build && pnpm test:e2e` | E2Eテストを実行                     |
