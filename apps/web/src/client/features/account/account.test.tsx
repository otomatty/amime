import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountProvider, useAccount } from "./account.tsx";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function Probe() {
	const { state, refresh } = useAccount();
	return (
		<button type="button" onClick={() => void refresh()}>
			{state === null ? "読み込み中" : (state.user?.name ?? "ログインしていない")}
		</button>
	);
}

const hanako = { id: "u1", name: "花子", email: "hanako@example.com", picture: null };

describe("AccountProvider / useAccount", () => {
	it("読み込むまでは null。読み込んだら、ログインの状態を配る", async () => {
		vi.stubGlobal("fetch", async () => Response.json({ user: hanako, login: ["google"] }));

		render(
			<AccountProvider>
				<Probe />
			</AccountProvider>,
		);

		expect(screen.getByRole("button").textContent).toBe("読み込み中");
		await waitFor(() => expect(screen.getByRole("button").textContent).toBe("花子"));
	});

	it("refresh で、ログインの状態を読み直す", async () => {
		let state: unknown = { user: hanako, login: [] };
		vi.stubGlobal("fetch", async () => Response.json(state));
		render(
			<AccountProvider>
				<Probe />
			</AccountProvider>,
		);
		await waitFor(() => expect(screen.getByRole("button").textContent).toBe("花子"));

		state = { user: null, login: [] };
		fireEvent.click(screen.getByRole("button"));

		await waitFor(() => expect(screen.getByRole("button").textContent).toBe("ログインしていない"));
	});

	it("外したあとに届いた状態は、使わない", async () => {
		let resolve: (response: Response) => void = () => {};
		vi.stubGlobal("fetch", () => new Promise<Response>((done) => (resolve = done)));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { unmount } = render(
			<AccountProvider>
				<Probe />
			</AccountProvider>,
		);

		unmount();
		resolve(Response.json({ user: hanako, login: [] }));
		await new Promise((done) => setTimeout(done, 0));

		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("配る部品の外では、読み込み中のままになる(refresh は、何もしない)", async () => {
		render(<Probe />);

		fireEvent.click(screen.getByRole("button"));

		expect(screen.getByRole("button").textContent).toBe("読み込み中");
	});
});
