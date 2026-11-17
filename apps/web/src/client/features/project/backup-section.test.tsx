import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { buildProjectFile } from "@tsuzuri/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportProject, importProject } from "./backup.ts";
import { BackupSection, exportFileName } from "./backup-section.tsx";

vi.mock("./backup.ts", () => ({ exportProject: vi.fn(), importProject: vi.fn() }));

const page = (title: string) => ({ title, lines: [title], pinned: false, created: 1, updated: 2 });
const file = buildProjectFile("old", [page("一"), page("二")], Date.UTC(2026, 10, 17));

beforeEach(() => {
	vi.mocked(exportProject).mockReset();
	vi.mocked(importProject).mockReset();
});

afterEach(() => {
	cleanup();
});

/** 読み込むファイルを選ぶ。 */
function choose(content: string, name = "tsuzuri-old.json") {
	const input = screen.getByLabelText("読み込むファイル");
	fireEvent.change(input, {
		target: { files: [new File([content], name, { type: "application/json" })] },
	});
}

describe("exportFileName", () => {
	it("プロジェクトの名前と、書き出した日(その端末の日付)を入れる", () => {
		expect(exportFileName("team", new Date(2026, 10, 7, 23, 0).getTime())).toBe(
			"tsuzuri-team-2026-11-07.json",
		);
	});
});

describe("BackupSection(書き出しと読み込み。ADR-0043)", () => {
	it("書き出すと、進み具合を出し、終わったらファイルを渡す", async () => {
		let report: (done: number, total: number) => void = () => {};
		let finish: (value: typeof file) => void = () => {};
		vi.mocked(exportProject).mockImplementation((_project, options) => {
			report = options?.onProgress ?? report;
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		const download = vi.fn();
		render(<BackupSection project="team" admin={false} download={download} />);

		fireEvent.click(screen.getByRole("button", { name: "書き出す" }));
		report(3, 10);
		expect(await screen.findByText("書き出しています(3 / 10 ページ)")).toBeDefined();
		finish(file);

		await waitFor(() => expect(download).toHaveBeenCalledOnce());
		const [name, blob] = download.mock.calls[0] ?? [];
		expect(name).toMatch(/^tsuzuri-team-\d{4}-\d{2}-\d{2}\.json$/);
		expect(JSON.parse(await (blob as Blob).text())).toEqual(file);
		expect(screen.getByRole("status").textContent).toBe("2 ページを書き出しました。");
	});

	it("書き出せなかったら、そう知らせる", async () => {
		vi.mocked(exportProject).mockRejectedValue(new Error("unavailable"));
		render(<BackupSection project="team" admin={false} download={vi.fn()} />);

		fireEvent.click(screen.getByRole("button", { name: "書き出す" }));

		expect((await screen.findByRole("alert")).textContent).toMatch(/書き出せませんでした/);
	});

	it("読み込みは、管理者だけに出す", () => {
		render(<BackupSection project="team" admin={false} download={vi.fn()} />);

		expect(screen.queryByLabelText("読み込むファイル")).toBeNull();
	});

	it("ファイルを選ぶと、中身を確かめて、読み込む前に、何ページあるかを見せる", async () => {
		render(<BackupSection project="team" admin download={vi.fn()} />);

		choose(JSON.stringify(file));

		expect(
			await screen.findByText(
				/「old」から書き出した 2 ページです。同じ名前のページがあれば、書き換えずに飛ばします。/,
			),
		).toBeDefined();
		expect(importProject).not.toHaveBeenCalled();
	});

	it.each([
		["JSON でない", "{", /このアプリの書き出しファイルではありません/],
		["ほかのファイル", JSON.stringify({ pages: [] }), /このアプリの書き出しファイルではありません/],
		[
			"新しい版",
			JSON.stringify({ ...file, version: 99 }),
			/新しい版の書き出しファイルなので、読み込めません/,
		],
		[
			"形が違う",
			JSON.stringify({ ...file, pages: [{ title: "x" }] }),
			/ファイルの中身が壊れているので、読み込めません/,
		],
	])("読めないファイル(%s)は、理由を知らせ、読み込まない", async (_name, content, message) => {
		render(<BackupSection project="team" admin download={vi.fn()} />);

		choose(content);

		expect((await screen.findByRole("alert")).textContent).toMatch(message);
		expect(screen.queryByRole("button", { name: "読み込む" })).toBeNull();
	});

	it("別のファイルを選び直すと、読み終えるまで、前のファイルを読み込めない。最後に選んだファイルだけを使う", async () => {
		render(<BackupSection project="team" admin={true} />);
		choose(JSON.stringify(file));
		expect(await screen.findByRole("button", { name: "読み込む" })).toBeDefined();

		let finishSlow: (text: string) => void = () => {};
		const slow = new File(["{}"], "slow.json");
		slow.text = () =>
			new Promise((resolve) => {
				finishSlow = resolve;
			});
		const fast = new File([JSON.stringify(buildProjectFile("new", [page("三")], 0))], "fast.json");
		const input = screen.getByLabelText("読み込むファイル");
		fireEvent.change(input, { target: { files: [slow] } });

		expect(screen.queryByRole("button", { name: "読み込む" })).toBeNull();
		fireEvent.change(input, { target: { files: [fast] } });
		expect(await screen.findByText(/「new」から書き出した 1 ページです/)).toBeDefined();
		finishSlow(JSON.stringify(file));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(screen.getByText(/「new」から書き出した 1 ページです/)).toBeDefined();
	});

	it("ファイルを読めなければ、そう知らせる", async () => {
		render(<BackupSection project="team" admin={true} />);
		const broken = new File([""], "broken.json");
		broken.text = () => Promise.reject(new Error("NotReadableError"));

		fireEvent.change(screen.getByLabelText("読み込むファイル"), { target: { files: [broken] } });

		expect((await screen.findByRole("alert")).textContent).toBe(
			"ファイルを読めませんでした。もう一度選んでください。",
		);
	});

	it("読み込むと、進み具合を出し、作ったページと飛ばしたページ、送れなかったページを知らせる", async () => {
		let report: (done: number, total: number) => void = () => {};
		vi.mocked(importProject).mockImplementation(async (_file, options) => {
			report = options?.onProgress ?? report;
			report(1, 2);
			await new Promise((resolve) => setTimeout(resolve, 0));
			return { created: ["一"], skipped: ["二"], failed: ["三"] };
		});
		render(<BackupSection project="team" admin download={vi.fn()} />);
		choose(JSON.stringify(file));

		fireEvent.click(await screen.findByRole("button", { name: "読み込む" }));

		expect(await screen.findByText("1 ページを作りました。")).toBeDefined();
		expect(
			screen.getByText(/同じ名前のページがあったので、書き換えずに飛ばしました: 二/),
		).toBeDefined();
		expect(screen.getByRole("alert").textContent).toMatch(
			/送れなかったページ: 三。もう一度同じファイルを読み込むと、続きから作ります。/,
		);
		expect(vi.mocked(importProject).mock.calls[0]?.[0]).toEqual(file);
	});
});
