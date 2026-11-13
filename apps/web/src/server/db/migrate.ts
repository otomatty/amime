/**
 * D1 のスキーマの変更。上から順に、1回ずつ当てる。当てたものは書き換えず、下に足す。
 * それぞれの文は、何度実行しても同じ結果になるように書く(同時に当てようとしても、壊れない)。
 */
const MIGRATIONS: readonly (readonly string[])[] = [
	[
		// 利用者。provider と subject で、ログインの提供元の本人と結び付ける。
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			subject TEXT NOT NULL,
			email TEXT NOT NULL,
			name TEXT NOT NULL,
			picture TEXT,
			created INTEGER NOT NULL,
			UNIQUE (provider, subject)
		)`,
		// ログインの状態。id は、Cookie に入れた値のハッシュ(値そのものは保存しない)。
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			user TEXT NOT NULL REFERENCES users (id),
			created INTEGER NOT NULL,
			expires INTEGER NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires)",
	],
];

/** この実行環境(isolate)で、スキーマが最新だと確かめたデータベース。 */
const migrated = new WeakSet<D1Database>();

/**
 * データベースのスキーマを最新にする。確かめるのは、実行環境ごとに1回だけ。
 * デプロイの手順に依存しないように、アプリが自分で当てる(ADR-0032)。
 */
export async function ready(db: D1Database): Promise<void> {
	if (migrated.has(db)) return;
	await db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)");
	const { results } = await db.prepare("SELECT version FROM migrations").all<{ version: number }>();
	const done = new Set(results.map((row) => row.version));
	for (const [index, statements] of MIGRATIONS.entries()) {
		const version = index + 1;
		if (done.has(version)) continue;
		// まとめて実行する(D1 の batch は、1つのトランザクションになる)。
		await db.batch([
			...statements.map((statement) => db.prepare(statement)),
			db.prepare("INSERT OR IGNORE INTO migrations (version) VALUES (?)").bind(version),
		]);
	}
	migrated.add(db);
}
