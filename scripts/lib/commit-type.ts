const CONVENTIONAL_HEADER = /^([a-z]+)(?:\([^)]+\))?!?: /i;

/** Conventional Commits 形式の見出しから種別(feat, fix など)を小文字で取り出す。 */
export function parseCommitType(header: string): string | undefined {
	return CONVENTIONAL_HEADER.exec(header)?.[1]?.toLowerCase();
}
