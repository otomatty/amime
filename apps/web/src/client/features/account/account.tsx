import type { AccountState } from "@amime/sync";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
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
	const refresh = useCallback(async () => setState(await loadAccount()), []);
	useEffect(() => {
		let cancelled = false;
		void loadAccount().then((loaded) => {
			if (!cancelled) setState(loaded);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	const value = useMemo(() => ({ state, refresh }), [state, refresh]);
	return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/** ログインの状態と、それを読み直す操作。 */
export const useAccount = (): AccountContextValue => useContext(AccountContext);
