import { describe, expect, it, vi } from "vitest";
import { createChannel } from "./channel.ts";

describe("createChannel", () => {
	it("送った値を、登録してある相手に、送った順に届ける", () => {
		const channel = createChannel<number>();
		const received: number[] = [];
		channel.subscribe((value) => received.push(value));

		channel.emit(1);
		channel.emit(2);

		expect(received).toEqual([1, 2]);
	});

	it("登録をやめた相手には届けない", () => {
		const channel = createChannel<number>();
		const listener = vi.fn();
		const stop = channel.subscribe(listener);

		stop();
		channel.emit(1);

		expect(listener).not.toHaveBeenCalled();
	});
});
