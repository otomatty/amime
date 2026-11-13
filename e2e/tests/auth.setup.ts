import { expect, test as setup } from "@playwright/test";
import { MEMBER_STATE } from "../playwright.config.ts";

/** E2Eのテストが使うプロジェクト。テストは、そのメンバーとして操作する。 */
const PROJECT = "e2e";

setup("メンバーとしてログインし、E2E用のプロジェクトを用意する", async ({ request }) => {
	const login = await request.post("/api/auth/dev", { data: { name: "e2e-member" } });
	expect(login.status()).toBe(204);
	// 前の実行で作ってあれば、同じ名前では作れない(409)。そのまま使う。
	const created = await request.post("/api/projects", { data: { name: PROJECT } });
	expect([201, 409]).toContain(created.status());
	const project = await request.get(`/api/projects/${PROJECT}`);
	expect(await project.json()).toMatchObject({ name: PROJECT, role: "admin" });
	await request.storageState({ path: MEMBER_STATE });
});
