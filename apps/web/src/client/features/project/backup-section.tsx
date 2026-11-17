import { type ProjectFile, type ProjectFileError, parseProjectFile } from "@tsuzuri/sync";
import { useId, useRef, useState } from "react";
import { exportProject, type ImportResult, importProject } from "./backup.ts";

/** 書き出したファイルの名前。プロジェクトの名前と、書き出した日(その端末の日付)を入れる。 */
export function exportFileName(project: string, at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `tsuzuri-${project}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

/** ブラウザに、ファイルとして保存させる。 */
function saveFile(name: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.click();
	// 保存が始まるまで、URLを残す。
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const FILE_ERRORS: Record<ProjectFileError, string> = {
	"invalid-json": "このアプリの書き出しファイルではありません。",
	"not-project-file": "このアプリの書き出しファイルではありません。",
	"unsupported-version":
		"新しい版の書き出しファイルなので、読み込めません。アプリが新しくなるのを待ってください。",
	invalid: "ファイルの中身が壊れているので、読み込めません。",
};

type ExportState =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly done: number; readonly total: number }
	| { readonly kind: "done"; readonly pages: number }
	| { readonly kind: "failed" };

type ImportState =
	| { readonly kind: "idle" }
	| { readonly kind: "reading" }
	| { readonly kind: "invalid"; readonly message: string }
	| { readonly kind: "ready"; readonly file: ProjectFile }
	| { readonly kind: "running"; readonly done: number; readonly total: number }
	| { readonly kind: "done"; readonly file: ProjectFile; readonly result: ImportResult };

type BackupSectionProps = {
	readonly project: string;
	/** 読み込みは、管理者だけができる(ADR-0043)。 */
	readonly admin: boolean;
	/** 書き出したファイルを渡す先。既定は、ブラウザに保存させる。 */
	readonly download?: (name: string, blob: Blob) => void;
};

/**
 * プロジェクトの書き出しと読み込み(ADR-0043、US-14)。設定の画面に出す。
 * 書き出しは、メンバーならだれでもできる。読み込みは、管理者だけ。
 */
export function BackupSection({ project, admin, download = saveFile }: BackupSectionProps) {
	const headingId = useId();
	const fileId = useId();
	const [exported, setExported] = useState<ExportState>({ kind: "idle" });
	const [imported, setImported] = useState<ImportState>({ kind: "idle" });
	// 選んだ回数。読み終えるのを待つあいだに選び直されたら、前のファイルの結果は使わない。
	const chosenCount = useRef(0);

	const runExport = async () => {
		setExported({ kind: "running", done: 0, total: 0 });
		try {
			const file = await exportProject(project, {
				onProgress: (done, total) => setExported({ kind: "running", done, total }),
			});
			const blob = new Blob([JSON.stringify(file, null, "\t")], { type: "application/json" });
			download(exportFileName(project, Date.now()), blob);
			setExported({ kind: "done", pages: file.pages.length });
		} catch {
			setExported({ kind: "failed" });
		}
	};

	const choose = async (chosen: File | undefined) => {
		chosenCount.current += 1;
		const current = chosenCount.current;
		if (chosen === undefined) return setImported({ kind: "idle" });
		// 読み終えるまで、前に選んだファイルを読み込めないようにする。
		setImported({ kind: "reading" });
		const text = await chosen.text().catch(() => null);
		if (current !== chosenCount.current) return;
		if (text === null) {
			return setImported({
				kind: "invalid",
				message: "ファイルを読めませんでした。もう一度選んでください。",
			});
		}
		const parsed = parseProjectFile(text);
		setImported(
			parsed.ok
				? { kind: "ready", file: parsed.value }
				: { kind: "invalid", message: FILE_ERRORS[parsed.error] },
		);
	};

	const runImport = async (file: ProjectFile) => {
		setImported({ kind: "running", done: 0, total: file.pages.length });
		const result = await importProject(file, {
			onProgress: (done, total) => setImported({ kind: "running", done, total }),
		});
		setImported({ kind: "done", file, result });
	};

	return (
		<section aria-labelledby={headingId}>
			<h3 id={headingId}>書き出しと読み込み</h3>
			<p>
				すべてのページを、1つのファイルに書き出します。バックアップや、別のプロジェクトへの移行に使えます。
			</p>
			<button type="button" disabled={exported.kind === "running"} onClick={() => void runExport()}>
				書き出す
			</button>
			{exported.kind === "running" && (
				<p className="page-status" role="status">
					書き出しています({exported.done} / {exported.total} ページ)
				</p>
			)}
			{exported.kind === "done" && (
				<p className="page-status" role="status">
					{exported.pages} ページを書き出しました。
				</p>
			)}
			{exported.kind === "failed" && (
				<p className="project-error" role="alert">
					書き出せませんでした。もう一度お試しください。
				</p>
			)}
			{admin && (
				<>
					<p>
						<label htmlFor={fileId}>読み込むファイル</label>{" "}
						<input
							id={fileId}
							type="file"
							accept="application/json,.json"
							disabled={imported.kind === "running"}
							onChange={(event) => void choose(event.target.files?.[0])}
						/>
					</p>
					{imported.kind === "invalid" && (
						<p className="project-error" role="alert">
							{imported.message}
						</p>
					)}
					{imported.kind === "ready" && (
						<p>
							「{imported.file.project}」から書き出した {imported.file.pages.length}{" "}
							ページです。同じ名前のページがあれば、書き換えずに飛ばします。{" "}
							<button type="submit" onClick={() => void runImport(imported.file)}>
								読み込む
							</button>
						</p>
					)}
					{imported.kind === "running" && (
						<p className="page-status" role="status">
							読み込んでいます({imported.done} / {imported.total} ページ)
						</p>
					)}
					{imported.kind === "done" && (
						<ImportSummary result={imported.result} retry={() => void runImport(imported.file)} />
					)}
				</>
			)}
		</section>
	);
}

type ImportSummaryProps = {
	readonly result: ImportResult;
	/** 同じファイルを、もう一度読み込む(ファイルを選び直さなくてよい。同じファイルを選んでも、選んだことにならない)。 */
	readonly retry: () => void;
};

function ImportSummary({ result, retry }: ImportSummaryProps) {
	return (
		<>
			<p className="page-status" role="status">
				{result.created.length} ページを作りました。
			</p>
			{result.skipped.length > 0 && (
				<p>同じ名前のページがあったので、書き換えずに飛ばしました: {result.skipped.join("、")}</p>
			)}
			{result.failed.length > 0 && (
				<>
					<p className="project-error" role="alert">
						送れなかったページ: {result.failed.join("、")}
						。もう一度読み込むと、続きから作ります。
					</p>
					<button type="button" onClick={retry}>
						もう一度読み込む
					</button>
				</>
			)}
		</>
	);
}
