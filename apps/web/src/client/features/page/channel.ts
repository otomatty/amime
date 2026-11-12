/** 値を、登録してある相手にその場で届ける通り道。 */
export type Channel<T> = {
	/** 届け先を登録する。返した関数で登録をやめる。 */
	readonly subscribe: (listener: (value: T) => void) => () => void;
	readonly emit: (value: T) => void;
};

export function createChannel<T>(): Channel<T> {
	const listeners = new Set<(value: T) => void>();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		emit(value) {
			for (const listener of listeners) listener(value);
		},
	};
}
