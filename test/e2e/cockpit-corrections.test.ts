import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { AttachmentReply } from "../../src/core/attachments.ts";
import { Slot } from "../../src/web/runs/models.ts";
import { answer, browserAvailable, eventually, fetched, openPage, type Server, startServer } from "./support.ts";

const check = browserAvailable ? test : test.skip;

async function fixture(count = 1, minActors: 1 | 2 = 1) {
	const server = await startServer({ mode: "server" });
	try {
		await server.api("propose", {
			edits: Array.from({ length: count }, (_, index) => ({
				op: "create",
				body: {
					title: `Correction case ${index + 1}`,
					methods: ["human"],
					steps: [{ id: "open", action: "Open cart", expected: "Ready" }],
				},
			})),
		});
		const policy = await server.api("propose", { edits: [{ op: "policy", preset: "strict" }] });
		const question = (await server.api("inbox", { kind: "adopt" })).items.find((item) => item.q === policy.question);
		if (question)
			await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } });
		const plan = await server.api("plan", {
			name: "Cockpit corrections",
			select: {},
			require: [{ id: "exercise", kind: "exercise", methods: ["human"], minActors, basis: "exact" }],
		});
		return { server, run: plan.run, path: `/p/scratch/runs/${plan.run.slice(2)}` };
	} catch (error) {
		await server.stop();
		throw error;
	}
}

async function ready(page: Page) {
	page.setDefaultTimeout(5000);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.locator('[data-run-document="C-1"][data-active="true"][data-ready="true"]').waitFor();
}

async function screenshot(page: Page, issue: number) {
	const evidence = process.env.MAINWORTHY_COCKPIT_EVIDENCE;
	if (evidence) await page.screenshot({ path: `${evidence}/${issue}-${process.env.MAINWORTHY_COCKPIT_REVISION}.png` });
}

async function fail(page: Page, note: string) {
	await page.keyboard.press("f");
	await page.getByRole("textbox", { name: "Result note" }).fill(note);
	await page.keyboard.press("Enter");
}

async function slots(server: Server, run: string) {
	return Slot.array().parse((await server.api("find", { in: "slots", run })).items);
}

check(
	"reopening the cockpit keeps a pending failure before its later pass (632)",
	async () => {
		const { server, run, path } = await fixture(2);
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		const held = Promise.withResolvers<void>();
		const sent = Promise.withResolvers<void>();
		const passed = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const Reported = z.object({ outcome: z.string(), corrects: z.number().optional() });
		const reports: z.infer<typeof Reported>[] = [];
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			await page.route("**/report", async (route) => {
				const input = z.object({ results: Reported.array() }).parse(route.request().postDataJSON());
				const result = input.results[0];
				if (!result) throw new Error("Missing report result");
				reports.push(result);
				if (reports.length === 1) {
					sent.resolve();
					await held.promise;
				}
				const response = await fetched(route);
				if (!response) return;
				await answer(route, { response: response.response });
				if (result.outcome === "pass") passed.resolve();
				else delivered.resolve();
			});
			await fail(page, "Older failure");
			await sent.promise;
			await page.locator("#list").getByRole("link", { name: "Runs", exact: true }).click();
			await page.getByRole("option").filter({ hasText: "Cockpit corrections" }).click();
			await page.keyboard.press("Enter");
			await page.locator('[data-slot="1"]').click();
			await ready(page);
			await page.keyboard.press("p");
			// A broken queue sends the pass first. A preserved queue waits for the held failure.
			await Promise.race([passed.promise, Bun.sleep(1000)]);
			held.resolve();
			await Promise.all([passed.promise, delivered.promise]);
			const rows = await slots(server, run);
			const gate = await server.api("gate", { run });
			await page.locator(".run-verdict").filter({ hasText: gate.reason }).waitFor();
			await screenshot(page, 632);
			expect(rows[0]?.state).toBe("satisfied");
			expect(rows[0]?.fills).toMatchObject([{ outcome: "pass", note: null }]);
			expect(rows[0]?.fills).toHaveLength(1);
			expect(rows[1]?.state).toBe("missing");
			expect((await server.api("gate", { run })).verdict).toBe("pending");
			const history = (await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result");
			expect(history.map((entry) => entry.outcome)).toEqual(["pass", "fail"]);
			expect(reports).toEqual([{ outcome: "fail" }, { outcome: "pass", corrects: history[1]?.id }]);
		} finally {
			held.resolve();
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"reopening the cockpit resolves its uncertain report before a correction (632)",
	async () => {
		const { server, run, path } = await fixture(2);
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			const reports: unknown[] = [];
			await page.route("**/report", (route) => {
				reports.push(route.request().postDataJSON());
				return reports.length === 1 ? route.abort() : route.continue();
			});
			await page.route("**/command", (route) => route.abort());
			await fail(page, "Uncertain failure");
			await page
				.locator("#stat")
				.filter({ hasText: "check the same request before recording another result" })
				.waitFor();
			await page.locator("#list").getByRole("link", { name: "Runs", exact: true }).click();
			await page.getByRole("option").filter({ hasText: "Cockpit corrections" }).click();
			await page.keyboard.press("Enter");
			await page.locator('[data-slot="1"]').click();
			await ready(page);
			await page.unroute("**/command");
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			expect(reports).toHaveLength(2);
			expect(reports[1]).toEqual(reports[0]);
			const recovered = (await slots(server, run))[0]?.fills[0];
			expect(recovered).toMatchObject({ outcome: "fail", note: "Uncertain failure" });
			expect(await page.getByRole("textbox", { name: "Result note" }).inputValue()).toBe("");
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
			const rows = await slots(server, run);
			expect(rows[0]?.fills).toMatchObject([{ outcome: "pass", note: null }]);
			expect(rows[0]?.fills).toHaveLength(1);
			expect(rows[0]?.state).toBe("satisfied");
			expect((await server.api("gate", { run })).verdict).toBe("pending");
			expect(reports[2]).toMatchObject({ results: [{ outcome: "pass", corrects: recovered?.result }] });
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"undo preserves a newer failure recorded in another tab (542)",
	async () => {
		const { server, run, path } = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			view = await openPage(server, { path });
			const { page, context } = view;
			await ready(page);
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
			await fail(page, "First tab failure");
			await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			const other = await context.newPage();
			await other.goto(`${server.url}${path}`);
			await ready(other);
			await fail(other, "Second tab new failure");
			await other.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			await page.locator(".run-evidence").filter({ hasText: "Second tab new failure" }).waitFor();
			await page.bringToFront();
			await page.keyboard.press("u");
			await eventually(
				async () => ({ status: await page.locator("#stat").innerText(), rows: await slots(server, run) }),
				({ status, rows }) => status.includes("changed since") || rows[0]?.fills[0]?.outcome === "pass",
			);
			await screenshot(page, 542);
			expect((await server.api("gate", { run })).verdict).toBe("blocked");
			expect((await slots(server, run))[0]?.fills).toMatchObject([{ outcome: "fail", note: "Second tab new failure" }]);
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
			).toHaveLength(3);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"undo restores confirmed evidence after a queued predecessor is refused (543)",
	async () => {
		const { server, run, path } = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		const held = Promise.withResolvers<void>();
		const sent = Promise.withResolvers<void>();
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			let attempts = 0;
			await page.route("**/report", async (route) => {
				const input = z
					.object({ results: z.array(z.object({ outcome: z.string() })) })
					.parse(route.request().postDataJSON());
				if (input.results[0]?.outcome !== "pass") return route.continue();
				if (++attempts > 2) return route.continue();
				if (attempts === 1) {
					sent.resolve();
					await held.promise;
					return route.abort();
				}
				return route.fulfill({ status: 400, json: { ok: false, error: { code: "invalid", message: "Pass refused" } } });
			});
			await page.keyboard.press("p");
			await sent.promise;
			await fail(page, "Actually fails");
			held.resolve();
			await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			expect(
				(await server.api("timeline", { ref: "C-1" })).entries.filter((entry) => entry.t === "result"),
			).toMatchObject([{ outcome: "fail", note: "Actually fails" }]);
			await page.keyboard.press("u");
			const history = await eventually(
				() => server.api("timeline", { ref: "C-1" }),
				(row) => row.entries.filter((entry) => entry.t === "result").length === 2,
			);
			await eventually(
				() => page.locator(".run-evidence").innerText(),
				(text) => text.includes("Withdrawn by the author"),
			);
			const gate = await server.api("gate", { run });
			await page.locator(".run-verdict").filter({ hasText: gate.reason }).waitFor();
			await screenshot(page, 543);
			expect(history.entries.filter((entry) => entry.t === "result").map((entry) => entry.outcome)).toEqual([
				"skip",
				"fail",
			]);
			expect(gate).toMatchObject({ verdict: "pending", tally: { pass: 0 } });
		} finally {
			held.resolve();
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"a second required person can navigate to and fill another person's slot (546)",
	async () => {
		const { server, run, path } = await fixture(2, 2);
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("report", { run, results: [{ test: { case: "C-1" }, outcome: "pass" }] });
			const { token } = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "second-person",
					kind: "human",
					can: ["read", "produce"],
					project: "scratch",
				}),
			);
			view = await openPage({ ...server, token }, { path });
			const { page } = view;
			await ready(page);
			await screenshot(page, 546);
			expect(await page.getByRole("button", { name: "p Pass", exact: true }).isEnabled()).toBe(true);
			await page.getByRole("option").filter({ hasText: "C-2" }).click();
			await page.keyboard.press("k");
			expect(await page.locator('[data-run-document][data-active="true"]').getAttribute("data-run-document")).toBe(
				"C-1",
			);
			await page.keyboard.press("p");
			const rows = await eventually(
				() => slots(server, run),
				(rows) => rows[0]?.state === "satisfied",
			);
			expect(rows[0]?.fills.map(({ by, outcome }) => ({ by, outcome }))).toEqual([
				{ by: "robin", outcome: "pass" },
				{ by: "second-person", outcome: "pass" },
			]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);

check(
	"undo restores an earlier failure's attachments and step (548)",
	async () => {
		const { server, run, path } = await fixture(2);
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			view = await openPage(server, { path });
			const { page } = view;
			await ready(page);
			await page
				.getByLabel("Attach a file")
				.setInputFiles({ name: "proof.txt", mimeType: "text/plain", buffer: Buffer.from("Original failure proof") });
			await page.getByRole("button", { name: "Remove proof.txt" }).waitFor();
			await page.keyboard.press("1");
			await fail(page, "Original failure");
			await page.locator("#stat").filter({ hasText: "C-1 fail recorded" }).waitFor();
			await page.keyboard.press("k");
			await page.getByRole("button", { name: "Download proof.txt" }).waitFor();
			await page.keyboard.press("p");
			await page.locator("#stat").filter({ hasText: "C-1 pass recorded" }).waitFor();
			await page.keyboard.press("u");
			const rows = await eventually(
				() => slots(server, run),
				(rows) => rows[0]?.fills[0]?.outcome === "fail",
			);
			const restored = rows[0]?.fills[0];
			if (!restored) throw new Error("Restored result missing");
			await page.locator(".run-evidence").filter({ hasText: "Original failure" }).waitFor();
			const listed = AttachmentReply.parse(await server.api("attachment", { result: restored.result }));
			if (listed.kind === "list" && listed.items.length)
				await page.getByRole("button", { name: "Download proof.txt" }).waitFor();
			await screenshot(page, 548);
			expect(listed).toMatchObject({ kind: "list", items: [{ name: "proof.txt", at: "open" }] });
			if (listed.kind !== "list" || !listed.items[0]) throw new Error("Restored attachment missing");
			expect(
				AttachmentReply.parse(await server.api("attachment", { result: restored.result, id: listed.items[0].id })),
			).toMatchObject({ kind: "file", data: Buffer.from("Original failure proof").toString("base64") });
			expect(restored).toMatchObject({ outcome: "fail", note: "Original failure", atStep: "open" });
			await page.getByRole("button", { name: "Download proof.txt" }).waitFor();
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30_000,
);
