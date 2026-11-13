import type { Role, Visibility } from "@amime/shared";
import type { Member, NewInvite, ProjectInfo, ProjectMembers, UserId } from "@amime/sync";
import { useCallback, useEffect, useState } from "react";
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
	/** 変える操作を行い、成功したら一覧を読み直す。失敗したら、案内を出す。 */
	readonly run: (action: () => Promise<string | null>) => Promise<boolean>;
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
		if ((await run(() => removeMember(project, member.id))) && self) onLeft();
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
						void run(() => setRole(project, member.id, role));
					}}
				>
					<option value="admin">{ROLE_LABELS.admin}</option>
					<option value="member">{ROLE_LABELS.member}</option>
				</select>
			) : (
				<span className="project-visibility">{ROLE_LABELS[member.role]}</span>
			)}
			{(admin || self) && (
				<button type="button" onClick={() => void remove()}>
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
	const create = async () => {
		let invite: NewInvite | null = null;
		await run(async () => {
			invite = await createInvite(project);
			return invite === null ? "failed" : null;
		});
		setCreated(invite);
	};
	return (
		<section aria-labelledby="settings-invites">
			<h3 id="settings-invites">招待リンク</h3>
			<p>
				リンクを受け取った人は、ログインすると、メンバーとして参加できます。リンクは、7日で使えなくなります。
			</p>
			<button type="button" onClick={() => void create()}>
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
							<button
								type="button"
								onClick={() => {
									if (created?.id === invite.id) setCreated(null);
									void run(() => revokeInvite(project, invite.id));
								}}
							>
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
	const admin = project.role === "admin";
	const [visibility, setShown] = useState(project.visibility);
	const [list, setList] = useState<ProjectMembers | null | "failed">(null);
	const [failure, setFailure] = useState<string | null>(null);
	const reload = useCallback(async () => {
		setList((await loadMembers(project.name)) ?? "failed");
	}, [project.name]);
	useEffect(() => {
		void reload();
	}, [reload]);
	const run = useCallback(
		async (action: () => Promise<string | null>) => {
			const reason = await action();
			setFailure(reason === null ? null : failureText(reason));
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
