import { parseCommitRequest } from "@amime/sync";
import { describe, expect, it } from "vitest";
import { createCommitId, deriveCommitId } from "./commit-id.ts";

describe("createCommitId", () => {
	it("サーバーが受け付ける形のIDを作る", () => {
		expect(parseCommitRequest({ id: createCommitId(), changes: [] }).ok).toBe(true);
	});

	it("呼ぶたびに違うIDを作る", () => {
		expect(createCommitId()).not.toBe(createCommitId());
	});
});

describe("deriveCommitId(内容から決まるコミットのID)", () => {
	it("サーバーが受け付ける形のIDを作る", async () => {
		const id = await deriveCommitId("内容", 0);

		expect(parseCommitRequest({ id, changes: [] }).ok).toBe(true);
	});

	it("同じ内容と番号からは、いつも同じIDを作る(送り直しても、同じコミットだと分かる)", async () => {
		expect(await deriveCommitId("内容", 3)).toBe(await deriveCommitId("内容", 3));
	});

	it("内容か番号が違えば、違うIDを作る", async () => {
		const id = await deriveCommitId("内容", 0);

		expect(await deriveCommitId("内容", 1)).not.toBe(id);
		expect(await deriveCommitId("別の内容", 0)).not.toBe(id);
	});
});
