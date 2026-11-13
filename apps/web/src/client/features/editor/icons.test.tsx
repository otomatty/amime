import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIconSource, IconImage, IconSourceProvider } from "./icons.tsx";

afterEach(cleanup);

describe("createIconSource(アイコンの画像のURLを引く。同じ名前は、1回だけ引く)", () => {
	it("名前から、画像のURLを引く。名前の表記の違い(大文字と小文字、空白かアンダースコアか)は、同じ名前として扱う", async () => {
		const load = vi.fn(async (name: string) => `https://images.example/${name}.png`);
		const source = createIconSource(load);

		expect(await source("Hanako Yamada")).toBe("https://images.example/Hanako Yamada.png");
		expect(await source("hanako_yamada")).toBe("https://images.example/Hanako Yamada.png");
		expect(await source("taro")).toBe("https://images.example/taro.png");
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("引けなかった名前(null)も、引き直さない。引くのに失敗したら、次は引き直す", async () => {
		const load = vi
			.fn<(name: string) => Promise<string | null>>()
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValueOnce("https://images.example/b.png");
		const source = createIconSource(load);

		expect(await source("a")).toBeNull();
		expect(await source("a")).toBeNull();
		expect(await source("b")).toBeNull();
		expect(await source("b")).toBe("https://images.example/b.png");
		expect(load).toHaveBeenCalledTimes(3);
	});
});

describe("IconImage([名前.icon] の表示)", () => {
	it("画像のURLを引けたら、画像を表示する(名前は、代わりの文字にする)", async () => {
		const source = vi.fn(async () => "https://images.example/hanako.png");

		render(
			<IconSourceProvider source={source}>
				<IconImage name="花子" />
			</IconSourceProvider>,
		);

		expect(screen.getByText("花子")).toBeDefined();
		const image = await screen.findByRole("img", { name: "花子" });
		expect(image.getAttribute("src")).toBe("https://images.example/hanako.png");
		expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(screen.queryByText("花子")).toBeNull();
		expect(source).toHaveBeenCalledExactlyOnceWith("花子");
	});

	it("引けなければ、名前の文字のまま", async () => {
		const source = vi.fn(async () => null);

		render(
			<IconSourceProvider source={source}>
				<IconImage name="花子" />
			</IconSourceProvider>,
		);

		await waitFor(() => expect(source).toHaveBeenCalled());
		expect(screen.getByText("花子")).toBeDefined();
		expect(screen.queryByRole("img")).toBeNull();
	});

	it("画像を読み込めなかったら、名前の文字に戻す", async () => {
		render(
			<IconSourceProvider source={async () => "https://images.example/broken.png"}>
				<IconImage name="花子" />
			</IconSourceProvider>,
		);
		const image = await screen.findByRole("img", { name: "花子" });

		image.dispatchEvent(new Event("error"));

		await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
		expect(screen.getByText("花子")).toBeDefined();
	});

	it("引く先がなければ(試し書きのページなど)、名前の文字のまま", () => {
		render(<IconImage name="花子" />);

		expect(screen.getByText("花子")).toBeDefined();
	});

	it("外したあとに届いた結果は、使わない", async () => {
		let resolve: (url: string) => void = () => {};
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { unmount } = render(
			<IconSourceProvider source={() => new Promise((done) => (resolve = done))}>
				<IconImage name="花子" />
			</IconSourceProvider>,
		);

		unmount();
		resolve("https://images.example/hanako.png");
		await new Promise((done) => setTimeout(done, 0));

		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});
});
