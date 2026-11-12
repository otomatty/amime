import { parseCommitRequest } from "@amime/sync";
import { describe, expect, it } from "vitest";
import { createCommitId } from "./commit-id.ts";

describe("createCommitId", () => {
	it("サーバーが受け付ける形のIDを作る", () => {
		expect(parseCommitRequest({ id: createCommitId(), changes: [] }).ok).toBe(true);
	});

	it("呼ぶたびに違うIDを作る", () => {
		expect(createCommitId()).not.toBe(createCommitId());
	});
});
