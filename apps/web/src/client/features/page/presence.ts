import type { ClientId, CursorPosition } from "@amime/sync";

/** 他の端末(人)のカーソル。 */
export type RemoteCursor = CursorPosition & { readonly client: ClientId };

/**
 * 同じページを開いている他の端末の、カーソルの一覧を持つ(ADR-0023)。
 * WebSocket で届く知らせを受け取り、一覧が変わるたびに onChange で知らせる。
 */
export function createPresence(onChange: (cursors: readonly RemoteCursor[]) => void) {
	const cursors = new Map<ClientId, CursorPosition>();

	const publish = () => {
		const list = [...cursors].map(([client, cursor]) => ({ client, ...cursor }));
		// 端末の識別子の順に並べる。届いた順のままだと、同じ位置にいる人の表示が入れ替わる。
		onChange(list.sort((a, b) => (a.client < b.client ? -1 : 1)));
	};
	const remove = (client: ClientId) => {
		if (cursors.delete(client)) publish();
	};

	return {
		/** 他の端末のカーソルが動いた。null は、その端末がカーソルを出していない。 */
		onCursor(client: ClientId, cursor: CursorPosition | null): void {
			if (cursor === null) {
				remove(client);
				return;
			}
			cursors.set(client, cursor);
			publish();
		},
		/** 他の端末が接続を閉じた。 */
		onLeave: remove,
		/** 接続が切れたら、一覧を空にする。つなぎ直すと、サーバーがいまの一覧を送ってくる。 */
		onConnection(connected: boolean): void {
			if (connected || cursors.size === 0) return;
			cursors.clear();
			publish();
		},
	};
}
