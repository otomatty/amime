/** 端末内に変更を残した時刻を、短く書く(例: 11月16日 14:05)。ADR-0042。 */
export function formatSavedAt(savedAt: number): string {
	return new Date(savedAt).toLocaleString("ja-JP", {
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
