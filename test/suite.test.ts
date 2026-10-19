import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../src/app/start.ts";
import { Client } from "../src/cli/client.ts";
import { parseCase } from "../src/core/markdown.ts";
import { applyMergeChoice, type Conflict } from "../src/core/merge3.ts";
import { CaseBody, type ConflictAddress, emptyBody } from "../src/core/model.ts";
import { type DecideReply, type Edit, ProposeReply } from "../src/core/ops.ts";
import { PRESETS } from "../src/core/presets.ts";
import { actorByName } from "../src/server/identity/identity.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { Db } from "../src/server/kernel/db.ts";
import { ARCHIVE_VERSION } from "../src/server/kernel/migrate.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke, invokeAsync, type Reply } from "../src/server/ops/registry.ts";
import { exportArchive, importArchive, linesOf, removeBootstrap } from "../src/server/transfer/transfer.ts";
import { serve } from "../src/surfaces/http.ts";
import legacyConflicts from "./fixtures/legacy-conflicts.json";
import { ciReport, type Harness, harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
	h = harness();
});
afterEach(() => h.close());

type Proposed = {
	proposal: string | null;
	status: string;
	question: string | null;
	cases: { ref: string; version: number; hash: string }[];
	conflicts: { case: string; addresses: ConflictAddress[] }[];
};
type CaseView = {
	ref: string;
	title: string;
	version: number;
	hash: string;
	steps: { id: string; action: string; expected: string | null }[];
	tags: string[];
	covers: string[];
	folder: { path: string };
};

const OUTLINE = `Checkout applies a percentage coupon #checkout @WEB-290
  Open the cart with one $100.00 item
  Apply coupon SAVE10 > Total shows $90.00
  Reload the page => Coupon is still applied`;

const storedBody = () => {
	const [result] = h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" });
	const parsed = parseCase(result?.md ?? "");
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
	return parsed.doc.body;
};

describe("atomic bulk proposals", () => {
	const count = 450;
	const creates = (): Edit[] =>
		Array.from({ length: count }, (_, i) => ({ op: "create", outline: `Bulk case ${i}\n  Check > Pass` }));
	const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
	const disk = () => {
		const dir = mkdtempSync(join(tmpdir(), "mainworthy-bulk-"));
		const config = defaultConfig({ MAINWORTHY_DATA: dir, MAINWORTHY_OWNER: "robin" });
		const instance = open(config);
		const call = (op: string, input: unknown = {}) => ({ op, input, project: "scratch", actor: () => instance.owner });
		const raw = (op: string, input: unknown = {}) => invoke(instance.app, OPS, call(op, input));
		return {
			...instance,
			config,
			call,
			raw,
			close() {
				instance.app.close();
				rmSync(dir, { recursive: true, force: true });
			},
		};
	};
	const result = <T>(reply: Reply): T => {
		if (!reply.ok) throw new Error(JSON.stringify(reply.error));
		return reply.result as T;
	};
	const storedCount = (instance: ReturnType<typeof disk>, table: "cases" | "versions" | "decisions") =>
		instance.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
	const acceptance = (instance: ReturnType<typeof disk>, proposed: ProposeReply) => {
		const question = result<{ evidenceHash: string }[]>(instance.raw("get", { refs: [proposed.question] }))[0];
		return {
			q: proposed.question,
			onEvidence: question?.evidenceHash,
			answer: { is: "accept" },
			reason: "Reviewed all cases",
		};
	};
	const strict = (instance: ReturnType<typeof disk>) => {
		const policy = result<ProposeReply>(instance.raw("propose", { edits: [{ op: "policy", preset: "strict" }] }));
		expect(result<DecideReply[]>(instance.raw("decide", acceptance(instance, policy)))[0]?.status).toBe("decided");
	};

	test.each(["map", "finding", "policy"] as const)(
		"case creation from %s answers yields without publishing partial effects",
		async (kind) => {
			const instance = disk();
			try {
				const total = kind === "finding" ? 200 : count;
				const questionKind = kind === "finding" ? "finding" : "map";
				if (kind !== "finding") {
					const policy = result<ProposeReply>(instance.raw("propose", { edits: [{ op: "policy", unlinked: "ask" }] }));
					expect(result<DecideReply[]>(instance.raw("decide", acceptance(instance, policy)))[0]?.status).toBe(
						"decided",
					);
					result(instance.raw("report", ciReport({ commit: "ba1c0001", n: total })));
				} else {
					result(
						instance.raw("claim", {
							lens: "coverage",
							findings: Array.from({ length: total }, (_, i) => ({
								on: `req:bulk-${i}`,
								category: "uncovered-path",
								note: `Missing path ${i}`,
								suggest: { case: { title: `Suggested ${i}`, steps: ["Check > Pass"] } },
							})),
						}),
					);
				}
				const questions = result<{ items: { q: string; evidenceHash: string }[] }>(
					instance.raw("inbox", { kind: questionKind, limit: 200 }),
				).items;
				expect(questions).toHaveLength(kind === "finding" ? total : 1);
				const pendingPolicy =
					kind === "policy"
						? result<ProposeReply>(instance.raw("propose", { edits: [{ op: "policy", unlinked: "create" }] }))
						: null;
				const input = {
					all: pendingPolicy
						? [acceptance(instance, pendingPolicy)]
						: questions.map((question) => ({
								q: question.q,
								onEvidence: question.evidenceHash,
								answer: kind === "map" ? { is: "create" } : { is: "accept", apply: true },
							})),
					cmd: `bulk-${kind}`,
				};
				let done = false;
				const saving = invokeAsync(instance.app, OPS, instance.call("decide", input));
				void saving.then(() => {
					done = true;
				});
				let partial = false;
				while (!done) {
					await tick();
					const written = storedCount(instance, "cases");
					if (done || written === 0 || written === total) continue;
					partial = true;
					expect(result(instance.raw("find"))).toMatchObject({ count: 0, items: [] });
					expect(
						result<{ items: unknown[] }>(instance.raw("inbox", { kind: questionKind, limit: 200 })).items,
					).toHaveLength(questions.length);
				}
				const saved = result<DecideReply[]>(await saving);
				expect(saved.map((reply) => reply.status)).toEqual(questions.map(() => "decided"));
				expect(result(instance.raw("find"))).toMatchObject({ count: total });
				expect(result(instance.raw("inbox", { kind: questionKind }))).toMatchObject({ items: [] });
				expect(result<DecideReply[]>(await invokeAsync(instance.app, OPS, instance.call("decide", input)))).toEqual(
					saved,
				);
				if (kind !== "finding") {
					const receipt = result<{ basis: { assumed: number; unresolved: number } }>(
						instance.raw("report", ciReport({ commit: "ba1c0002", n: total })),
					);
					expect(receipt.basis).toMatchObject({ assumed: total, unresolved: 0 });
				}
				expect(partial).toBe(true);
			} finally {
				await instance.app.gate.run(() => {});
				instance.close();
			}
		},
	);

	test("sealing a bulk proposal that needs review also answers reads before publishing it", async () => {
		const instance = disk();
		try {
			strict(instance);
			let done = false;
			const sealing = invokeAsync(instance.app, OPS, instance.call("propose", { edits: creates() }));
			void sealing.then(() => {
				done = true;
			});
			let during = false;
			while (!done) {
				await tick();
				if (done) break;
				during = true;
				expect(result(instance.raw("find"))).toMatchObject({ count: 0 });
				expect(instance.raw("get", { refs: ["P-2"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
			}
			const proposed = result<ProposeReply>(await sealing);
			expect(proposed).toMatchObject({ proposal: "P-2", status: "open", cases: [] });
			expect(result<unknown[]>(instance.raw("get", { refs: [proposed.proposal] }))[0]).toMatchObject({ ref: "P-2" });
			expect(during).toBe(true);
		} finally {
			await instance.app.gate.run(() => {});
			instance.close();
		}
	});

	test("sealing a 5,000-case fragment move answers reads even when its last case conflicts", async () => {
		const instance = disk();
		try {
			result(
				instance.raw("propose", {
					edits: [
						{
							op: "create",
							kind: "fragment",
							body: {
								title: "Sign in",
								steps: [{ id: "ab", action: "Password", expected: "Signed in" }],
							},
						},
					],
				}),
			);
			const created = result<ProposeReply>(
				instance.raw("propose", {
					edits: Array.from({ length: 5000 }, (_, i) => ({
						op: "create",
						body: {
							title: `Consumer ${i}`,
							steps: [{ id: "cd", use: { fragment: "C-1", version: 1 } }],
						},
					})),
				}),
			);
			result(
				instance.raw("propose", {
					edits: [
						{
							op: "edit",
							case: "C-1",
							base: 1,
							body: { steps: [{ id: "ab", action: "Passkey", expected: "Signed in" }] },
						},
						{ op: "edit", case: "C-5001", base: 1, body: { title: "Changed consumer" } },
					],
				}),
			);
			const before = {
				versions: storedCount(instance, "versions"),
				decisions: storedCount(instance, "decisions"),
			};
			const edits: Edit[] = [
				{
					op: "fragment",
					fragment: "C-1",
					from: 1,
					to: 2,
					cases: created.cases.map(({ ref }) => ({ case: ref, base: 1 })),
				},
			];
			let done = false;
			const moving = invokeAsync(instance.app, OPS, instance.call("propose", { edits }));
			void moving.then(() => {
				done = true;
			});
			let readDuringSealing = false;
			while (!done) {
				await tick();
				if (done) break;
				expect(
					result<unknown[]>(await invokeAsync(instance.app, OPS, instance.call("get", { refs: ["C-2", "C-5001"] }))),
				).toMatchObject([
					{ version: 1, steps: [{ action: "Password", source: { version: 1 } }] },
					{ version: 2, title: "Changed consumer", steps: [{ action: "Password", source: { version: 1 } }] },
				]);
				readDuringSealing = true;
			}
			expect(await moving).toMatchObject({
				ok: false,
				error: {
					code: "conflict",
					message: "C-5001 changed; redo the fragment batch",
				},
			});
			expect(storedCount(instance, "versions")).toBe(before.versions);
			expect(storedCount(instance, "decisions")).toBe(before.decisions);
			expect(instance.raw("get", { refs: ["P-4"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
			expect(readDuringSealing).toBe(true);

			const retry = invokeAsync(
				instance.app,
				OPS,
				instance.call("propose", {
					edits: [
						{
							op: "fragment",
							fragment: "C-1",
							from: 1,
							to: 2,
							cases: created.cases.map(({ ref }) => ({ case: ref, base: ref === "C-5001" ? 2 : 1 })),
						},
					],
				}),
			);
			done = false;
			void retry.then(() => {
				done = true;
			});
			while (!done) {
				await tick();
				if (done) break;
				expect(result<unknown[]>(instance.raw("get", { refs: ["C-2", "C-5001"] }))).toMatchObject([
					{ version: 1, steps: [{ action: "Password", source: { version: 1 } }] },
					{ version: 2, steps: [{ action: "Password", source: { version: 1 } }] },
				]);
			}
			const adopted = result<ProposeReply>(await retry);
			expect(adopted.status).toBe("adopted");
			expect(adopted.cases).toHaveLength(5000);
			expect(storedCount(instance, "versions")).toBe(before.versions + 5000);
			expect(storedCount(instance, "decisions")).toBe(before.decisions + 1);
			expect(result<unknown[]>(instance.raw("get", { refs: ["C-2", "C-5001"] }))).toMatchObject([
				{ version: 2, steps: [{ action: "Passkey", source: { version: 2 } }] },
				{ version: 3, title: "Changed consumer", steps: [{ action: "Passkey", source: { version: 2 } }] },
			]);
		} finally {
			await instance.app.gate.run(() => {});
			instance.close();
		}
	}, 30000);

	test("a bulk save answers reads between slices and publishes the complete proposal and decision once", async () => {
		const instance = disk();
		try {
			const events: unknown[] = [];
			instance.app.subscribe((event) => events.push(event));
			let done = false;
			const saving = invokeAsync(
				instance.app,
				OPS,
				instance.call("propose", { edits: creates(), cmd: "bulk-save-01" }),
			);
			void saving.then(() => {
				done = true;
			});
			let partial = false;
			while (!done) {
				await tick();
				const written = storedCount(instance, "cases");
				if (written === 0 || written === count) continue;
				partial = true;
				expect(result(instance.raw("find"))).toMatchObject({ count: 0, items: [] });
				expect(instance.raw("get", { refs: ["P-1"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
				expect(result(instance.raw("inbox"))).toMatchObject({ items: [] });
				expect(events).toHaveLength(0);
			}
			const saved = result<ProposeReply>(await saving);
			expect(saved.status).toBe("adopted");
			expect(saved.cases).toHaveLength(count);
			expect(result(instance.raw("find"))).toMatchObject({ count });
			expect(storedCount(instance, "versions")).toBe(count);
			expect(storedCount(instance, "decisions")).toBe(1);
			expect(events).toHaveLength(1);
			expect(partial).toBe(true);
			expect(
				result<ProposeReply>(
					await invokeAsync(instance.app, OPS, instance.call("propose", { edits: creates(), cmd: "bulk-save-01" })),
				),
			).toEqual(saved);
			expect(storedCount(instance, "versions")).toBe(count);
		} finally {
			await instance.app.gate.run(() => {});
			instance.close();
		}
	});

	test("accepting a bulk proposal answers reads without exposing half its cases or a decided question", async () => {
		const instance = disk();
		try {
			strict(instance);
			const proposed = result<ProposeReply>(instance.raw("propose", { edits: creates() }));
			expect(proposed.status).toBe("open");
			const question = result<{ evidenceHash: string }[]>(instance.raw("get", { refs: [proposed.question] }))[0];
			let done = false;
			const accepting = invokeAsync(
				instance.app,
				OPS,
				instance.call("decide", {
					q: proposed.question,
					onEvidence: question?.evidenceHash,
					answer: { is: "accept" },
					reason: "Reviewed all cases",
				}),
			);
			void accepting.then(() => {
				done = true;
			});
			let partial = false;
			while (!done) {
				await tick();
				const written = storedCount(instance, "cases");
				if (written === 0 || written === count) continue;
				partial = true;
				expect(result(instance.raw("find"))).toMatchObject({ count: 0 });
				expect(result(instance.raw("find", { text: "Bulk" }))).toMatchObject({ count: 0 });
				expect(result<unknown[]>(instance.raw("get", { refs: [proposed.question] }))[0]).toMatchObject({
					state: "open",
				});
			}
			expect(result<DecideReply[]>(await accepting)[0]).toMatchObject({
				status: "decided",
				effects: { cases: expect.any(Array) },
			});
			expect(result(instance.raw("find"))).toMatchObject({ count });
			expect(result<unknown[]>(instance.raw("get", { refs: [proposed.question] }))[0]).toMatchObject({
				state: "decided",
			});
			expect(partial).toBe(true);
		} finally {
			await instance.app.gate.run(() => {});
			instance.close();
		}
	});

	test.each(["edit", "place", "state"] as const)(
		"a bulk %s keeps every case at its previous state between slices",
		async (op) => {
			const instance = disk();
			try {
				const created = result<ProposeReply>(instance.raw("propose", { edits: creates() }));
				const refs = created.cases.map((row) => row.ref);
				const edits: Edit[] =
					op === "edit"
						? refs.map((ref) => ({ op: "edit", case: ref, base: 1, body: { title: `Changed ${ref}` } }))
						: op === "place"
							? [{ op, cases: refs, tags: { add: ["changed"] }, folder: "Moved" }]
							: [{ op, cases: refs, to: "archived" }];
				const condition = op === "edit" ? "head = 2" : op === "place" ? "tags = '[\"changed\"]'" : "state = 'archived'";
				let done = false;
				const saving = invokeAsync(instance.app, OPS, instance.call("propose", { edits }));
				void saving.then(() => {
					done = true;
				});
				let partial = false;
				while (!done) {
					await tick();
					const changed =
						instance.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM cases WHERE ${condition}`).get()
							?.n ?? 0;
					if (changed === 0 || changed === count) continue;
					partial = true;
					expect(result(instance.raw("find"))).toMatchObject({ count });
					expect(result<unknown[]>(instance.raw("get", { refs: ["C-1", `C-${count}`] }))).toMatchObject([
						{ title: "Bulk case 0", version: 1, tags: [], state: "active" },
						{ title: `Bulk case ${count - 1}`, version: 1, tags: [], state: "active" },
					]);
				}
				expect(result<ProposeReply>(await saving).status).toBe("adopted");
				expect(
					instance.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM cases WHERE ${condition}`).get()?.n,
				).toBe(count);
				expect(partial).toBe(true);
			} finally {
				await instance.app.gate.run(() => {});
				instance.close();
			}
		},
	);

	test("a late adoption conflict rolls back earlier slices and leaves the next batched answer usable", async () => {
		const instance = disk();
		try {
			strict(instance);
			const edits = creates();
			edits.push({ op: "create", outline: "Last case", aliases: ["bulk:last"] });
			const pending = result<ProposeReply>(instance.raw("propose", { edits }));
			const competitor = result<ProposeReply>(
				instance.raw("propose", { edits: [{ op: "create", outline: "Alias holder", aliases: ["bulk:last"] }] }),
			);
			expect(result<DecideReply[]>(instance.raw("decide", acceptance(instance, competitor)))[0]?.status).toBe(
				"decided",
			);
			const next = result<ProposeReply>(instance.raw("propose", { edits: [{ op: "create", outline: "Next answer" }] }));
			const replies = result<DecideReply[]>(
				await invokeAsync(
					instance.app,
					OPS,
					instance.call("decide", {
						all: [acceptance(instance, pending), acceptance(instance, next)],
					}),
				),
			);
			expect(replies.map((reply) => reply.status)).toEqual(["conflict", "decided"]);
			expect(replies[0]?.needs).toBe("case alias bulk:last is already in use");
			expect(result(instance.raw("find"))).toMatchObject({ count: 2 });
			expect(storedCount(instance, "versions")).toBe(2);
			expect(storedCount(instance, "decisions")).toBe(3);
			expect(result<unknown[]>(instance.raw("get", { refs: [pending.question] }))[0]).toMatchObject({ state: "open" });
			expect(result<CaseView[]>(instance.raw("get", { refs: ["C-1", "C-2"] })).map((row) => row.title)).toEqual([
				"Alias holder",
				"Next answer",
			]);
		} finally {
			await instance.app.gate.run(() => {});
			instance.close();
		}
	});

	test.each(["propose", "decide"])(
		"a process killed between %s slices leaves no partial adoption after restart",
		async (op) => {
			const instance = disk();
			let child: ReturnType<typeof Bun.spawn> | undefined;
			try {
				let input: unknown = { edits: creates(), cmd: "bulk-crash-01" };
				let pending: ProposeReply | undefined;
				if (op === "decide") {
					strict(instance);
					pending = result<ProposeReply>(instance.raw("propose", { edits: creates() }));
					input = { ...acceptance(instance, pending), cmd: "bulk-crash-01" };
				}
				const before = storedCount(instance, "decisions");
				const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
				const running = Bun.spawn(
					[
						process.execPath,
						"-e",
						`
import { OPS } from ${module("../src/server/ops/index.ts")};
import { invokeAsync } from ${module("../src/server/ops/registry.ts")};
import { open } from ${module("../src/app/start.ts")};
const { config, op, input } = JSON.parse(await Bun.stdin.text());
const { app, owner } = open(config);
const operation = OPS[op];
if (!("steps" in operation)) throw new Error("the bulk operation has no slices");
const paused = { ...operation, *steps(ctx, input) {
	const steps = operation.steps(ctx, input);
	for (let step = steps.next(); ; step = steps.next()) {
		if (step.done) return step.value;
		const count = app.db.raw.query("SELECT count(*) AS n FROM cases").get().n;
		if (count > 0 && count < ${count}) {
			process.stdout.write("PARTIAL " + count + "\\n");
			for (;;) yield;
		}
		yield step.value;
	}
} };
await invokeAsync(app, { ...OPS, [op]: paused }, { op, project: "scratch", input, actor: () => owner });
throw new Error("the operation completed without a partial adoption slice");
`,
					],
					{ stdin: new Blob([JSON.stringify({ config: instance.config, op, input })]), stdout: "pipe", stderr: "pipe" },
				);
				child = running;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const output = await Promise.race([
						running.stdout.getReader().read(),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error("no adoption slice within five seconds")), 5000);
						}),
					]);
					expect(new TextDecoder().decode(output.value)).toMatch(/^PARTIAL \d+\n$/);
				} finally {
					clearTimeout(timer);
				}
				child.kill("SIGKILL");
				await child.exited;
				const restarted = open(instance.config);
				try {
					const raw = (operation: string, body: unknown = {}) =>
						invoke(restarted.app, OPS, {
							op: operation,
							project: "scratch",
							input: body,
							actor: () => restarted.owner,
						});
					expect(result(raw("find"))).toMatchObject({ count: 0 });
					for (const table of ["cases", "versions", "placements", "search_docs", "commands"]) {
						expect(restarted.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(
							0,
						);
					}
					expect(restarted.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM decisions").get()?.n).toBe(
						before,
					);
					if (pending)
						expect(result<unknown[]>(raw("get", { refs: [pending.question] }))[0]).toMatchObject({ state: "open" });
					else expect(raw("get", { refs: ["P-1"] })).toMatchObject({ ok: false, error: { code: "not_found" } });
					const retried = raw(op, input);
					expect(retried.ok).toBe(true);
					expect(raw(op, input)).toEqual(retried);
					expect(result(raw("find"))).toMatchObject({ count });
					expect(restarted.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM versions").get()?.n).toBe(
						count,
					);
					expect(restarted.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM decisions").get()?.n).toBe(
						before + 1,
					);
				} finally {
					restarted.app.close();
				}
			} finally {
				if (child) {
					child.kill("SIGKILL");
					await child.exited;
				}
				instance.close();
			}
		},
	);
});

describe("capture", () => {
	test("an outline becomes C-1, version 1, with steps, expected results, a tag and a requirement", () => {
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "create", outline: OUTLINE, folder: "checkout/coupons" }],
		});
		expect(reply.status).toBe("adopted");
		expect(reply.cases).toEqual([{ ref: "C-1", version: 1, hash: expect.any(String) }]);
		const [view] = h.call<CaseView[]>("get", { refs: ["C-1"] });
		expect(view?.title).toBe("Checkout applies a percentage coupon");
		expect(view?.steps.map((s) => [s.action, s.expected])).toEqual([
			["Open the cart with one $100.00 item", null],
			["Apply coupon SAVE10", "Total shows $90.00"],
			["Reload the page", "Coupon is still applied"],
		]);
		expect(view?.tags).toEqual(["checkout"]);
		expect(view?.covers).toEqual(["WEB-290"]);
		expect(view?.folder.path).toBe("checkout/coupons");
	});

	test("suite writes clean Unicode folder paths and tags", () => {
		h.call("propose", {
			edits: [{ op: "create", outline: "Unicode", folder: " Cafe\u0301\u200b / Child ", tags: ["#Crit\u200bical"] }],
		});
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]).toMatchObject({
			folder: { path: "Café/Child" },
			tags: ["critical"],
		});
		h.call("propose", {
			edits: [{ op: "place", cases: ["C-1"], folder: "Re\u0301sume\u0301", tags: { set: ["re\u200bview"] } }],
		});
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]).toMatchObject({
			folder: { path: "Résumé" },
			tags: ["review"],
		});
	});

	test("folder creation and rename use the same Unicode cleaning as paths", () => {
		h.call("propose", { edits: [{ op: "folder", name: " Cafe\u0301\u200b " }] });
		h.call("propose", { edits: [{ op: "create", outline: "Unicode", folder: "Café" }] });
		expect(h.call<{ items: unknown[] }>("find", { in: "folders" }).items.length).toBe(1);
		h.call("propose", { edits: [{ op: "folder", folder: "Café", name: " Re\u0301sume\u0301\u200b " }] });
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]?.folder.path).toBe("Résumé");
	});

	test.each([
		["Checkout", "Checkout"],
		["check\u200bout", "checkout"],
	])("a rename cannot hide a sibling's cases at %s", (name, path) => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "Checkout case", folder: "Checkout" },
				{ op: "create", outline: "Refund case", folder: "Refunds" },
			],
		});
		expect(h.raw("propose", { edits: [{ op: "folder", folder: "Refunds", name }] })).toMatchObject({
			ok: false,
			error: { code: "invalid", message: `folder path "${path}" is already in use; choose another name or parent` },
		});
		expect(h.call<{ items: { path: string }[] }>("find", { in: "folders" }).items.map((row) => row.path)).toEqual([
			"Checkout",
			"Refunds",
		]);
		expect(h.call("find", { folder: "Checkout" })).toMatchObject({ count: 1, items: [{ ref: "C-1" }] });
		expect(h.call("find", { folder: "Refunds" })).toMatchObject({ count: 1, items: [{ ref: "C-2" }] });
		expect(h.call("find")).toMatchObject({ count: 2 });
		expect(h.call("plan", { name: "Checkout regression", select: { folders: ["Checkout"] } })).toMatchObject({
			run: "R-1",
			slots: 1,
		});
		expect(h.call("plan", { name: "Both folders", select: { folders: ["Checkout", "Refunds"] } })).toMatchObject({
			run: "R-2",
			slots: 2,
		});
	});

	test.each([false, true])("legacy duplicate paths allow edits and repairs, new folder first: %s", (first) => {
		const names = first ? ["Public", "Checkout", "Refunds"] : ["Checkout", "Refunds", "Public"];
		h.call("propose", {
			edits: [
				...names.map((name) => ({ op: "folder", name })),
				{ op: "create", outline: "Unrelated", folder: "Public" },
			],
		});
		const duplicate = h
			.call<{ items: { id: number; path: string }[] }>("find", { in: "folders" })
			.items.find((row) => row.path === "Refunds");
		if (!duplicate) throw new Error("no folder to duplicate");
		h.app.db.raw.query("UPDATE folders SET name = 'Checkout' WHERE id = ?").run(duplicate.id);
		expect(
			h.raw("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Updated" } }] }),
		).toMatchObject({ ok: true, result: { status: "adopted" } });
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]).toMatchObject({
			title: "Updated",
			version: 2,
			folder: { path: "Public" },
		});
		expect(
			h
				.call<{ items: { path: string }[] }>("find", { in: "folders" })
				.items.map((row) => row.path)
				.sort(),
		).toEqual(["Checkout", "Checkout", "Public"]);
		expect(h.raw("propose", { edits: [{ op: "folder", folder: "Public", name: "Checkout" }] })).toMatchObject({
			ok: false,
			error: {
				code: "invalid",
				message: 'folder path "Checkout" is already in use; choose another name or parent',
			},
		});
		expect(
			h.call<Proposed>("propose", {
				edits: [{ op: "folder", folder: duplicate.id, name: "Repaired" }],
			}).status,
		).toBe("adopted");
		expect(
			h
				.call<{ items: { path: string }[] }>("find", { in: "folders" })
				.items.map((row) => row.path)
				.sort(),
		).toEqual(["Checkout", "Public", "Repaired"]);
	});

	test("two renames cannot create the same final folder path", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "First", folder: "Public/First" },
				{ op: "create", outline: "Second", folder: "Public/Second" },
			],
		});
		expect(
			h.raw("propose", {
				edits: [
					{ op: "folder", folder: "Public", name: "Checkout" },
					{ op: "folder", folder: "Public/First", name: "Secure" },
					{ op: "folder", folder: "Public/Second", name: "Secure" },
				],
			}),
		).toMatchObject({
			ok: false,
			error: {
				code: "invalid",
				message: 'folder path "Checkout/Secure" is already in use; choose another name or parent',
			},
		});
		expect(h.call<CaseView[]>("get", { refs: ["C-1", "C-2"] }).map((row) => row.folder.path)).toEqual([
			"Public/First",
			"Public/Second",
		]);
	});

	test("creating or moving a folder cannot duplicate a canonical sibling path", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "Existing", folder: "Parent/Café" },
				{ op: "create", outline: "Moving", folder: "Other/Café" },
			],
		});
		for (const edit of [
			{ op: "folder", parent: "Parent", name: "CAFE\u0301" },
			{ op: "folder", folder: "Other/Café", parent: "Parent" },
		])
			expect(h.raw("propose", { edits: [edit] })).toMatchObject({ ok: false, error: { code: "invalid" } });
		expect(h.call<CaseView[]>("get", { refs: ["C-1", "C-2"] }).map((row) => row.folder.path)).toEqual([
			"Parent/Café",
			"Other/Café",
		]);
	});

	test("a pending rename rechecks collisions at adoption and leaves the proposal rejectable", () => {
		h.call("propose", { edits: [{ op: "create", outline: "Original", folder: "Refunds" }] });
		const agent = h.actor("writer", "agent", ["read", "produce"]);
		h.call("propose", { edits: [{ op: "policy", preset: "standard" }] });
		const policy = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
		if (!policy) throw new Error("no policy question");
		h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
		const pending = h.call<Proposed>(
			"propose",
			{
				edits: [
					{ op: "edit", case: "C-1", base: 1, body: { title: "Must roll back" } },
					{ op: "folder", folder: "Refunds", name: "Checkout" },
				],
			},
			agent,
		);
		h.call("propose", { edits: [{ op: "create", outline: "New sibling", folder: "Checkout" }] });
		const question = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
		if (!question) throw new Error("no rename question");
		expect(pending).toMatchObject({ question: question.q });
		expect(
			h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } }),
		).toMatchObject([
			{ status: "invalid", needs: 'folder path "Checkout" is already in use; choose another name or parent' },
		]);
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]).toMatchObject({
			title: "Original",
			version: 1,
			folder: { path: "Refunds" },
		});
		expect(
			h.call<{ status: string }[]>("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "reject" },
			})[0]?.status,
		).toBe("decided");
	});

	test("a batch may swap folder names when its final paths are distinct", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "First", folder: "Checkout" },
				{ op: "create", outline: "Second", folder: "Refunds" },
			],
		});
		expect(
			h.call<Proposed>("propose", {
				edits: [
					{ op: "folder", folder: "Checkout", name: "Refunds" },
					{ op: "folder", folder: "Refunds", name: "Checkout" },
				],
			}).status,
		).toBe("adopted");
		expect(h.call("find", { folder: "Checkout" })).toMatchObject({ count: 1, items: [{ ref: "C-2" }] });
		expect(h.call("find", { folder: "Refunds" })).toMatchObject({ count: 1, items: [{ ref: "C-1" }] });
	});

	test("a mixed folder batch preserves nested moves, a rename chain, a swap and case placement", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "Nested", folder: "Source/Child/Leaf" },
				{ op: "create", outline: "Left case", folder: "Left/Inside" },
				{ op: "create", outline: "Right case", folder: "Right/Inside" },
				{ op: "create", outline: "Moving case", folder: "Destination" },
			],
		});
		expect(
			h.call<Proposed>("propose", {
				edits: [
					{ op: "folder", folder: "Source", name: "Interim" },
					{ op: "folder", folder: "Source/Child", parent: "Destination", name: "Moved" },
					{ op: "folder", folder: "Source", name: "Final" },
					{ op: "folder", folder: "Left", name: "Right" },
					{ op: "folder", folder: "Right", name: "Left" },
					{ op: "folder", name: "New", parent: "Final/Branch" },
					{ op: "place", cases: ["C-4"], folder: "Final/Branch/New" },
					{ op: "create", outline: "Created case", folder: "Destination/Moved/Leaf" },
				],
			}).status,
		).toBe("adopted");
		expect(
			h
				.call<CaseView[]>("get", { refs: ["C-1", "C-2", "C-3", "C-4", "C-5"] })
				.map((row) => ({ title: row.title, folder: row.folder.path })),
		).toEqual([
			{ title: "Nested", folder: "Destination/Moved/Leaf" },
			{ title: "Left case", folder: "Right/Inside" },
			{ title: "Right case", folder: "Left/Inside" },
			{ title: "Moving case", folder: "Final/Branch/New" },
			{ title: "Created case", folder: "Destination/Moved/Leaf" },
		]);
		expect(
			h
				.call<{ items: { path: string }[] }>("find", { in: "folders" })
				.items.map((row) => row.path)
				.sort(),
		).toEqual([
			"Destination",
			"Destination/Moved",
			"Destination/Moved/Leaf",
			"Final",
			"Final/Branch",
			"Final/Branch/New",
			"Left",
			"Left/Inside",
			"Right",
			"Right/Inside",
		]);
	});

	test("path targets cannot pick an arbitrary folder while a batch swaps names", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "First", folder: "Checkout" },
				{ op: "create", outline: "Second", folder: "Refunds" },
			],
		});
		expect(
			h.raw("propose", {
				edits: [
					{ op: "folder", folder: "Checkout", name: "Refunds" },
					{ op: "create", outline: "Ambiguous", folder: "Refunds/New" },
					{ op: "folder", folder: "Refunds", name: "Checkout" },
				],
			}),
		).toMatchObject({
			ok: false,
			error: {
				code: "invalid",
				message: 'folder path "Refunds" is ambiguous during the proposal; reorder the folder edits',
			},
		});
		expect(h.call("find", { folder: "Checkout" })).toMatchObject({ count: 1, items: [{ ref: "C-1" }] });
	});

	test.each([
		["move", "inbox"],
		["move", "read"],
		["move", "accept"],
		["create", "inbox"],
		["create", "read"],
		["create", "accept"],
		["place", "inbox"],
		["place", "read"],
		["place", "accept"],
	] as const)("a stored %s proposal handles %s when its target becomes ambiguous during replay", (op, action) => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: "First", folder: "Source" },
				{ op: "create", outline: "Second", folder: "Moving" },
			],
		});
		const agent = h.actor("writer", "agent", ["read", "produce"]);
		h.call("propose", { edits: [{ op: "policy", preset: "standard" }] });
		const policy = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
		if (!policy) throw new Error("no policy question");
		h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
		const target: Edit =
			op === "move"
				? { op: "folder", folder: "Moving", parent: "Target" }
				: op === "create"
					? { op: "create", outline: "New case", folder: "Target/New" }
					: { op: "place", cases: ["C-2"], folder: "Target/New" };
		const pending = h.call<Proposed>(
			"propose",
			{
				edits: [
					{ op: "folder", folder: "Source", name: "Target" },
					{ op: "folder", folder: "Moving", archive: false },
					target,
					{ op: "folder", folder: "Source", name: "Finished" },
				],
			},
			agent,
		);
		const question = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
		if (!question) throw new Error("no folder question");
		expect(pending).toMatchObject({ status: "open", question: question.q });
		h.call("propose", { edits: [{ op: "folder", folder: "Moving", name: "Target" }] });
		const ambiguity = 'folder path "Target" is ambiguous during the proposal; reorder the folder edits';
		if (action === "accept")
			expect(
				h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } }),
			).toMatchObject([{ status: "invalid", needs: ambiguity }]);
		else if (action === "inbox")
			expect(h.call("inbox", { kind: "adopt" })).toMatchObject({
				items: [
					{ q: question.q, state: "open", needs: `one member who is not an agent; accepting refused: ${ambiguity}` },
				],
			});
		else
			expect(h.call("get", { refs: [question.q] })).toMatchObject([
				{ q: question.q, state: "open", needs: `one member who is not an agent; accepting refused: ${ambiguity}` },
			]);
		expect(h.call<CaseView[]>("get", { refs: ["C-1", "C-2"] }).map((row) => row.folder.path)).toEqual([
			"Source",
			"Target",
		]);
		expect(
			h.call<{ status: string }[]>("decide", {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "reject" },
			})[0]?.status,
		).toBe("decided");
	});

	test.each([
		["ambiguity", "folder:secure"],
		["self-move", "folder:secure"],
		["ambiguity", "folder:b/secure"],
		["self-move", "folder:a/b/secure"],
		["ambiguity", "tag:guarded"],
		["self-move", "tag:guarded"],
		["ambiguity", "folder:fin/n"],
		["ambiguity", "folder:other/n"],
		["ambiguity", "folder:other/n/fin/n"],
		["ambiguity", "folder:fin/n/old"],
	] as const)(
		"a refused %s replay keeps policy facts for %s from later edits and every candidate",
		(refusal, scope) => {
			h.call("propose", {
				edits: ["A", "B", "C", "Secure", "C/Sub", ...(scope === "folder:fin/n/old" ? ["A/N"] : [])].map(
					(folder, i) => ({
						op: "create",
						outline: `Case ${i}${folder === "Secure" ? " #guarded" : ""}`,
						folder,
					}),
				),
			});
			h.actor("approver", "human", ["read", "produce", "answer"]);
			h.call("admin", {
				do: "grant.set",
				actor: "approver",
				project: "scratch",
				can: ["read", "produce", "answer"],
				roles: ["approver"],
			});
			const approver = actorByName(h.app.db, "approver", 1);
			if (!approver) throw new Error("no approver");
			const clauses = [...PRESETS.standard.clauses];
			clauses.splice(
				clauses.findIndex((clause) => clause.id === "adopt-agent"),
				0,
				{
					id: "review-scope",
					kind: "adopt",
					when: ["author:agent", scope],
					ask: { who: "role:approver", agents: "none", notProducer: false, reason: "required" },
					blocks: "nothing",
				},
			);
			h.call("propose", { edits: [{ op: "policy", base: 1, clauses }] });
			const policy = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
			if (!policy) throw new Error("no policy question");
			h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
			const agent = h.actor("writer", "agent", ["read", "produce"]);
			const pending = h.call<Proposed>(
				"propose",
				{
					edits: [
						refusal === "ambiguity"
							? { op: "folder", folder: "A", name: "X" }
							: { op: "folder", folder: "A", parent: "B" },
						{ op: "create", outline: "New case", folder: "X/N" },
						{ op: "folder", folder: "Secure", parent: "B" },
						...(scope === "folder:fin/n/old"
							? ([
									{ op: "folder", folder: "A/N", name: "Old" },
									{ op: "create", outline: "Recreated child", folder: "X/N" },
									{ op: "folder", folder: "A/N", parent: "X/N" },
								] satisfies Edit[])
							: []),
						{ op: "folder", folder: "A", name: "Fin" },
						...(scope === "folder:other/n/fin/n"
							? ([
									{ op: "create", outline: "Other candidate", folder: "X/N" },
									{ op: "folder", folder: "A", parent: "X/N" },
								] satisfies Edit[])
							: []),
						...(scope.startsWith("folder:other/")
							? ([{ op: "folder", folder: "C", name: "Other" }] satisfies Edit[])
							: []),
					],
				},
				agent,
			);
			const ask = "a member with role approver who is not an agent with a reason";
			expect(h.call("get", { refs: [pending.question] })).toMatchObject([
				{
					needs:
						scope === "folder:other/n" || scope === "folder:other/n/fin/n" || scope === "folder:a/b/secure"
							? "one member who is not an agent"
							: ask,
				},
			]);
			h.call("propose", {
				edits: [
					refusal === "ambiguity"
						? { op: "folder", folder: "C", name: "X" }
						: { op: "folder", folder: "B", parent: "A" },
				],
			});
			const needs =
				refusal === "ambiguity"
					? `${ask}; accepting refused: folder path "X" is ambiguous during the proposal; reorder the folder edits`
					: ask;
			expect(h.call("get", { refs: [pending.question] })).toMatchObject([{ state: "open", needs }]);
			const question = h
				.call<{ items: { q: string; evidenceHash: string; needs: string }[] }>("inbox", { kind: "adopt" })
				.items.find((item) => item.q === pending.question);
			if (!question) throw new Error("no folder question");
			expect(question.needs).toBe(needs);
			const member = h.actor("plain", "human", ["read", "produce", "answer"]);
			expect(
				h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } }, member),
			).toMatchObject([{ status: "forbidden", needs: ask }]);
			expect(
				h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } }, approver),
			).toMatchObject([{ status: "invalid", needs: "a reason" }]);
			expect(
				h.call(
					"decide",
					{ q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" }, reason: "No longer needed" },
					approver,
				),
			).toMatchObject([{ status: "decided" }]);
		},
	);

	test.each([
		["union", "member"],
		["union", "rule"],
		["union", "role:auditor"],
		["union", "author"],
		["budget", "member"],
		["budget", "rule"],
	] as const)("a refused %s replay cannot select an earlier looser %s clause", (shape, who) => {
		const chain = Array.from({ length: 16 }, (_, i) => `L${i}`);
		h.call("propose", {
			edits: ["A", "C", ...(shape === "budget" ? [chain.join("/")] : [])].map((folder) => ({
				op: "create",
				outline: folder,
				folder,
			})),
		});
		h.actor("approver", "human", ["read", "produce", "answer"]);
		h.call("admin", {
			do: "grant.set",
			actor: "approver",
			project: "scratch",
			can: ["read", "produce", "answer"],
			roles: ["approver"],
		});
		const approver = actorByName(h.app.db, "approver", 1);
		if (!approver) throw new Error("no approver");
		if (who === "role:auditor") {
			h.actor("auditor", "human", ["read", "produce", "answer"]);
			h.call("admin", {
				do: "grant.set",
				actor: "auditor",
				project: "scratch",
				can: ["read", "produce", "answer"],
				roles: ["auditor"],
			});
		}
		const clauses = [...PRESETS.standard.clauses];
		clauses.splice(
			clauses.findIndex((clause) => clause.id === "adopt-agent"),
			1,
			{
				id: "looser-folder",
				kind: "adopt",
				when: shape === "budget" ? ["folder:sandbox"] : ["folder:fin/n", "folder:other/n"],
				ask: { who, agents: "answer", notProducer: false, reason: "optional" },
				...(who === "rule" ? { answer: { is: "reject" } } : {}),
				blocks: "nothing",
			},
			{
				id: "stricter-catch-all",
				kind: "adopt",
				when: ["author:agent"],
				ask: { who: "role:approver", agents: "none", notProducer: false, reason: "required" },
				blocks: "nothing",
			},
		);
		h.call("propose", { edits: [{ op: "policy", base: 1, clauses }] });
		const policy = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
		if (!policy) throw new Error("no policy question");
		h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
		const edits: Edit[] = [
			{ op: "folder", folder: "A", name: "X" },
			{ op: "create", outline: "New case", folder: "X/N" },
			...(shape === "budget"
				? chain.map(
						(name, i): Edit => ({
							op: "folder",
							folder: chain.slice(0, i + 1).join("/"),
							name: `${name}a`,
						}),
					)
				: []),
			{ op: "folder", folder: "A", name: "Fin" },
			...(shape === "union" ? ([{ op: "folder", folder: "C", name: "Other" }] satisfies Edit[]) : []),
		];
		const agent = h.actor("writer", "agent", ["read", "produce", "answer"]);
		const pending = h.call<Proposed>("propose", { edits }, agent);
		expect(pending.status).toBe("open");
		h.call("propose", { edits: [{ op: "folder", folder: "C", name: "X" }] });
		const question = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
		if (!question) throw new Error("no folder question");
		const member = h.actor("plain", "human", ["read", "produce", "answer"]);
		const incompatible = who === "role:auditor" || who === "author";
		const ask = incompatible
			? "an admin who is not an agent with a reason"
			: "a member with role approver who is not an agent with a reason";
		expect(
			h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } }, member),
		).toMatchObject([{ status: "forbidden", needs: ask }]);
		expect(h.call("get", { refs: [pending.question] })).toMatchObject([
			{
				state: "open",
				needs: `${ask}; accepting refused: folder path "X" is ambiguous during the proposal; reorder the folder edits`,
			},
		]);
		expect(
			h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } }, agent),
		).toMatchObject([{ status: "forbidden", needs: ask }]);
		expect(
			h.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } }, approver),
		).toMatchObject([incompatible ? { status: "forbidden", needs: ask } : { status: "invalid", needs: "a reason" }]);
		h.call("propose", { edits: [{ op: "folder", folder: "X", name: "Elsewhere" }] });
		expect(h.call("get", { refs: [pending.question] })).toMatchObject([
			{ state: "open", needs: "a member with role approver who is not an agent with a reason" },
		]);
		h.call("propose", { edits: [{ op: "folder", folder: "Elsewhere", name: "X" }] });
		expect(
			h.call(
				"decide",
				{ q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" }, reason: "No longer needed" },
				incompatible ? undefined : approver,
			),
		).toMatchObject([{ status: "decided" }]);
	});

	test.each([
		["wide", 0, ""],
		["deep", 16, "a"],
		["deep", 12, "ab"],
	] as const)("a refused %s replay bounds candidate work at depth %i with renames %s", (shape, depth, names) => {
		const chain = Array.from({ length: depth }, (_, i) => `L${i}`);
		const edits: Edit[] = [{ op: "folder", folder: "S", name: "X" }];
		let scope: string;
		if (shape === "wide") {
			h.call("propose", {
				edits: Array.from({ length: 200 }, (_, i) => ({
					op: "create",
					outline: `Case ${i} #guarded`,
					folder: `F${i % 50}/G${i}`,
				})),
			});
			edits[0] = { op: "folder", folder: "F0", name: "X" };
			for (let i = 0; i < 998; i++) {
				if (i % 4 === 0) edits.push({ op: "create", outline: `N${i}`, folder: `X/N${i}` });
				else if (i % 4 === 1) edits.push({ op: "place", cases: [`C-${1 + (i % 200)}`], folder: `X/P${i % 50}` });
				else if (i % 4 === 2) edits.push({ op: "folder", name: `M${i}`, parent: `X/N${i - 2}` });
				else edits.push({ op: "folder", folder: `F${1 + (i % 49)}/G${1 + (i % 49)}`, name: `R${i}` });
			}
			edits.push({ op: "folder", folder: "F0", name: "Fin" });
			scope = "folder:fin/n0/m2";
		} else {
			h.call("propose", {
				edits: [
					{ op: "create", outline: "Deep #guarded", folder: chain.join("/") },
					{ op: "create", outline: "Source", folder: "S" },
				],
			});
			edits.push({ op: "create", outline: "T", folder: "X/N" });
			for (let i = 0; i < chain.length; i++)
				for (const name of names)
					edits.push({ op: "folder", folder: chain.slice(0, i + 1).join("/"), name: `${chain[i]}${name}` });
			edits.push({ op: "create", outline: "Deep2", folder: "X/N/Q" }, { op: "folder", folder: "S", name: "Fin" });
			scope = `folder:${chain
				.map((name) => `${name}${names.at(-1)}`)
				.join("/")
				.toLowerCase()}`;
		}
		const clauses = [...PRESETS.standard.clauses];
		h.actor("approver", "human", ["read", "produce", "answer"]);
		h.call("admin", {
			do: "grant.set",
			actor: "approver",
			project: "scratch",
			can: ["read", "produce", "answer"],
			roles: ["approver"],
		});
		clauses.splice(
			clauses.findIndex((clause) => clause.id === "adopt-agent"),
			0,
			{
				id: "deep-review",
				kind: "adopt",
				when: ["author:agent", scope, "tag:guarded"],
				ask: { who: "role:approver", agents: "none", notProducer: false, reason: "required" },
				blocks: "nothing",
			},
		);
		h.call("propose", { edits: [{ op: "policy", base: 1, clauses }] });
		const policy = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox", { kind: "adopt" }).items[0];
		if (!policy) throw new Error("no policy question");
		h.call("decide", { q: policy.q, onEvidence: policy.evidenceHash, answer: { is: "accept" } });
		const agent = h.actor("writer", "agent", ["read", "produce"]);
		const pending = h.call<Proposed>("propose", { edits }, agent);
		expect(pending.status).toBe("open");
		h.call("propose", { edits: [{ op: "folder", name: "X" }] });
		// Count actual path candidates, including duplicates, rather than elapsed time on a shared machine.
		const add = Set.prototype.add;
		let candidates = 0;
		const limit = 25_000 + 100 * edits.length;
		const spy = spyOn(Set.prototype, "add").mockImplementation(function (this: Set<unknown>, value: unknown) {
			if (typeof value === "string" && value.includes("/")) {
				candidates++;
				if (candidates === limit + 1) throw new Error("candidate work exceeded its polynomial bound");
			}
			return add.call(this, value);
		});
		let reply: Reply;
		try {
			reply = h.raw("inbox", { kind: "adopt" });
		} finally {
			spy.mockRestore();
		}
		expect(candidates).toBeLessThanOrEqual(limit);
		expect(reply).toMatchObject({
			ok: true,
			result: {
				items: [
					{
						q: pending.question,
						state: "open",
						needs:
							'a member with role approver who is not an agent with a reason; accepting refused: folder path "X" is ambiguous during the proposal; reorder the folder edits',
					},
				],
			},
		});
	});

	test.each(["\u200b", " \u200b "])("a folder name empty after cleaning is refused: %s", (name) => {
		expect(h.raw("propose", { edits: [{ op: "folder", name }] })).toMatchObject({
			ok: false,
			error: { code: "invalid" },
		});
		expect(h.call<{ items: unknown[] }>("find", { in: "folders" }).items.length).toBe(0);
	});

	test("canonical lookup reuses an existing NFD folder without rewriting it", () => {
		h.call("propose", { edits: [{ op: "create", outline: "Original", folder: "Café" }] });
		h.app.db.raw.query("UPDATE folders SET name = ? WHERE name = 'Café'").run("Cafe\u0301");
		h.call("propose", { edits: [{ op: "create", outline: "Second", folder: "Café" }] });
		expect(h.call<{ items: unknown[] }>("find", { in: "folders" }).items.length).toBe(1);
		expect(h.call<CaseView[]>("get", { refs: ["C-1", "C-2"] }).map((view) => view.folder.path)).toEqual([
			"Cafe\u0301",
			"Cafe\u0301",
		]);
		for (const folder of ["Café", "Cafe\u0301", "Café\u200b"]) {
			expect(h.call<{ items: { ref: string }[] }>("find", { folder }).items.map((item) => item.ref)).toEqual([
				"C-1",
				"C-2",
			]);
		}
	});

	test("the save is a recorded decision made by the policy's rule", () => {
		h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		const ledger = h.call<{
			items: { kind: string; decision: { answer: { is: string }; rule: string | null; by: string[] } }[];
		}>("inbox", { state: "decided" });
		expect(ledger.items).toHaveLength(1);
		expect(ledger.items[0]?.decision).toMatchObject({ answer: { is: "accept" }, rule: "adopt-any", by: ["policy"] });
	});

	test("the same command twice writes once", () => {
		const input = { edits: [{ op: "create", outline: "A case" }], cmd: "cmd-0000000001" };
		const first = h.call<Proposed>("propose", input);
		const second = h.call<Proposed>("propose", input);
		expect(second).toEqual(first);
		const count = (table: string) =>
			h.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n;
		expect([count("cases"), count("versions"), count("proposals"), count("decisions")]).toEqual([1, 1, 1, 1]);
		expect(h.call<{ count: number }>("find", { in: "folders" }).count).toBe(1);
	});

	test("the canonical Markdown round-trips through the server", () => {
		h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		const [md] = h.call<{ md: string }[]>("get", { refs: ["C-1"], as: "md" });
		expect(md?.md).toContain("## Steps");
		const again = h.call<Proposed>("propose", { edits: [{ op: "edit", case: "C-1", base: 1, md: md?.md }] });
		expect(again.proposal).toBeNull(); // nothing changed, so nothing was proposed
	});

	test("a Markdown edit without a fields header preserves free-form values", () => {
		h.call("propose", { edits: [{ op: "create", body: { title: "Original", fields: { legacy: "Keep me" } } }] });
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, md: "---\ntitle: Edited\n---\n## Steps\n" }],
		});
		expect(reply.status).toBe("adopted");
		expect(storedBody()).toMatchObject({
			title: "Edited",
			fields: { legacy: "Keep me" },
		});
	});

	test.each([
		["fields:", {}],
		["fields: {}", {}],
		["fields:\n  risk: low", { risk: "low" }],
	])("a Markdown edit with %s replaces the field map", (header, fields) => {
		h.call("propose", {
			edits: [{ op: "create", body: { title: "Original", fields: { risk: "high", legacy: "Keep me" } } }],
		});
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, md: `---\ntitle: Edited\n${header}\n---\n## Steps\n` }],
		});
		expect(reply.status).toBe("adopted");
		expect(storedBody().fields).toEqual(fields);
	});

	test("a stale Markdown edit without fields merges a concurrent field change", () => {
		h.call("propose", { edits: [{ op: "create", body: { title: "Original", fields: { risk: "high" } } }] });
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { fields: { risk: "low" } } }] });
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, md: "---\ntitle: Edited\n---\n## Steps\n" }],
		});
		expect(reply.status).toBe("adopted");
		expect(reply.conflicts).toEqual([]);
		expect(reply.cases[0]?.version).toBe(3);
		expect(storedBody()).toMatchObject({
			title: "Edited",
			fields: { risk: "low" },
		});
	});
});

describe("editing", () => {
	beforeEach(() => {
		h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
	});
	const steps = () => h.call<CaseView[]>("get", { refs: ["C-1"] })[0]?.steps ?? [];

	test("an edit is version 2 and the diff is by step", () => {
		const next = steps().map((s, i) => (i === 1 ? { ...s, expected: "Total shows $90.00 (10% off $100.00)" } : s));
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, body: { steps: next } }],
			reason: "be exact",
		});
		expect(reply.cases[0]).toMatchObject({ ref: "C-1", version: 2 });
		const diff = h.call<{ summary: string }>("history", { ref: "C-1", from: 1, to: 2 });
		expect(diff.summary).toContain("expected");
		const list = h.call<{ versions: { version: number; reason: string | null; summary: string }[] }>("history", {
			ref: "C-1",
		});
		expect(list.versions.map((v) => v.version)).toEqual([2, 1]);
		expect(list.versions[0]?.reason).toBe("be exact");
	});

	test("two edits to different fields on the same base merge", () => {
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon: percentage" } }] });
		const mine = steps().map((s, i) => (i === 0 ? { ...s, action: "Open the cart with one $200.00 item" } : s));
		const reply = h.call<Proposed>("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { steps: mine } }] });
		expect(reply.status).toBe("adopted");
		const [view] = h.call<CaseView[]>("get", { refs: ["C-1"] });
		expect(view?.version).toBe(3);
		expect(view?.title).toBe("Coupon: percentage");
		expect(view?.steps[0]?.action).toBe("Open the cart with one $200.00 item");
	});

	test("two edits to the same field conflict: nothing is overwritten and the author resolves it", () => {
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Theirs" } }] });
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Mine" } }],
		});
		expect(reply.status).toBe("conflict");
		expect(reply.conflicts).toEqual([{ case: "C-1", addresses: [{ kind: "field", name: "title" }] }]);
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]?.title).toBe("Theirs");

		const queue = h.call<{ items: { q: string; evidenceHash: string }[] }>("inbox");
		const q = queue.items[0];
		expect(q?.q).toBe(reply.question ?? "");
		const refused = h.call<{ status: string }[]>("decide", {
			q: q?.q,
			onEvidence: q?.evidenceHash,
			answer: { is: "accept" },
		});
		expect(refused[0]).toMatchObject({
			status: "invalid",
			needs: "one of merge, reject: `accept` does not apply to this proposal",
		});
		const body = {
			title: "Mine and theirs",
			pre: "",
			steps: steps(),
			methods: ["human"],
			automate: "none",
			fields: {},
		};
		const merged = h.call<{ status: string }[]>("decide", {
			q: q?.q,
			onEvidence: q?.evidenceHash,
			answer: { is: "merge", body },
		});
		expect(merged[0]?.status).toBe("decided");
		expect(h.call<CaseView[]>("get", { refs: ["C-1"] })[0]).toMatchObject({ title: "Mine and theirs", version: 3 });
	});

	test("a proposal read after its case moved shows the body that accepting it writes", () => {
		const s = harness({ preset: "standard" });
		try {
			s.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
			const agent = s.actor("writer", "agent", ["read", "produce"]);
			const proposed = s.call<Proposed>(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Coupon: percentage" } }] },
				agent,
			);
			expect(proposed.status).toBe("open");
			s.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "Signed in as robin" } }] });
			const [read] = s.call<{ edits: { head: number; body: { title: string; pre: string } }[] }[]>("get", {
				refs: [proposed.proposal],
			});
			expect(read?.edits[0]).toMatchObject({
				head: 2,
				body: { title: "Coupon: percentage", pre: "Signed in as robin" },
			});
			const [question] = s.call<{ evidenceHash: string }[]>("get", { refs: [proposed.question] });
			s.call("decide", { q: proposed.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } });
			expect(s.call<CaseView[]>("get", { refs: ["C-1"] })[0]).toMatchObject({
				version: 3,
				title: "Coupon: percentage",
				pre: "Signed in as robin",
			});
		} finally {
			s.close();
		}
	});

	test("a proposal read pages all 250 edits without hiding the last 50", () => {
		const edits = Array.from({ length: 250 }, (_, i) => ({ op: "create", outline: `Case ${i}` }));
		const s = harness({ preset: "standard" });
		try {
			const agent = s.actor("writer", "agent", ["read", "produce"]);
			const proposed = s.call<Proposed>("propose", { edits }, agent);
			type Page = { count: number; cursor: string | null; edits: { body: { title: string } }[] };
			const [read] = s.call<Page[]>("get", { refs: [proposed.proposal] });
			expect([read?.count, read?.edits.length]).toEqual([250, 200]);
			expect(typeof read?.cursor).toBe("string");
			const [last] = s.call<Page[]>("get", { refs: [proposed.proposal], cursor: read?.cursor });
			expect([last?.count, last?.edits.length, last?.cursor]).toEqual([250, 50, null]);
			expect([read?.edits[0]?.body.title, last?.edits[0]?.body.title, last?.edits.at(-1)?.body.title]).toEqual([
				"Case 0",
				"Case 200",
				"Case 249",
			]);
			for (const cursor of ["bad", read?.cursor?.replace(/^\d+/, "999")]) {
				expect(() => s.call("get", { refs: [proposed.proposal], cursor })).toThrow(
					"that is not a cursor of this proposal",
				);
			}
			expect(() => s.call("get", { refs: [proposed.proposal, proposed.proposal], cursor: read?.cursor })).toThrow(
				"a proposal cursor needs exactly one P- ref",
			);
			s.call("propose", { edits: [{ op: "create", outline: "New case" }] });
			expect(() => s.call("get", { refs: [proposed.proposal], cursor: read?.cursor })).toThrow(
				"The project changed. Read the proposal again from its first page.",
			);
		} finally {
			s.close();
		}
	});

	test("a proposal read names the case a move asks to follow, and ranking places it by the guide's rule", () => {
		const s = harness({ preset: "standard" });
		try {
			s.call("propose", {
				edits: [
					{ op: "create", outline: "One", folder: "A" },
					{ op: "create", outline: "Two", folder: "A" },
					{ op: "create", outline: "Three", folder: "B" },
					{ op: "create", outline: "Four", folder: "B" },
				],
			});
			const agent = s.actor("writer", "agent", ["read", "produce"]);
			const proposed = s.call<Proposed>(
				"propose",
				{
					edits: [
						{ op: "place", cases: ["C-3"], folder: "A", after: "C-1" },
						// C-3 is in A once the edit before it is applied, so C-4 lands after it.
						{ op: "place", cases: ["C-4"], folder: "A", after: "C-3" },
						// A case placed after itself goes to the end of its folder.
						{ op: "place", cases: ["C-2"], after: "C-2" },
						// An anchor in another folder puts the case at the end too.
						{ op: "place", cases: ["C-1"], folder: "B", after: "C-2" },
					],
				},
				agent,
			);
			expect(proposed.status).toBe("open");
			const [read] = s.call<{ edits: { after?: string }[] }[]>("get", { refs: [proposed.proposal] });
			expect(read?.edits.map((edit) => edit.after)).toEqual(["C-1", "C-3", "C-2", "C-2"]);
			const [question] = s.call<{ evidenceHash: string }[]>("get", { refs: [proposed.question] });
			s.call("decide", { q: proposed.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } });
			const order = (folder: string) =>
				s.call<{ items: { ref: string }[] }>("find", { in: "cases", folder }).items.map((item) => item.ref);
			expect([order("A"), order("B")]).toEqual([["C-3", "C-4", "C-2"], ["C-1"]]);
		} finally {
			s.close();
		}
	});

	test("a move after a folder edit, and a move with its anchor, land by the guide's rule", () => {
		const s = harness({ preset: "standard" });
		try {
			s.call("propose", {
				edits: [
					{ op: "create", outline: "One", folder: "A" },
					{ op: "create", outline: "Two", folder: "A" },
					{ op: "create", outline: "Three", folder: "B" },
					{ op: "create", outline: "Four", folder: "B" },
					{ op: "create", outline: "Five", folder: "B" },
				],
			});
			const agent = s.actor("writer", "agent", ["read", "produce"]);
			const proposed = s.call<Proposed>(
				"propose",
				{
					edits: [
						// Once A is renamed, "Renamed" is A, so C-3 lands after C-1 there.
						{ op: "folder", folder: "A", name: "Renamed" },
						{ op: "place", cases: ["C-3"], folder: "Renamed", after: "C-1" },
						// C-5 moves with C-4, its anchor, so the two land where C-5 stood.
						{ op: "place", cases: ["C-4", "C-5"], after: "C-5" },
					],
				},
				agent,
			);
			const [read] = s.call<{ edits: { after?: string }[] }[]>("get", { refs: [proposed.proposal] });
			expect(read?.edits.map((edit) => edit.after)).toEqual([undefined, "C-1", "C-5"]);
			const [question] = s.call<{ evidenceHash: string }[]>("get", { refs: [proposed.question] });
			s.call("decide", { q: proposed.question, onEvidence: question?.evidenceHash, answer: { is: "accept" } });
			const order = (folder: string) =>
				s.call<{ items: { ref: string }[] }>("find", { in: "cases", folder }).items.map((item) => item.ref);
			expect([order("Renamed"), order("B")]).toEqual([
				["C-1", "C-3", "C-2"],
				["C-4", "C-5"],
			]);
		} finally {
			s.close();
		}
	});

	test("cases from two folders moved together each go where the guide says in their own folder", () => {
		for (const after of [null, "C-1"]) {
			const s = harness();
			try {
				s.call("propose", {
					edits: [
						{ op: "create", outline: "One", folder: "A" },
						...["Two", "Three", "Four", "Five", "Six"].map((title) => ({
							op: "create",
							outline: title,
							folder: "B",
						})),
					],
				});
				s.call("propose", { edits: [{ op: "place", cases: ["C-1", "C-2"], after }] });
				const order = (folder: string) =>
					s.call<{ items: { ref: string }[] }>("find", { in: "cases", folder }).items.map((item) => item.ref);
				// C-1 is the only case in A. C-1 is not in B, so C-2 goes to the end of B: a rank made in A does not
				// place a case in B.
				expect([order("A"), order("B")]).toEqual([["C-1"], ["C-3", "C-4", "C-5", "C-6", "C-2"]]);
			} finally {
				s.close();
			}
		}
	});

	test("a proposal that moves two folders into each other can be read and rejected", () => {
		const s = harness({ preset: "standard" });
		try {
			s.call("propose", {
				edits: [
					{ op: "create", outline: "One", folder: "A" },
					{ op: "create", outline: "Two", folder: "B" },
				],
			});
			const agent = s.actor("writer", "agent", ["read", "produce"]);
			const proposed = s.call<Proposed>(
				"propose",
				{
					edits: [
						{ op: "folder", folder: "A", parent: "B" },
						{ op: "folder", folder: "B", parent: "A" },
						{ op: "place", cases: ["C-2"], folder: "Missing" },
					],
				},
				agent,
			);
			const [read] = s.call<{ edits: unknown[] }[]>("get", { refs: [proposed.proposal] });
			expect(read?.edits).toHaveLength(3);
			const [question] = s.call<{ evidenceHash: string }[]>("get", { refs: [proposed.question] });
			const [reply] = s.call<{ status: string }[]>("decide", {
				q: proposed.question,
				onEvidence: question?.evidenceHash,
				answer: { is: "reject" },
			});
			expect(reply?.status).toBe("decided");
		} finally {
			s.close();
		}
	});

	test("restore makes a new version and keeps the history", () => {
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Changed" } }] });
		const reply = h.call<Proposed>("propose", { edits: [{ op: "restore", case: "C-1", to: 1 }] });
		expect(reply.cases[0]).toMatchObject({ version: 3 });
		const [view] = h.call<CaseView[]>("get", { refs: ["C-1"] });
		expect(view?.title).toBe("Checkout applies a percentage coupon");
		const first = h.call<CaseView[]>("get", { refs: ["C-1"], version: 1 })[0];
		expect(view?.hash).toBe(first?.hash ?? "");
	});
});

describe("a proposal that waits while its case moves on", () => {
	type Read = {
		edits: { body: { title: string; steps: { id: string }[] }; current: { title: string }; refused: string | null }[];
	};
	let agent: ReturnType<Harness["actor"]>;
	beforeEach(() => {
		h.close();
		h = harness({ preset: "standard" });
		h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		agent = h.actor("helper", "agent", ["read", "produce"]);
	});
	const proposeAsAgent = (body: Record<string, unknown>) => {
		const waiting = h.call<Proposed>("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body }] }, agent);
		expect(waiting.status).toBe("open");
		return waiting;
	};
	const retitle = (title: string, base: number) =>
		h.call<Proposed>("propose", { edits: [{ op: "edit", case: "C-1", base, body: { title } }] });
	const read = (proposal: string | null) => h.call<Read[]>("get", { refs: [proposal] })[0]?.edits[0];
	const accept = (question: string | null) => {
		const [item] = h.call<{ evidenceHash: string }[]>("get", { refs: [question] });
		return h.call<{ status: string; needs: string | null }[]>("decide", {
			q: question,
			onEvidence: item?.evidenceHash,
			answer: { is: "accept" },
		})[0];
	};

	test("reads as what accepting it writes: merged with the newer version, as the merge on accepting does", () => {
		const [view] = h.call<CaseView[]>("get", { refs: ["C-1"] });
		const reordered = [...(view?.steps ?? [])].reverse();
		const waiting = proposeAsAgent({ steps: reordered });
		retitle("Updated by a person", 1);

		const edit = read(waiting.proposal);
		expect(edit?.current.title).toBe("Updated by a person");
		expect(edit?.body.title).toBe("Updated by a person");
		expect(edit?.body.steps.map((step) => step.id)).toEqual(reordered.map((step) => step.id));
		expect(edit?.refused).toBeNull();

		expect(accept(waiting.question)?.status).toBe("decided");
		const [accepted] = h.call<CaseView[]>("get", { refs: ["C-1"] });
		expect({ title: accepted?.title, steps: accepted?.steps.map((step) => step.id) }).toEqual({
			title: edit?.body.title,
			steps: edit?.body.steps.map((step) => step.id),
		});
	});

	test("says that accepting is refused, in the words accepting refuses with, when the newer version cannot merge", () => {
		const waiting = proposeAsAgent({ title: "Retitled by the agent" });
		retitle("Retitled by a person", 1);
		const refusal = "C-1 changed after this proposal was made; redo the proposal on version 2";
		// Refused, the edit is shown as it was proposed.
		expect(read(waiting.proposal)).toMatchObject({ refused: refusal, body: { title: "Retitled by the agent" } });
		expect(accept(waiting.question)).toMatchObject({ status: "conflict", needs: refusal });
	});

	test("says that accepting is refused when the body no longer meets the policy's field definitions", () => {
		const setFields = (choices: string[]) => {
			const policy = h.call<{ version: number; settings: Record<string, unknown> }>("admin", {
				do: "policy.show",
				project: "scratch",
			});
			const fields = { risk: { kind: "choice", label: "Risk", required: false, choices } };
			const reply = h.call<Proposed>("propose", {
				edits: [{ op: "policy", base: policy.version, settings: { ...policy.settings, fields } }],
			});
			if (reply.question) expect(accept(reply.question)?.status).toBe("decided");
		};
		setFields(["low", "high"]);
		const waiting = proposeAsAgent({ fields: { risk: "high" } });
		setFields(["low"]);
		const refusal = read(waiting.proposal)?.refused;
		expect(refusal).toStartWith("case custom fields are not valid:");
		expect(accept(waiting.question)).toMatchObject({ status: "invalid", needs: refusal });
	});

	test("reads each edit on its own, so a proposal whose edits refuse each other reads clean and accepting refuses it", () => {
		const waiting = h.call<Proposed>(
			"propose",
			{
				edits: [
					{ op: "edit", case: "C-1", base: 1, body: { title: "First" } },
					{ op: "edit", case: "C-1", base: 1, body: { title: "Second" } },
				],
			},
			agent,
		);
		expect(waiting.status).toBe("open");
		const [proposal] = h.call<Read[]>("get", { refs: [waiting.proposal] });
		expect(proposal?.edits.map((edit) => [edit.body.title, edit.refused])).toEqual([
			["First", null],
			["Second", null],
		]);
		// Accepting applies them in order: the second meets a version the first made. The answer says so.
		expect(accept(waiting.question)).toMatchObject({
			status: "conflict",
			needs: "C-1 changed after this proposal was made; redo the proposal on version 2",
		});
	});

	test("once decided, reads as it was proposed: a later version adds nothing to it and refuses nothing", () => {
		const waiting = proposeAsAgent({ title: "Retitled by the agent" });
		expect(accept(waiting.question)?.status).toBe("decided");
		retitle("Retitled again", 2);
		expect(read(waiting.proposal)).toMatchObject({
			body: { title: "Retitled by the agent" },
			current: { title: "Retitled again" },
			refused: null,
		});
	});
});

describe("organising", () => {
	test("a bulk move and retag of 300 cases is one proposal, one decision, one point on the clock", () => {
		const edits = Array.from({ length: 300 }, (_, i) => ({ op: "create", outline: `Case ${i}`, folder: "inbox" }));
		h.call("propose", { edits });
		const cases = Array.from({ length: 300 }, (_, i) => `C-${i + 1}`);
		const count = (table: string) =>
			h.app.db.raw.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0;
		const proposals = count("proposals");
		const decisions = count("decisions");
		const before = h.app.db.raw.query<{ seq: number }, []>("SELECT seq FROM projects").get()?.seq ?? 0;
		const reply = h.call<Proposed>("propose", {
			edits: [{ op: "place", cases, folder: "checkout/regression", tags: { add: ["regression"] } }],
		});
		expect(reply.status).toBe("adopted");
		const after = h.app.db.raw.query<{ seq: number }, []>("SELECT seq FROM projects").get()?.seq ?? 0;
		expect(after).toBe(before + 1);
		expect([count("proposals") - proposals, count("decisions") - decisions]).toEqual([1, 1]);
		const found = h.call<{ items: { ref: string; tags: string[] }[] }>("find", {
			folder: "checkout/regression",
			limit: 500,
		});
		expect(found.items).toHaveLength(300);
		expect(found.items.map((c) => c.ref)).toEqual(cases); // order kept
		expect(found.items.every((c) => c.tags.includes("regression"))).toBe(true);
		const versions = h.app.db.raw.query<{ n: number }, []>("SELECT count(*) AS n FROM versions").get()?.n;
		expect(versions).toBe(300); // a move is history, not a new version
	});

	test("search finds by word and prefix, and by ref", () => {
		h.call("propose", {
			edits: [
				{ op: "create", outline: OUTLINE },
				{ op: "create", outline: "Login rejects an expired password\n  Enter the old password > Error shown" },
			],
		});
		const byWord = h.call<{ items: { ref: string }[] }>("find", { text: "coupon" });
		expect(byWord.items.map((c) => c.ref)).toEqual(["C-1"]);
		const byPrefix = h.call<{ items: { ref: string }[] }>("find", { text: "expired pass" });
		expect(byPrefix.items.map((c) => c.ref)).toEqual(["C-2"]);
		expect(h.call<{ items: { ref: string }[] }>("find", { text: "C-2" }).items[0]?.ref).toBe("C-2");
		expect(h.call<{ items: unknown[] }>("find", { text: '"*) OR 1=1 --' }).items).toEqual([]);
		h.call("propose", {
			edits: [
				{ op: "create", folder: "Ranked", tags: ["ranked"], outline: "Needle\n  Check > Good" },
				{ op: "create", folder: "Ranked", tags: ["ranked"], outline: "Other\n  Needle needle needle needle > Good" },
			],
		});
		for (const scope of [{}, { folder: "Ranked" }, { tags: ["ranked"] }]) {
			const ranked = h.call<{ items: { ref: string }[] }>("find", { text: "needle", ...scope });
			expect(ranked.items.map((item) => item.ref)).toEqual(["C-3", "C-4"]);
		}
	});

	test("a search by ref keeps to the folder, the tags and the state it is narrowed by", () => {
		h.call("propose", {
			edits: [
				{ op: "create", folder: "Checkout", tags: ["checkout"], outline: "Coupon applies\n  Apply > Lower" },
				{ op: "create", folder: "Accounts", outline: "Password resets\n  Reset > Access" },
			],
		});
		const refs = (input: Record<string, unknown>) =>
			h.call<{ items: { ref: string }[] }>("find", input).items.map((c) => c.ref);
		expect(refs({ text: "C-1", folder: "Checkout" })).toEqual(["C-1"]);
		expect(refs({ text: "C-2", folder: "Checkout" })).toEqual([]);
		expect(refs({ text: "2", folder: "Checkout", deep: true })).toEqual([]);
		expect(refs({ text: "C-2", tags: ["checkout"] })).toEqual([]);
		expect(refs({ text: "C-1", tags: ["checkout"] })).toEqual(["C-1"]);
		expect(refs({ text: "C-2", state: "archived" })).toEqual([]);
		expect(refs({ text: "C-2" })).toEqual(["C-2"]);
	});

	test("a search too broad to rank is bounded: newest first, title matches first, and it says the count is unknown", () => {
		const batch = (from: number, n: number) =>
			Array.from({ length: n }, (_, i) => ({ op: "create", outline: `Common thing ${from + i}\n  Step > Result` }));
		h.call("propose", { edits: batch(0, 1100) });
		h.call("propose", { edits: batch(1100, 1000) });
		h.call("propose", { edits: [{ op: "create", outline: "Rare needle\n  A common step > Result" }] });
		const broad = h.call<{ count: number | null; cursor: string | null; items: { ref: string; title: string }[] }>(
			"find",
			{
				text: "common",
				limit: 5,
			},
		);
		expect(broad.count).toBeNull(); // more than can be ranked: the caller is told the number is not known
		expect(broad.items.map((c) => c.ref)).toEqual(["C-2100", "C-2099", "C-2098", "C-2097", "C-2096"]); // in the title, newest first
		// Its order holds only for what one page reads, so it has no next page: a cursor into it reads nothing more.
		expect(broad.cursor).toBeNull();
		expect(h.call("find", { text: "common", limit: 5, cursor: "5" })).toMatchObject({
			items: [],
			cursor: null,
			count: null,
		});
		const narrow = h.call<{ count: number | null; items: { ref: string }[] }>("find", { text: "common needle" });
		expect(narrow).toMatchObject({ count: 1, items: [{ ref: "C-2101" }] });
		const ranked = h.call<{ count: number | null; items: { ref: string }[] }>("find", { text: "thing 1500" });
		expect(ranked.count).toBe(1);
	});

	test("a search's count and its pages do not depend on the page size", () => {
		h.call("propose", {
			edits: Array.from({ length: 600 }, (_, i) => ({ op: "create", outline: `Needle ${i}\n  Step > Result` })),
		});
		type Page = { count: number | null; cursor: string | null; items: { ref: string }[] };
		for (const limit of [50, 100, 200]) {
			const refs: string[] = [];
			let page = h.call<Page>("find", { text: "needle", limit });
			expect(page.count).toBe(600);
			refs.push(...page.items.map((c) => c.ref));
			while (page.cursor) {
				page = h.call<Page>("find", { text: "needle", limit, cursor: page.cursor });
				expect(page.count).toBe(600);
				refs.push(...page.items.map((c) => c.ref));
			}
			expect(refs).toHaveLength(600);
			expect(new Set(refs).size).toBe(600);
		}
		// Narrowed by a tag the cases do not have: the count is of what qualifies, not of what matches.
		expect(h.call<Page>("find", { text: "needle", tags: ["absent"], limit: 50 })).toMatchObject({
			count: 0,
			cursor: null,
			items: [],
		});
		expect(h.raw("find", { text: "needle", cursor: "3:abc" })).toMatchObject({ ok: false, error: { code: "invalid" } });
	});

	test("archiving hides a case from lists and keeps it readable", () => {
		h.call("propose", { edits: [{ op: "create", outline: OUTLINE }] });
		h.call("propose", { edits: [{ op: "state", cases: ["C-1"], to: "archived" }] });
		expect(h.call<{ items: unknown[] }>("find", {}).items).toEqual([]);
		expect(h.call<{ state: string }[]>("get", { refs: ["C-1"] })[0]?.state).toBe("archived");
	});

	test("archived search matches cannot hide the active match or change its count", () => {
		for (const [from, length] of [
			[0, 1100],
			[1100, 1001],
		] as const) {
			h.call("propose", {
				edits: Array.from({ length }, (_, i) => ({
					op: "create",
					folder: "Regression",
					outline: `Checkout common ${from + i}\n  Check > Pass`,
				})),
			});
		}
		h.call("propose", {
			edits: [{ op: "state", cases: Array.from({ length: 2100 }, (_, i) => `C-${i + 2}`), to: "archived" }],
		});
		type Page = { count: number | null; cursor: string | null; items: { ref: string }[] };
		for (const limit of [5, 50, 200]) {
			for (const scope of [{}, { folder: "Regression" }, { state: "active" }]) {
				const found = h.call<Page>("find", { text: "common", limit, ...scope });
				expect(found.items.map((item) => item.ref)).toEqual(["C-1"]);
				expect(found.count).toBe(1);
				expect(found.cursor).toBeNull();
			}
		}
		expect(h.call<Page>("find", { limit: 5 })).toMatchObject({ count: 1, items: [{ ref: "C-1" }] });
		expect(h.call("plan", { name: "Search regression", select: { text: "common" } })).toMatchObject({ slots: 1 });
		expect(h.call<Page>("find", { text: "common", state: "archived", limit: 5 })).toMatchObject({
			count: null,
			items: [{ ref: "C-2101" }, { ref: "C-2100" }, { ref: "C-2099" }, { ref: "C-2098" }, { ref: "C-2097" }],
		});
	});

	test.each(["data", "md"] as const)("conditional %s case reads refresh changed tags, coverage and state", (as) => {
		h.call("propose", { edits: [{ op: "create", outline: "Checkout #smoke @REQ-1\n  Check > Pass" }] });
		type Document = { hash: string; etag?: string; md?: string; tags?: string[]; covers?: string[]; state?: string };
		const before = h.call<Document[]>("get", { refs: ["C-1"], as })[0];
		if (!before) throw new Error("missing case");
		h.call("propose", {
			edits: [
				{ op: "place", cases: ["C-1"], tags: { set: ["critical"] } },
				{ op: "cover", case: "C-1", requirement: "REQ-2", on: true },
				{ op: "state", cases: ["C-1"], to: "archived" },
			],
		});
		const conditional = h.call<Document[]>("get", { refs: ["C-1"], as, unless: { "C-1": before.etag ?? before.hash } });
		if (as === "md") {
			expect(conditional[0]?.md).toContain("tags: [critical]");
			expect(conditional[0]?.md).toContain("covers: [REQ-1, REQ-2]");
		} else {
			expect(conditional[0]).toMatchObject({ tags: ["critical"], covers: ["REQ-1", "REQ-2"], state: "archived" });
		}
		expect(conditional).toEqual(h.call("get", { refs: ["C-1"], as }));
	});

	test("a document etag covers each requested field and keeps the body hash for reviews", () => {
		h.call("propose", {
			edits: [{ op: "create", folder: "Regression", outline: "Checkout #smoke @REQ-1\n  Check > Pass" }],
		});
		const read = (input = {}) => {
			const [doc] = h.call<Record<string, unknown>[]>("get", { refs: ["C-1"], ...input });
			if (!doc) throw new Error("missing case");
			return doc;
		};
		const created = read();
		for (const [edit, expected] of [
			[{ op: "place", cases: ["C-1"], tags: { set: ["critical"] } }, { tags: ["critical"] }],
			[{ op: "cover", case: "C-1", requirement: "REQ-2", on: true }, { covers: ["REQ-1", "REQ-2"] }],
			[{ op: "place", cases: ["C-1"], folder: "Moved" }, { folder: { path: "Moved" } }],
			[{ op: "folder", folder: "Moved", name: "Renamed" }, { folder: { path: "Renamed" } }],
			[{ op: "state", cases: ["C-1"], to: "archived" }, { state: "archived" }],
		] as const) {
			const before = read();
			expect(read({ unless: { "C-1": before.etag } })).toEqual({
				ref: "C-1",
				unchanged: true,
				hash: created.hash,
				etag: before.etag,
			});
			h.call("propose", { edits: [edit] });
			const changed = read({ unless: { "C-1": before.etag } });
			expect(changed).toMatchObject(expected);
			expect(changed.hash).toBe(created.hash);
			expect(changed.etag).not.toBe(before.etag);
		}
		const beforeEdit = read();
		h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Changed checkout" } }] });
		expect(read({ unless: { "C-1": beforeEdit.etag } })).toMatchObject({ title: "Changed checkout", version: 2 });
		const titleOnly = read({ fields: ["title"] });
		expect(read({ fields: ["title"], unless: { "C-1": titleOnly.etag } })).toMatchObject({ unchanged: true });
		expect(read({ unless: { "C-1": titleOnly.etag } })).toMatchObject({
			tags: ["critical"],
			covers: ["REQ-1", "REQ-2"],
		});
		expect(read({ as: "md", unless: { "C-1": read().etag } })).toMatchObject({
			md: expect.stringContaining("Changed checkout"),
		});
		expect(read({ version: 1, unless: { "C-1": created.etag } })).toMatchObject({ title: "Checkout", version: 1 });
		expect(read({ unless: { "C-1": read().hash } })).toMatchObject({ title: "Changed checkout" });
	});

	test("conditional data reads refresh proof without a body edit", () => {
		h.call("propose", { edits: [{ op: "create", outline: "Checkout\n  Check > Pass" }] });
		const [before] = h.call<{ etag: string; hash: string }[]>("get", { refs: ["C-1"] });
		if (!before) throw new Error("missing case");
		h.call("plan", { name: "Smoke", select: { cases: ["C-1"] } });
		h.call("report", { run: "R-1", results: [{ test: { case: "C-1" }, outcome: "pass" }] });
		expect(h.call("get", { refs: ["C-1"], unless: { "C-1": before.etag } })).toMatchObject([
			{ hash: before.hash, title: "Checkout", proof: { human: { outcome: "pass", current: true } } },
		]);
	});
});

test("a sliced savepoint closed early rolls back and drops the after-commit work it queued", () => {
	const db = new Db(":memory:");
	db.exec("CREATE TABLE t (x INTEGER)");
	const ran: string[] = [];
	db.begin();
	db.afterCommit(() => ran.push("before"));
	const steps = db.savepointSteps(function* () {
		db.exec("INSERT INTO t VALUES (1)");
		db.afterCommit(() => ran.push("inside"));
		yield;
		return 1;
	});
	steps.next();
	// An abandoned request closes its generator at a slice boundary, without a throw.
	steps.return(undefined as never);
	expect(db.raw.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
	db.commit();
	expect(ran).toEqual(["before"]);
	db.transaction(() => db.afterCommit(() => ran.push("next")));
	expect(ran).toEqual(["before", "next"]);
});

test("choosing current restores a deleted step named order through the registry", () => {
	const base = { ...emptyBody("Order step"), steps: [{ id: "order", action: "Before", expected: null }] };
	const current = { ...base, steps: [{ id: "order", action: "Current change", expected: null }] };
	const mine = { ...base, steps: [] };
	h.call("propose", { edits: [{ op: "create", body: base }] });
	h.call("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: current }] });
	const overlap = h.call<ProposeReply>("propose", { edits: [{ op: "edit", case: "C-1", base: 1, body: mine }] });
	expect(overlap.status).toBe("conflict");
	expect(overlap.conflicts).toEqual([{ case: "C-1", addresses: [{ kind: "step", id: "order" }] }]);
	const [proposal] = h.call<{ edits: { body: CaseBody; current: CaseBody; conflicts: Conflict[] }[] }[]>("get", {
		refs: [overlap.proposal],
	});
	const edit = proposal?.edits[0];
	const conflict = edit?.conflicts[0];
	if (!edit || !conflict) throw Error("Missing step conflict");
	const chosen = applyMergeChoice({ merged: edit.body, source: edit.current, address: conflict.address });
	const [question] = h.call<{ evidenceHash: string }[]>("get", { refs: [overlap.question] });
	expect(
		h.call<{ status: string }[]>("decide", {
			q: overlap.question,
			onEvidence: question?.evidenceHash,
			answer: { is: "merge", body: chosen },
		})[0]?.status,
	).toBe("decided");
	expect(storedBody().steps).toEqual([{ id: "order", action: "Current change", expected: null }]);
});

test("choosing current keeps the current fragment pin named order through the registry", () => {
	const fragment = { ...emptyBody("Fragment"), steps: [{ id: "ab", action: "v1", expected: null }] };
	h.call("propose", { edits: [{ op: "create", kind: "fragment", body: fragment }] });
	for (const version of [2, 3])
		h.call("propose", {
			edits: [
				{
					op: "edit",
					case: "C-1",
					base: version - 1,
					body: { steps: [{ id: "ab", action: `v${version}`, expected: null }] },
				},
			],
		});
	const pin = (version: number) => ({ id: "order", use: { fragment: "C-1", version }, action: "", expected: null });
	const base = { ...emptyBody("Pinned case"), steps: [pin(1)] };
	const current = { ...base, steps: [pin(3)] };
	const mine = { ...base, steps: [pin(2)] };
	h.call("propose", { edits: [{ op: "create", body: base }] });
	h.call("propose", { edits: [{ op: "edit", case: "C-2", base: 1, body: current }] });
	const overlap = h.call<ProposeReply>("propose", { edits: [{ op: "edit", case: "C-2", base: 1, body: mine }] });
	expect(overlap.status).toBe("conflict");
	expect(overlap.conflicts).toEqual([{ case: "C-2", addresses: [{ kind: "step", id: "order" }] }]);
	const [proposal] = h.call<{ edits: { body: CaseBody; current: CaseBody; conflicts: Conflict[] }[] }[]>("get", {
		refs: [overlap.proposal],
	});
	const edit = proposal?.edits[0];
	const conflict = edit?.conflicts[0];
	if (!edit || !conflict) throw Error("Missing pin conflict");
	const chosen = applyMergeChoice({ merged: edit.body, source: edit.current, address: conflict.address });
	const [question] = h.call<{ evidenceHash: string }[]>("get", { refs: [overlap.question] });
	expect(
		h.call<{ status: string }[]>("decide", {
			q: overlap.question,
			onEvidence: question?.evidenceHash,
			answer: { is: "merge", body: chosen },
		})[0]?.status,
	).toBe("decided");
	const [saved] = h.call<{ md: string }[]>("get", { refs: ["C-2"], as: "md" });
	const parsed = parseCase(saved?.md ?? "");
	if (!parsed.ok) throw Error("Invalid saved case");
	expect(parsed.doc.body.steps).toEqual([
		{ id: "order", use: { fragment: "C-1", version: 3 }, action: "", expected: null },
	]);
});

describe("conflict storage upgrades", () => {
	const addresses: ConflictAddress[] = [
		{ kind: "field", name: "title" },
		{ kind: "field", name: "pre" },
		{ kind: "field", name: "methods" },
		{ kind: "field", name: "automate" },
		{ kind: "custom-field", key: 'risk.dot"x' },
		{ kind: "custom-field", key: "gone" },
		{ kind: "step", id: "order" },
		{ kind: "step", id: "ds" },
		{ kind: "step-field", id: "sf", name: "action" },
		{ kind: "step-field", id: "sf", name: "expected" },
		{ kind: "step", id: "pf" },
		{ kind: "step-order" },
	];

	// Conflicts were generated by mergeBodies at b59be234, including both meanings of steps.order in one proposal.
	const oldInstance = (sample: (typeof legacyConflicts)[number]) => {
		const dir = mkdtempSync(join(tmpdir(), "mainworthy-conflict-upgrade-"));
		const config = defaultConfig({ MAINWORTHY_DATA: dir, MAINWORTHY_OWNER: "robin" });
		const instance = open({ ...config, port: 0 });
		const call = (op: string, input: unknown) => {
			const reply = invoke(instance.app, OPS, { op, input, project: "scratch", actor: () => instance.owner });
			if (!reply.ok) throw new Error(JSON.stringify(reply.error));
			return reply.result;
		};
		try {
			call("propose", { edits: [{ op: "create", kind: "fragment", outline: "Shared\n  Check" }] });
			for (const version of [1, 2]) {
				call("propose", { edits: [{ op: "edit", case: "C-1", base: version, body: { title: `Shared ${version}` } }] });
			}
			call("propose", { edits: [{ op: "create", body: CaseBody.parse(sample.base) }] });
			call("propose", {
				edits: [
					{ op: "create", outline: "Base" },
					{ op: "create", outline: "Uncontested" },
				],
			});
			call("propose", { edits: [{ op: "edit", case: "C-3", base: 1, body: { title: "Theirs" } }] });
			call("propose", { edits: [{ op: "edit", case: "C-2", base: 1, body: CaseBody.parse(sample.theirs) }] });
			const input = {
				cmd: "legacy-conflict-command",
				edits: [
					{ op: "edit", case: "C-4", base: 1, body: { title: "No conflict" } },
					{ op: "edit", case: "C-2", base: 1, body: CaseBody.parse(sample.mine) },
					{ op: "edit", case: "C-3", base: 1, body: { title: "Mine" } },
				],
			};
			const proposed = ProposeReply.parse(call("propose", input));
			expect(proposed.status).toBe("conflict");
			const db = instance.app.db;
			db.raw
				.query(
					`UPDATE proposals SET resolved = json_set(resolved, '$[1].conflicts', json(?), '$[2].conflicts', json(?)) WHERE no = ?`,
				)
				.run(
					JSON.stringify(sample.conflicts),
					JSON.stringify([sample.conflicts[0]]),
					Number(proposed.proposal?.slice(2)),
				);
			db.raw.query("UPDATE commands SET outcome = ? WHERE id = ?").run(
				JSON.stringify({
					...proposed,
					conflicts: [
						{ case: "C-2", paths: sample.conflicts.map((c) => c.path) },
						{ case: "C-3", paths: ["title"] },
					],
				}),
				input.cmd,
			);
			db.raw.query("UPDATE meta SET value = '30' WHERE key = 'schema_version'").run();
			const evidence = db.raw.query("SELECT evidence, evidence_hash FROM questions ORDER BY id").all();
			const command = db.raw
				.query("SELECT id, project, op, actor, at, seq, touched, request FROM commands ORDER BY id")
				.all();
			return { dir, config: { ...config, port: 0 }, input, proposed, evidence, command };
		} catch (error) {
			rmSync(dir, { recursive: true, force: true });
			throw error;
		} finally {
			instance.app.close();
		}
	};

	for (const sample of legacyConflicts) {
		for (const operation of ["get", "replay"] as const) {
			test(`old ${sample.kind} conflicts survive upgrade and archive: ${operation}`, async () => {
				const old = oldInstance(sample);
				const upgraded = open(old.config);
				const server = serve(upgraded.app, upgraded.owner);
				const client = new Client({ url: `http://127.0.0.1:${server.port}`, project: "scratch", token: undefined });
				const check = async (reader: Client) => {
					if (operation === "get") {
						const result = await reader.operation("get", { refs: [old.proposed.proposal] });
						expect(result).toMatchObject([
							{
								ref: old.proposed.proposal,
								edits: [
									{ conflicts: [] },
									{
										conflicts: sample.conflicts.map(({ path: _path, ...values }, index) => ({
											...values,
											address: addresses[index],
										})),
									},
									{
										conflicts: [
											{ address: { kind: "field", name: "title" }, base: "Base", mine: "Mine", theirs: "Theirs" },
										],
									},
								],
							},
						]);
					} else {
						expect(await reader.operation("propose", old.input)).toEqual({
							...old.proposed,
							conflicts: [
								{ case: "C-2", addresses },
								{ case: "C-3", addresses: [{ kind: "field", name: "title" }] },
							],
						});
					}
				};
				try {
					await check(client);
					expect(upgraded.app.db.raw.query("SELECT evidence, evidence_hash FROM questions ORDER BY id").all()).toEqual(
						old.evidence,
					);
					expect(
						upgraded.app.db.raw
							.query("SELECT id, project, op, actor, at, seq, touched, request FROM commands ORDER BY id")
							.all(),
					).toEqual(old.command);
					const chunks: string[] = [];
					exportArchive(upgraded.app.db, (chunk) => chunks.push(chunk), { blobs: upgraded.app.blobs });
					const restored = harness();
					try {
						removeBootstrap(restored.app.db);
						importArchive(restored.app.db, linesOf(chunks.join("")), { blobs: restored.app.blobs });
						const restoredServer = serve(restored.app, restored.owner);
						try {
							await check(
								new Client({ url: `http://127.0.0.1:${restoredServer.port}`, project: "scratch", token: undefined }),
							);
						} finally {
							await restoredServer.stop(true);
						}
					} finally {
						restored.close();
					}
					const empty = harness();
					try {
						removeBootstrap(empty.app.db);
						const legacyArchive = chunks.join("").replace(`"schema":${ARCHIVE_VERSION}`, '"schema":23');
						expect(() => importArchive(empty.app.db, linesOf(legacyArchive), { blobs: empty.app.blobs })).toThrow(
							`archive schema 23 is older than this build's archive schema ${ARCHIVE_VERSION}`,
						);
					} finally {
						empty.close();
					}
				} finally {
					await server.stop(true);
					upgraded.app.close();
					rmSync(old.dir, { recursive: true, force: true });
				}
			});
		}
	}
});
