import { createConnection } from "node:net";

type Pane = { pane_id: string; label?: string | null };
type Snapshot = { sessionId: string; title: string | null; label: string | null };

type SyncPorts = {
	getSessionId(): string;
	getTitle(): string | undefined;
	setTitle(title: string): Promise<void>;
	getPane(): Promise<Pane | null>;
	renamePane(paneId: string, title: string | null): Promise<void>;
};

/** Keeps one pane and one live OMP session in sync. */
export class TitleSync {
	private previous: Snapshot | undefined;
	private generation = 0;
	private running = false;
	private pendingRename: Promise<void> | undefined;
	private closed = false;

	constructor(private readonly ports: SyncPorts) {}

	invalidate(): void {
		this.generation++;
	}

	close(): void {
		this.closed = true;
		this.invalidate();
	}

	async shutdown(): Promise<void> {
		this.close();
		// Wait for an already-issued rename before clearing the label.
		await this.pendingRename?.catch(() => {});
		const pane = await this.ports.getPane();
		if (pane) await this.ports.renamePane(pane.pane_id, null);
	}

	private async renamePane(paneId: string, title: string | null): Promise<void> {
		const pending = this.ports.renamePane(paneId, title);
		this.pendingRename = pending;
		try {
			await pending;
		} finally {
			this.pendingRename = undefined;
		}
	}

	async tick(): Promise<void> {
		if (this.running || this.closed) return;
		this.running = true;
		const generation = this.generation;
		const sessionId = this.ports.getSessionId();
		const active = () => !this.closed && generation === this.generation && sessionId === this.ports.getSessionId();
		try {
			const pane = await this.ports.getPane();
			if (!pane || !active()) return;
			const title = this.ports.getTitle() || null;
			const label = pane.label || null;
			const previous = this.previous;
			let destination: "pane" | "session" | undefined;
			let value: string | null = null;

			if (!previous || previous.sessionId !== sessionId) {
				if (title && title !== label) {
					destination = "pane";
					value = title;
				} else if (!title && label) {
					if (previous && label === previous.label) {
						destination = "pane";
					} else {
						destination = "session";
						value = label;
					}
				}
			} else {
				const titleChanged = title !== previous.title;
				const labelChanged = label !== previous.label;
				if (labelChanged && label && label !== title) {
					destination = "session";
					value = label;
				} else if ((titleChanged || labelChanged) && title !== label && title) {
					destination = "pane";
					value = title;
				}
			}

			if (destination === "pane") {
				// A rename after our read must not be overwritten by this stale snapshot.
				const current = await this.ports.getPane();
				if (!active() || !current || current.pane_id !== pane.pane_id ||
					(this.ports.getTitle() || null) !== title) return;
				if ((current.label || null) !== label) {
					if (!previous || previous.sessionId !== sessionId) this.previous = { sessionId, title, label };
					return;
				}
				await this.renamePane(current.pane_id, value);
				if (!active()) return;
				this.previous = { sessionId, title, label: value };
			} else if (destination === "session" && value) {
				if (!active() || (this.ports.getTitle() || null) !== title) return;
				await this.ports.setTitle(value);
				if (!active()) return;
				// OMP canonicalizes control characters and whitespace in session titles.
				const actualTitle = this.ports.getTitle() || null;
				if (actualTitle && actualTitle !== label) {
					const current = await this.ports.getPane();
					if (!active() || !current || current.pane_id !== pane.pane_id || (current.label || null) !== label ||
						(this.ports.getTitle() || null) !== actualTitle) return;
					await this.renamePane(current.pane_id, actualTitle);
					if (!active()) return;
				}
				this.previous = { sessionId, title: actualTitle, label: actualTitle || label };
			} else {
				this.previous = { sessionId, title, label };
			}
		} finally {
			this.running = false;
		}
	}
}

type HerdrReply = { id?: string; result?: { pane?: Pane & { agent?: string | null; agent_session?: { kind?: string; value?: string } | null } }; error?: { code?: string; message?: string } };

function herdrRequest(socketPath: string, method: string, params: Record<string, unknown>): Promise<HerdrReply> {
	const { promise, resolve, reject } = Promise.withResolvers<HerdrReply>();
	const id = `omp-herdr-title-sync:${crypto.randomUUID()}`;
	const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
	const socket = createConnection(endpoint);
	socket.setEncoding("utf8");
	let data = "";
	let done = false;
	const finish = (error?: Error, reply?: HerdrReply) => {
		if (done) return;
		done = true;
		socket.destroy();
		if (error) reject(error);
		else resolve(reply!);
	};
	socket.setTimeout(1500, () => finish(new Error("Herdr request timed out")));
	socket.on("error", error => finish(error));
	socket.on("end", () => finish(new Error("Herdr closed the connection without a response")));
	socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
	socket.on("data", chunk => {
		data += chunk;
		if (data.length > 1024 * 1024) return finish(new Error("Herdr response too large"));
		const newline = data.indexOf("\n");
		if (newline < 0) return;
		try {
			const reply = JSON.parse(data.slice(0, newline)) as HerdrReply;
			if (reply.id !== id) return finish(new Error("Herdr response ID mismatch"));
			if (reply.error) return finish(new Error(`Herdr ${method} failed: ${reply.error.code ?? "unknown"}`));
			if (!reply.result) return finish(new Error("Herdr response has no result"));
			finish(undefined, reply);
		} catch (error) {
			finish(error instanceof Error ? error : new Error("Invalid Herdr response"));
		}
	});
	return promise;
}

type Context = {
	mode: string;
	agent: { kind: string };
	sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
	setInterval(callback: () => void, ms: number): NodeJS.Timeout;
	clearTimer(timer: NodeJS.Timeout): void;
};
type Extension = {
	on(event: string, handler: (event: unknown, context: Context) => void): void;
	getSessionName(): string | undefined;
	setSessionName(name: string): Promise<void>;
	logger: { warn(message: string, metadata?: Record<string, unknown>): void };
};

export default function herdrTitleSync(pi: Extension): void {
	let context: Context;
	let timer: NodeJS.Timeout | undefined;
	let sync: TitleSync | undefined;
	let failed = false;
	const paneId = process.env.HERDR_PANE_ID;
	const socketPath = process.env.HERDR_SOCKET_PATH;

	const run = () => {
		if (!sync) return;
		void sync.tick().then(() => { failed = false; }, error => {
			if (!failed) pi.logger.warn("Herdr title synchronization failed", { error: String(error) });
			failed = true;
		});
	};

	pi.on("session_start", (_event, ctx) => {
		if (process.env.HERDR_ENV !== "1" || !paneId || !socketPath || process.env.OMPCODE === "1" ||
			ctx.agent?.kind !== "main" || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
		if (timer && context) context.clearTimer(timer);
		sync?.close();
		context = ctx;
		sync = new TitleSync({
			getSessionId: () => context.sessionManager.getSessionId(),
			getTitle: () => pi.getSessionName(),
			setTitle: title => pi.setSessionName(title),
			async getPane() {
				const reply = await herdrRequest(socketPath, "pane.current", { caller_pane_id: paneId });
				const pane = reply.result?.pane;
				if (!pane || pane.agent !== "omp") return null;
				const sessionFile = context.sessionManager.getSessionFile();
				if (sessionFile && pane.agent_session?.kind === "path" && pane.agent_session.value !== sessionFile) return null;
				return pane;
			},
			async renamePane(id, label) {
				await herdrRequest(socketPath, "pane.rename", { pane_id: id, label });
			},
		});
		timer = ctx.setInterval(run, 1000);
		run();
	});
	pi.on("session_switch", (_event, ctx) => {
		if (!sync) return;
		context = ctx;
		sync.invalidate();
		run();
	});
	pi.on("session_shutdown", async () => {
		if (timer && context) context.clearTimer(timer);
		timer = undefined;
		const current = sync;
		sync = undefined;
		try {
			await current?.shutdown();
		} catch (error) {
			pi.logger.warn("Herdr pane label cleanup failed", { error: String(error) });
		}
	});
}
