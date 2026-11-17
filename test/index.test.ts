import { describe, expect, test } from "bun:test";
import { TitleSync } from "../index.ts";

function fixture(title: string | undefined, label: string | null) {
	const state = { session: "s1", title, label, paneId: "w1:p1", writes: [] as string[] };
	const sync = new TitleSync({
		getSessionId: () => state.session,
		getTitle: () => state.title,
		async setTitle(value) {
			state.writes.push(`session:${value}`);
			state.title = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/ +/g, " ").trim();
		},
		async getPane() { return { pane_id: state.paneId, label: state.label }; },
		async renamePane(_id, value) { state.writes.push(`pane:${value}`); state.label = value; },
	});
	return { state, sync };
}

describe("TitleSync", () => {
	test("session title initializes the pane and later changes propagate in both directions without a loop", async () => {
		const { state, sync } = fixture("原会话", "旧名称");
		await sync.tick();
		expect(state.label).toBe("原会话");
		state.title = "新的 agent 标题";
		await sync.tick();
		expect(state.label).toBe("新的 agent 标题");
		state.label = "新的 pane 名称";
		await sync.tick();
		expect(state.title).toBe("新的 pane 名称");
		const writes = state.writes.length;
		await sync.tick();
		expect(state.writes.length).toBe(writes);
	});

	test("a named pane initializes an untitled session", async () => {
		const { state, sync } = fixture(undefined, "手动名称");
		await sync.tick();
		expect(state.title).toBe("手动名称");
	});

	test("simultaneous changes prefer the pane and clearing a label restores the nonempty title", async () => {
		const { state, sync } = fixture("原名称", "原名称");
		await sync.tick();
		state.title = "会话新名称";
		state.label = "窗格新名称";
		await sync.tick();
		expect(state.title).toBe("窗格新名称");
		state.label = null;
		await sync.tick();
		expect(state.label).toBe("窗格新名称");
	});

	test("session changes do not copy the previous session name into an untitled session", async () => {
		const { state, sync } = fixture("第一会话", null);
		await sync.tick();
		state.session = "s2";
		state.title = undefined;
		sync.invalidate();
		await sync.tick();
		expect(state.label).toBeNull();
		expect(state.title).toBeUndefined();
		state.title = "第二会话";
		await sync.tick();
		expect(state.label).toBe("第二会话");
	});

	test("a manual pane rename during a session switch is preserved", async () => {
		const { state, sync } = fixture("第一会话", null);
		await sync.tick();
		state.session = "s2";
		state.title = undefined;
		state.label = "手动新名称";
		sync.invalidate();
		await sync.tick();
		expect(state.title).toBe("手动新名称");
	});

	test("syncs the title normalized by OMP back to the pane", async () => {
		const { state, sync } = fixture("旧名称", "旧名称");
		await sync.tick();
		state.label = "新  标题";
		await sync.tick();
		expect(state.title).toBe("新 标题");
		expect(state.label).toBe("新 标题");
	});

	test("does not overwrite a pane renamed after the snapshot", async () => {
		let title = "标题 A";
		let label: string | null = "名称 A";
		let reads = 0;
		const sync = new TitleSync({
			getSessionId: () => "s1",
			getTitle: () => title,
			async setTitle(value) { title = value; },
			async getPane() {
				if (++reads === 2) label = "用户新名称";
				return { pane_id: "w1:p1", label };
			},
			async renamePane(_id, value) { label = value; },
		});
		await sync.tick();
		expect(label).toBe("用户新名称");
		await sync.tick();
		expect(label).toBe("用户新名称");
		expect(title).toBe("用户新名称");
	});

	test("an in-flight old-session read is discarded after a switch", async () => {
		const gate = Promise.withResolvers<void>();
		let session = "s1";
		let title = "旧会话";
		let label: string | null = null;
		const sync = new TitleSync({
			getSessionId: () => session,
			getTitle: () => title,
			async setTitle(value) { title = value; },
			async getPane() { await gate.promise; return { pane_id: "w1:p1", label }; },
			async renamePane(_id, value) { label = value; },
		});
		const pending = sync.tick();
		session = "s2";
		title = "新会话";
		sync.invalidate();
		gate.resolve();
		await pending;
		expect(label).toBeNull();
		await sync.tick();
		expect(label).toBe("新会话");
	});

	test("a failed pane rename is retried and shutdown stops further writes", async () => {
		let label: string | null = null;
		let attempts = 0;
		const sync = new TitleSync({
			getSessionId: () => "s1",
			getTitle: () => "标题",
			async setTitle() {},
			async getPane() { return { pane_id: "w1:p1", label }; },
			async renamePane(_id, value) {
				if (++attempts === 1) throw new Error("disconnected");
				label = value;
			},
		});
		await expect(sync.tick()).rejects.toThrow("disconnected");
		await sync.tick();
		expect(label).toBe("标题");
		sync.close();
		label = "关闭后用户名称";
		await sync.tick();
		expect(label).toBe("关闭后用户名称");
	});
	test("shutdown clears the pane after an in-flight rename completes", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let label: string | null = null;
		const sync = new TitleSync({
			getSessionId: () => "s1",
			getTitle: () => "标题",
			async setTitle() {},
			async getPane() { return { pane_id: "w1:p1", label }; },
			async renamePane(_id, value) {
				if (value) {
					started.resolve();
					await release.promise;
				}
				label = value;
			},
		});
		const tick = sync.tick();
		await started.promise;
		const shutdown = sync.shutdown();
		release.resolve();
		await Promise.all([tick, shutdown]);
		expect(label).toBeNull();
		await sync.tick();
		expect(label).toBeNull();
	});
});
