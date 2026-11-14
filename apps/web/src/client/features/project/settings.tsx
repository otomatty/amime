import type { Role, Visibility } from "@amime/shared";
import type { Member, NewInvite, ProjectInfo, ProjectMembers, UserId } from "@amime/sync";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "../account/account.tsx";
import {
	createInvite,
	loadMembers,
	removeMember,
	revokeInvite,
	setRole,
	setVisibility,
} from "./api.ts";
import "./project.css";

const VISIBILITY_LABELS: Record<Visibility, string> = {
	private: "非公開(メンバーだけが見られる)",
	public: "公開(誰でも読める。書けるのはメンバーだけ)",
};
const ROLE_LABELS: Record<Role, string> = { admin: "管理者", member: "メンバー" };

/** 変える操作が失敗したときの案内。サーバーが断った理由ごと。 */
const FAILURES: ReadonlyMap<string, string> = new Map([
	["last-admin", "管理者が1人だけのときは、その人を外すことも、メンバーに戻すこともできません。"],
	["not-admin", "この操作は、管理者だけができます。"],
	["unknown-member", "そのメンバーは、もういません。"],
	["unknown-invite", "その招待リンクは、もう使えません。"],
]);
const failureText = (reason: string): string =>
	FAILURES.get(reason) ?? "変更できませんでした。もう一度お試しください。";

const dateTime = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" });

type SettingsProps = {
	readonly project: ProjectInfo;
	/** 画面を移る。テストで差し替える。 */
	readonly navigate?: (href: string) => void;
	/** 招待リンクのもとになる、このサイトのURL。 */
	readonly origin?: string;
};

type Actions = {
	/**
	 * 変える操作を行い、一覧を読み直す。失敗したら、案内を出す。
	 * applied は、成功したときに、読み直す前の一覧に、その変更を写す(読み直せなくても、変更が画面に出る)。
	 */
	readonly run: (
		action: () => Promise<string | null>,
		applied?: (members: readonly Member[]) => readonly Member[],
	) => Promise<boolean>;
};

function MemberRow({
	project,
	member,
	me,
	admin,
	run,
	onLeft,
}: Actions & {
	readonly project: string;
	readonly member: Member;
	readonly me: UserId | null;
	readonly admin: boolean;
	readonly onLeft: () => void;
}) {
	const self = member.id === me;
	const remove = async () => {
		const removed = await run(
			() => removeMember(project, member.id),
			(members) => members.filter((other) => other.id !== member.id),
		);
		if (removed && self) onLeft();
	};
	return (
		<li>
			<span className="member-name">
				{member.picture !== null && (
					<img
						className="account-picture"
						src={member.picture}
						alt=""
						referrerPolicy="no-referrer"
					/>
				)}
				{member.name}
				{self && "(自分)"}
			</span>
			{admin ? (
				<select
					aria-label={`${member.name} の役割`}
					value={member.role}
					onChange={(event) => {
						const role: Role = event.target.value === "admin" ? "admin" : "member";
						void run(
							() => setRole(project, member.id, role),
							(members) =>
								members.map((other) => (other.id === member.id ? { ...other, role } : other)),
						);
					}}
				>
					<option value="admin">{ROLE_LABELS.admin}</option>
					<option value="member">{ROLE_LABELS.member}</option>
				</select>
			) : (
				<span className="project-visibility">{ROLE_LABELS[member.role]}</span>
			)}
			{(admin || self) && (
				<button type="button" className="danger" onClick={() => void remove()}>
					{self ? "このプロジェクトから抜ける" : `${member.name} を外す`}
				</button>
			)}
		</li>
	);
}

/** 招待リンク。作ったリンクは、作ったときにだけ表示できる。 */
function Invites({
	project,
	list,
	origin,
	run,
}: Actions & {
	readonly project: string;
	readonly list: ProjectMembers["invites"];
	readonly origin: string;
}) {
	const [created, setCreated] = useState<NewInvite | null>(null);
	// 作っている途中か。途中は、もう1つ作り始めさせない(応答の順番が入れ替わると、あとから届いた前のリンクが、表示を上書きする)。
	const [creating, setCreating] = useState(false);
	// この画面で無効にしたリンク。作った応答が、無効にしたあとで届いても、表示しない。
	const revoked = useRef(new Set<string>());
	const create = async () => {
		setCreating(true);
		await run(async () => {
			const invite = await createInvite(project).finally(() => setCreating(false));
			// 作れたら、すぐに表示する(一覧の読み直しを待つと、あとから作ったリンクを、前のリンクで上書きすることがある)。
			// 作れなかったときは、前に作ったリンクを出したままにする(まだ使えるリンクを、見失わせない)。
			if (invite !== null && !revoked.current.has(invite.id)) setCreated(invite);
			return invite === null ? "failed" : null;
		});
	};
	const revoke = async (id: string) => {
		await run(async () => {
			const reason = await revokeInvite(project, id);
			// 無効にできたときにだけ、表示を消す(できなかったリンクは、まだ使える)。一覧の読み直しは、待たない。
			// 待っているあいだに、別のリンクを作っていたら、そのリンクは消さない。
			if (reason === null) {
				revoked.current.add(id);
				setCreated((current) => (current?.id === id ? null : current));
			}
			return reason;
		});
	};
	return (
		<section aria-labelledby="settings-invites">
			<h3 id="settings-invites">招待リンク</h3>
			<p>
				リンクを受け取った人は、ログインすると、メンバーとして参加できます。リンクは、7日で使えなくなります。
			</p>
			<button type="button" className="primary" disabled={creating} onClick={() => void create()}>
				招待リンクを作る
			</button>
			{created !== null && (
				<p className="invite-created">
					<label>
						新しい招待リンク(いまだけ表示されます。写して、招待したい人に送ってください)
						<input
							readOnly
							value={`${origin}/invite/${created.token}`}
							onFocus={(event) => event.target.select()}
						/>
					</label>
				</p>
			)}
			{list.length > 0 && (
				<ul className="project-list" aria-label="使える招待リンク">
					{list.map((invite) => (
						<li key={invite.id}>
							<span>{dateTime.format(invite.created)} に作成</span>
							<span className="project-visibility">{dateTime.format(invite.expires)} まで</span>
							<button type="button" onClick={() => void revoke(invite.id)}>
								無効にする
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/** プロジェクトの設定。メンバー、招待リンク、公開範囲(ADR-0034)。メンバーだけが開ける。 */
export function ProjectSettings({
	project,
	navigate = (href) => window.location.assign(href),
	origin = window.location.origin,
}: SettingsProps) {
	const { state } = useAccount();
	const me = state?.user?.id ?? null;
	const [visibility, setShown] = useState(project.visibility);
	const [list, setList] = useState<ProjectMembers | null | "failed">(null);
	// 自分の役割は、読み込んだ一覧から決める(この画面で自分の役割を変えたら、管理者だけの操作を出すのをやめる)。
	// 一覧を読み込むまでは、画面を開いたときに分かっていた役割を使う。
	const mine =
		list === null || list === "failed" ? undefined : list.members.find((m) => m.id === me);
	const admin = (mine?.role ?? project.role) === "admin";
	const [failure, setFailure] = useState<string | null>(null);
	// いちばん新しい読み直しの番号。前に始めた読み直しが、あとから届いても、使わない。
	const latest = useRef(0);
	const reload = useCallback(async () => {
		latest.current += 1;
		const request = latest.current;
		const loaded = await loadMembers(project.name);
		if (request !== latest.current) return;
		// 読み直しに失敗しても、前に読み込んだ一覧があれば、それを出したままにする
		// (作ったばかりの招待リンクの表示を、消さない)。
		setList((current) => loaded ?? (current === null ? "failed" : current));
	}, [project.name]);
	useEffect(() => {
		void reload();
	}, [reload]);
	const run = useCallback(
		async (
			action: () => Promise<string | null>,
			applied?: (members: readonly Member[]) => readonly Member[],
		) => {
			const reason = await action();
			setFailure(reason === null ? null : failureText(reason));
			if (reason === null && applied !== undefined) {
				setList((current) =>
					current === null || current === "failed"
						? current
						: { ...current, members: [...applied(current.members)] },
				);
			}
			await reload();
			return reason === null;
		},
		[reload],
	);

	if (project.role === null) {
		return <p className="page-message">設定を見られるのは、このプロジェクトのメンバーだけです。</p>;
	}
	return (
		<section className="project-home project-settings" aria-labelledby="settings-title">
			<h2 id="settings-title">「{project.name}」の設定</h2>
			<p>
				<a href={`/${project.name}/`}>ページの一覧へ戻る</a>
			</p>
			{failure !== null && (
				<p className="project-error" role="alert">
					{failure}
				</p>
			)}
			<section aria-labelledby="settings-visibility">
				<h3 id="settings-visibility">公開範囲</h3>
				{admin ? (
					<select
						aria-label="公開範囲"
						value={visibility}
						onChange={(event) => {
							const next: Visibility = event.target.value === "public" ? "public" : "private";
							void run(() => setVisibility(project.name, next)).then((changed) => {
								if (changed) setShown(next);
							});
						}}
					>
						<option value="private">{VISIBILITY_LABELS.private}</option>
						<option value="public">{VISIBILITY_LABELS.public}</option>
					</select>
				) : (
					<p>{VISIBILITY_LABELS[visibility]}</p>
				)}
			</section>
			<section aria-labelledby="settings-members">
				<h3 id="settings-members">メンバー</h3>
				{list === null && (
					<p className="page-status" role="status">
						読み込んでいます…
					</p>
				)}
				{list === "failed" && (
					<p className="page-message">メンバーを読み込めませんでした。再読み込みしてください。</p>
				)}
				{list !== null && list !== "failed" && (
					<ul className="project-list" aria-label="メンバー">
						{list.members.map((member) => (
							<MemberRow
								key={member.id}
								project={project.name}
								member={member}
								me={me}
								admin={admin}
								run={run}
								onLeft={() => navigate("/")}
							/>
						))}
					</ul>
				)}
			</section>
			{admin && list !== null && list !== "failed" && (
				<Invites project={project.name} list={list.invites} origin={origin} run={run} />
			)}
		</section>
	);
}
