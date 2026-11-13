import type { Visibility } from "@amime/shared";
import type { ProjectList } from "@amime/sync";
import { type FormEvent, useEffect, useState } from "react";
import { useAccount } from "../account/account.tsx";
import { type CreateProjectError, createProject, listProjects } from "./api.ts";
import "./project.css";

const VISIBILITY_LABELS: Record<Visibility, string> = {
	private: "非公開(メンバーだけが見られる)",
	public: "公開(誰でも読める。書けるのはメンバーだけ)",
};

const CREATE_ERRORS: Record<CreateProjectError, string> = {
	"invalid-name": "名前は、半角の英小文字・数字・ハイフンで、2文字から40文字までにしてください。",
	"reserved-name": "その名前は、使えません。別の名前にしてください。",
	"name-taken": "その名前のプロジェクトが、すでにあります。別の名前にしてください。",
	"not-allowed": "プロジェクトを作る権限がありません。",
	"login-required": "ログインしてから、もう一度お試しください。",
	failed: "プロジェクトを作れませんでした。もう一度お試しください。",
};

type HomeProps = {
	/** 画面を移る。テストで差し替える。 */
	readonly navigate?: (href: string) => void;
};

/** プロジェクトを作る欄。作れたら、そのプロジェクトへ移る。 */
function CreateProject({ navigate }: { readonly navigate: (href: string) => void }) {
	const [name, setName] = useState("");
	const [visibility, setVisibility] = useState<Visibility>("private");
	const [error, setError] = useState<CreateProjectError | null>(null);
	const [busy, setBusy] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (name.trim() === "" || busy) return;
		setBusy(true);
		const created = await createProject(name.trim(), visibility);
		setBusy(false);
		if (created.ok) navigate(`/${created.project.name}/`);
		else setError(created.error);
	};
	return (
		<form className="project-create" onSubmit={(event) => void submit(event)}>
			<h3>新しいプロジェクト</h3>
			<label>
				名前(URLになります)
				<input
					value={name}
					placeholder="my-team"
					autoCapitalize="off"
					autoComplete="off"
					spellCheck={false}
					onChange={(event) => {
						setName(event.target.value);
						setError(null);
					}}
				/>
			</label>
			<label>
				公開範囲
				<select
					value={visibility}
					onChange={(event) =>
						setVisibility(event.target.value === "public" ? "public" : "private")
					}
				>
					<option value="private">{VISIBILITY_LABELS.private}</option>
					<option value="public">{VISIBILITY_LABELS.public}</option>
				</select>
			</label>
			<button type="submit" disabled={busy}>
				プロジェクトを作る
			</button>
			{error !== null && (
				<p className="project-error" role="alert">
					{CREATE_ERRORS[error]}
				</p>
			)}
		</form>
	);
}

/** トップ。参加しているプロジェクトの一覧と、プロジェクトを作る欄(ADR-0033)。 */
export function Home({ navigate = (href) => window.location.assign(href) }: HomeProps) {
	const { state } = useAccount();
	const user = state?.user?.id ?? null;
	// 読み込んだ一覧は、だれのものかと一緒に持つ。別の利用者に変わったら、前の人の一覧は出さない。
	const [loaded, setLoaded] = useState<{
		readonly user: string;
		readonly list: ProjectList | "failed";
	} | null>(null);
	useEffect(() => {
		if (user === null) return;
		let cancelled = false;
		void listProjects().then((list) => {
			if (!cancelled) setLoaded({ user, list: list ?? "failed" });
		});
		return () => {
			cancelled = true;
		};
	}, [user]);
	const list = loaded?.user === user ? loaded.list : null;

	if (state === null) return null;
	if (state.user === null) {
		return (
			<section className="project-home">
				<p>
					Amime は、チームで書くノートです。ログインすると、参加しているプロジェクトが並びます。
				</p>
				<p>
					<a href="/?playground">試し書きのページ</a>で、書き心地を試せます(内容は保存されません)。
				</p>
			</section>
		);
	}
	if (list === null) {
		return (
			<p className="page-status" role="status">
				読み込んでいます…
			</p>
		);
	}
	if (list === "failed") {
		return (
			<p className="page-message">
				プロジェクトの一覧を読み込めませんでした。再読み込みしてください。
			</p>
		);
	}
	return (
		<section className="project-home" aria-labelledby="project-home-title">
			<h2 id="project-home-title">プロジェクト</h2>
			{list.projects.length === 0 ? (
				<p>参加しているプロジェクトは、まだありません。</p>
			) : (
				<ul className="project-list">
					{list.projects.map((project) => (
						<li key={project.name}>
							<a href={`/${project.name}/`}>{project.name}</a>
							<span className="project-visibility">
								{project.visibility === "public" ? "公開" : "非公開"}
							</span>
						</li>
					))}
				</ul>
			)}
			{list.canCreate && <CreateProject navigate={navigate} />}
		</section>
	);
}
