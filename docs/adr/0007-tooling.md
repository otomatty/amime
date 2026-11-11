# ADR-0007: 開発ツールの選定

- 状態: 採用(コンポーネントテストの実行環境は [ADR-0010](0010-editor-input.md) で jsdom に変更)
- 日付: 2026-11-11

## 決定

| 用途                 | ツール                      | 選んだ理由                                                             |
| -------------------- | --------------------------- | ---------------------------------------------------------------------- |
| パッケージ管理       | pnpm workspace              | 宣言していない依存を読み込めない厳格な node_modules になる             |
| 型検査               | TypeScript 7(`tsc`、strict) | `cf init` の標準構成と同じ版。検査が速く、フックやCIで毎回実行できる   |
| Lint と整形          | Biome                       | 1つのツールで Lint・整形・インポート整理を行え、設定の衝突が起きにくい |
| 未使用コードと依存   | knip                        | 使われていないファイル・export・依存を検出する                         |
| 単体テスト           | Vitest                      | Vite と設定を共有でき、監視実行が速い                                  |
| プロパティテスト     | fast-check                  | 同期と解析の「どんな入力でも成り立つ性質」を検証する                   |
| サーバーのテスト     | `@cloudflare/vitest-plugin` | 本番と同じランタイム(workerd)で Durable Object を動かせる              |
| コンポーネントテスト | Testing Library + happy-dom | 利用者から見える表示と操作で検証する                                   |
| E2E                  | Playwright                  | 実ブラウザで、ビルドした Worker に対して検証する                       |
| Gitフック            | lefthook                    | コミット前に整形、プッシュ前に型検査とテストを実行する                 |
| コミット規約         | commitlint                  | Conventional Commits を検査する                                        |
| 依存の更新           | Dependabot                  | npm と GitHub Actions の更新をPRで受ける                               |

## 検討した他の案

- **ESLint + Prettier**: 規則は豊富だが、設定とプラグインの組み合わせが増える。型情報を使う規則が必要になった場合は、その規則に限って追加を検討する。
- **dependency-cruiser による境界検査**: 依存の向きは Biome の `noRestrictedImports` と tsconfig の分離で検査できているため、ツールを増やさない。層が増えて表現しきれなくなったら導入する。
- **ミューテーションテスト(Stryker)**: テストの質を測る手段として有効。P2で同期のロジックが増えた段階で、`packages/sync` と `packages/parser` に限って夜間実行を検討する。

## 方針

- 同じことを検査するツールを2つ置かない。
- 規則を無効にするときは、設定ファイルかコードのコメントに理由を書く。
- ツールどうしの規則が衝突したら、型検査 > Lint > 整形 の順で優先する([conventions.md](../conventions.md))。
