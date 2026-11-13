import type { AccountState } from "@amime/sync";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { loadAccount } from "./api.ts";

type AccountContextValue = {
	/** ログインの状態。読み込むまでは null。 */
	readonly state: AccountState | null;
	/** ログインの状態を読み直す(ログインやログアウトのあと)。 */
	readonly refresh: () => Promise<void>;
};

const AccountContext = createContext<AccountContextValue>({
	state: null,
	refresh: () => Promise.resolve(),
});

/** ログインの状態を読み込み、下の部品に配る。 */
export function AccountProvider({ children }: { readonly children: ReactNode }) {
	const [state, setState] = useState<AccountState | null>(null);
	// 何回目の読み込みか。読み込みが重なったら、あとから頼んだものの結果だけを使う
	// (ログアウトしたあとに、前のログインしていた状態が遅れて届いても、戻さない)。
	const latest = useRef(0);
	const refresh = useCallback(async () => {
		latest.current += 1;
		const request = latest.current;
		const loaded = await loadAccount();
		if (request === latest.current) setState(loaded);
	}, []);
	useEffect(() => {
		void refresh();
		return () => {
			// 外したあとに届いた状態は、使わない。
			latest.current += 1;
		};
	}, [refresh]);
	const value = useMemo(() => ({ state, refresh }), [state, refresh]);
	return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/** ログインの状態と、それを読み直す操作。 */
export const useAccount = (): AccountContextValue => useContext(AccountContext);
