import { expect, test } from "bun:test";
import { answer, browserAvailable, eventually, openPage, type Server, startServer } from "./support.ts";

/** A server with the preset these tests ask for, on a port the helpers hand out. */
function fixture({
	preset = "standard",
	mode = "local",
}: {
	preset?: string;
	mode?: "local" | "server";
} = {}): Promise<Server> {
	return startServer({ mode, ...(preset === "loose" ? {} : { preset }) });
}

import { z } from "zod";

for (const answer of ["accept", "reject"] as const)
	(browserAvailable ? test : test.skip)(
		`strict: the case pane records ${answer} with the required reason`,
		async () => {
			const server = await startServer({ preset: "strict", seed: false });
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				const created = await server.api("propose", { edits: [{ op: "create", outline: "Original strict" }] });
				const initial = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === created.question);
				if (!initial) throw new Error("Missing creation question");
				await server.api("decide", {
					q: initial.q,
					onEvidence: initial.evidenceHash,
					answer: { is: "accept" },
					reason: "Establish the original case",
				});
				const proposed = await server.api("propose", {
					edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Changed strict" } }],
				});
				if (!proposed.question) throw new Error("Missing edit question");
				view = await openPage(server, { path: "/p/scratch/suite/c/1" });
				const { page } = view;
				await page.setViewportSize({ width: 1280, height: 800 });
				await page.locator(`[data-proposal-evidence="${proposed.question}"][data-proposal-read="ready"]`).waitFor();
				if (answer === "accept") await page.getByRole("button", { name: "Accept" }).click();
				else await page.keyboard.press("r");
				const reason = page.getByRole("textbox", {
					name: `${answer === "accept" ? "Accept" : "Reject"}: reason required by policy`,
				});
				expect(await reason.count()).toBe(1);
				await reason.fill("   ");
				await reason.press("Enter");
				expect((await server.api("get", { refs: [proposed.question] }))[0]?.state).toBe("open");
				await reason.fill("The title should name the expected result");
				const response = page.waitForResponse((reply) => reply.url().endsWith("/decide"));
				await reason.press("Enter");
				await response;
				expect((await server.api("get", { refs: [proposed.question] }))[0]?.decision).toMatchObject({
					answer: { is: answer },
					reason: "The title should name the expected result",
				});
				expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
					title: answer === "accept" ? "Changed strict" : "Original strict",
					version: answer === "accept" ? 2 : 1,
				});
				expect(view.errors).toEqual([]);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30000,
	);

for (const surface of ["case", "queue"] as const)
	for (const device of ["desktop", "phone"] as const)
		(browserAvailable ? test : test.skip)(
			`${surface} on ${device}: an unbroken diff wraps and every part must be shown before answering`,
			async () => {
				const server = await startServer({ preset: "standard", seed: false });
				let view: Awaited<ReturnType<typeof openPage>> | null = null;
				try {
					await server.api("propose", {
						edits: [{ op: "create", outline: "Read the entire token\n  Original step > Token is visible" }],
					});
					const writer = z.object({ token: z.string() }).parse(
						await server.api("admin", {
							do: "token.create",
							actor: "writer",
							kind: "agent",
							can: ["read", "produce"],
							project: "scratch",
						}),
					).token;
					const proposed = await server.api(
						"propose",
						{
							edits: [
								{
									op: "edit",
									case: "C-1",
									base: 1,
									body: {
										steps: [{ id: "token", action: "x".repeat(6000), expected: "Token is visible" }],
									},
								},
							],
						},
						{ token: writer },
					);
					if (!proposed.question) throw new Error("Missing edit question");
					view = await openPage(server, {
						device,
						path: surface === "case" ? "/p/scratch/suite/c/1" : `/p/scratch/queue/${proposed.question.slice(2)}`,
					});
					const { page } = view;
					const painted = () =>
						page.evaluate(
							() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
						);
					if (device === "desktop") await page.setViewportSize({ width: 1280, height: 800 });
					const evidence = page.locator(`[data-proposal-evidence="${proposed.question}"][data-proposal-loaded="true"]`);
					await evidence.waitFor();
					const row = evidence.locator(".dl").filter({ hasText: "x".repeat(100) });
					expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
					expect(await evidence.getAttribute("data-proposal-read")).toBe("loaded");
					// Jumping to the end must leave the unshown middle unread.
					const scroller = surface === "case" ? evidence : page.locator(".queue-evidence");
					await scroller.evaluate((element) => {
						element.scrollTop = element.scrollHeight;
					});
					await page.keyboard.press("r");
					await painted();
					expect((await server.api("get", { refs: [proposed.question] }))[0]?.state).toBe("open");
					let pages = 0;
					while ((await evidence.getAttribute("data-proposal-read")) !== "ready" && pages++ < 40) {
						await page.keyboard.press("r");
						await painted();
						expect((await server.api("get", { refs: [proposed.question] }))[0]?.state).toBe("open");
					}
					expect(await evidence.getAttribute("data-proposal-read")).toBe("ready");
					const response = page.waitForResponse((reply) => reply.url().endsWith("/decide"));
					await page.keyboard.press("r");
					await response;
					expect((await server.api("get", { refs: [proposed.question] }))[0]?.decision).toMatchObject({
						answer: { is: "reject" },
					});
					expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({
						title: "Read the entire token",
						version: 1,
					});
					expect(view.errors).toEqual([]);
				} finally {
					await view?.close();
					await server.stop();
				}
			},
			30000,
		);

(browserAvailable ? test : test.skip)(
	"a case proposal answer cannot replace a decision made before its request arrives",
	async () => {
		const server = await fixture();
		await server.api("propose", { edits: [{ op: "create", outline: "Original title" }] });
		const writer = z.object({ token: z.string() }).parse(
			await server.api("admin", {
				do: "token.create",
				actor: "writer",
				kind: "agent",
				can: ["read", "produce"],
				project: "scratch",
			}),
		).token;
		const proposed = await server.api(
			"propose",
			{
				edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Proposed title" } }],
			},
			{ token: writer },
		);
		const question = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
		if (!question) throw Error("Missing proposal");
		const view = await openPage(server, { path: "/p/scratch/suite/c/1" });
		try {
			const { page } = view;
			page.setDefaultTimeout(5000);
			await page.locator(`[data-proposal-evidence="${question.q}"][data-proposal-read="ready"]`).waitFor();
			await page.route("**/decide", async (route) => {
				await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } });
				await route.continue();
			});
			const replied = page.waitForResponse((response) => response.url().endsWith("/decide"));
			await page.locator(`[data-proposal="${question.q}"]`).getByRole("button", { name: "Accept" }).click();
			await replied;
			expect((await server.api("get", { refs: [question.q] }))[0]?.decision).toMatchObject({
				answer: { is: "reject" },
			});
			expect((await server.api("get", { refs: ["C-1"] }))[0]).toMatchObject({ title: "Original title", version: 1 });
			await page.locator("#bar").getByText("settled meanwhile", { exact: false }).waitFor();
			expect(view.errors).toEqual([]);
		} finally {
			await view.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"standard: a adopts the agent's real diff and preserves agent attribution",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await server.api("propose", {
				edits: [{ op: "create", outline: "Coupon applies\n  Apply SAVE10 > Total updates" }],
			});
			const writer = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const body = (await server.api("get", { refs: ["C-1"] }))[0];
			const steps = z
				.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() }))
				.parse(body?.steps);
			const proposed = await server.api(
				"propose",
				{
					edits: [
						{
							op: "edit",
							case: "C-1",
							base: 1,
							body: { steps: steps.map((step) => ({ ...step, expected: "Total shows $90.00" })) },
						},
					],
					reason: "Give the coupon an exact assertion",
				},
				{ token: writer },
			);
			expect(proposed.status).toBe("open");
			view = await openPage(server, { path: `/p/scratch/queue/${proposed.question?.slice(2)}` });
			await view.page.locator(".prop .diff").waitFor();
			expect(await view.page.locator(".prop .diff").innerText()).toContain("$90.00");
			expect(await view.page.locator(".prop").innerText()).toContain("writer proposes");
			// The reply to the answer is held, so the server has the adopted version while the page has not yet
			// recorded its answer: the order in which a fast person presses u.
			await view.page.route("**/decide", async (route) => {
				const response = await route.fetch();
				await held;
				await route.fulfill({ response }).catch(() => {});
			});
			await view.page.keyboard.press("a");
			const current = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect(z.array(z.object({ expected: z.string().nullable() })).parse(current[0]?.steps)[0]?.expected).toBe(
				"Total shows $90.00",
			);
			const timeline = await server.api("timeline", { ref: "C-1" });
			expect(timeline.entries.find((entry) => entry.t === "version" && entry.version === 2)).toMatchObject({
				by: "writer",
				kind: "agent",
			});
			// Pressed before the page has its reply, u already says that an adopted edit stays. The pane's own
			// line is replaced by "recorded" when the reply lands, so this is read from the status bar, which stays.
			await view.page.keyboard.press("u");
			const status = view.page.locator("#bar").filter({ hasText: "An adopted edit stays in history." });
			await status.waitFor();
			release();
			await view.page.getByText(`${proposed.question} · Accept · recorded`, { exact: false }).waitFor();
			// Pressed once the page has recorded the answer, the pane says it too, and keeps saying it.
			await view.page.keyboard.press("u");
			await view.page.getByText("Proposal decisions cannot be withdrawn.", { exact: false }).waitFor();
			await status.waitFor();
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(2);
			expect(view.errors).toEqual([]);
			expect(view.dialogs).toEqual([]);
		} finally {
			release();
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"on a case page, a proposal below the edge of the pane is brought into view before a key answers it",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const steps = Array.from({ length: 6 }, (_, i) => `  Step ${i + 1} of the checkout > Result ${i + 1} is shown`);
			await server.api("propose", {
				edits: [{ op: "create", outline: ["Checkout with a coupon", ...steps].join("\n") }],
			});
			const writer = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const proposed = await server.api(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Checkout with a percentage coupon" } }] },
				{ token: writer },
			);
			expect(proposed.status).toBe("open");
			view = await openPage(server, { path: "/p/scratch/suite/c/1" });
			await view.page.setViewportSize({ width: 1280, height: 800 });
			const card = view.page.locator(`[data-proposal="${proposed.question}"]`);
			await card.waitFor({ state: "attached" });
			await view.page.locator(".pane-scroll").evaluate((pane) => {
				pane.scrollTop = 0;
			});
			const inView = () =>
				card.evaluate((element) => {
					const box = element.getBoundingClientRect();
					const frame = element.closest(".pane-scroll")?.getBoundingClientRect();
					return frame !== undefined && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
				});
			// The title edit fits once revealed, but revealing it cannot count it as already read.
			await view.page.locator(`[data-proposal-evidence="${proposed.question}"][data-proposal-loaded="true"]`).waitFor();
			expect(await inView()).toBe(false);
			await view.page.keyboard.press("a");
			await view.page
				.getByText(`${proposed.question} has unread edits. Read the next part, then press a again.`, { exact: true })
				.waitFor();
			expect(await inView()).toBe(true);
			expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
			expect((await server.api("inbox", { kind: "adopt" })).items.map((q) => q.q)).toEqual([proposed.question ?? ""]);
			// Now it is on the screen, and the same key answers it.
			await view.page.keyboard.press("a");
			const adopted = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.version === 2,
			);
			expect(adopted[0]?.title).toBe("Checkout with a percentage coupon");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"a long proposal fits in the pane, and a key answers it only after its last change has been shown",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const steps = Array.from({ length: 6 }, (_, i) => `  Step ${i + 1} > Result ${i + 1}`);
			await server.api("propose", { edits: [{ op: "create", outline: ["Long checkout", ...steps].join("\n") }] });
			const writer = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const proposed = await server.api(
				"propose",
				{
					edits: [
						{
							op: "edit",
							case: "C-1",
							base: 1,
							body: {
								steps: Array.from({ length: 35 }, (_, i) => ({
									id: `n${i}`,
									action: `Rewritten step ${i + 1} of the long checkout`,
									expected: `Rewritten result ${i + 1}`,
								})),
							},
						},
					],
				},
				{ token: writer },
			);
			expect(proposed.status).toBe("open");
			for (const size of [
				{ width: 1280, height: 800 },
				{ width: 1440, height: 900 },
			]) {
				view = await openPage(server, { path: "/p/scratch/suite/c/1" });
				const page = view.page;
				await page.setViewportSize(size);
				const card = page.locator(`[data-proposal="${proposed.question}"]`);
				await card.waitFor({ state: "attached" });
				const state = () =>
					card.evaluate((element) => {
						const box = element.getBoundingClientRect();
						const frame = element.closest(".pane-scroll")?.getBoundingClientRect();
						const edits = element.querySelector(".proposal-edits");
						return {
							whole: frame !== undefined && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1,
							fits: frame !== undefined && box.height <= frame.height,
							atEnd: edits !== null && edits.scrollTop + edits.clientHeight >= edits.scrollHeight - 2,
						};
					});
				const open = async () => (await server.api("inbox", { kind: "adopt" })).items.map((q) => q.q);
				// Thirty-five changed steps: the card still fits in the pane, with the diff scrolling inside it.
				expect((await state()).fits).toBe(true);
				// Scrolled straight to the bottom of the pane, the key still does not answer: the end of the diff
				// has not been shown.
				await page.locator(".pane-scroll").evaluate((pane) => {
					pane.scrollTop = pane.scrollHeight;
				});
				let presses = 0;
				for (; presses < 40; presses++) {
					const before = await state();
					if (before.whole && before.atEnd) break;
					await page.keyboard.press("r");
					await page.waitForTimeout(60);
					expect(await open()).toEqual([proposed.question ?? ""]);
				}
				expect(presses).toBeGreaterThan(1);
				expect(await state()).toMatchObject({ whole: true, atEnd: true });
				if (size.width === 1440) {
					// Everything has been shown: now the key answers.
					await page.keyboard.press("r");
					await eventually(open, (items) => items.length === 0);
					expect((await server.api("get", { refs: ["C-1"] }))[0]?.version).toBe(1);
				}
				expect(view.errors).toEqual([]);
				await view.close();
				view = null;
			}
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	60000,
);

(browserAvailable ? test : test.skip)(
	"a case's proposal card shows every edit of the proposal, the other cases' too, before a click accepts it",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", {
				edits: [
					{ op: "create", outline: "First case\n  Open > Shown" },
					{ op: "create", outline: "Second case\n  Open > Shown", tags: ["keep", "old"] },
				],
			});
			const writer = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const proposed = await server.api(
				"propose",
				{
					edits: [
						{
							op: "edit",
							case: "C-1",
							base: 1,
							body: {
								title: "Sign in with a passkey",
								steps: Array.from({ length: 35 }, (_, i) => ({
									id: `n${i}`,
									action: `Rewritten step ${i + 1}`,
									expected: `Rewritten result ${i + 1}`,
								})),
							},
						},
						{ op: "edit", case: "C-2", base: 1, body: { title: "Pay by voucher" } },
						{ op: "state", cases: ["C-1"], to: "archived" },
						{ op: "place", cases: ["C-2"], tags: { remove: ["old"] } },
						{ op: "create", outline: "Refund by voucher", tags: ["refunds"], covers: ["WEB-900"] },
						{ op: "place", cases: ["C-1"], after: "C-2" },
						{ op: "folder", name: "Later", archive: true },
						{ op: "policy", unlinked: "create" },
					],
				},
				{ token: writer },
			);
			expect(proposed.status).toBe("open");
			// The second case's page: before, its card showed the first edit's body, which is the first case's.
			view = await openPage(server, { path: "/p/scratch/suite/c/2" });
			const page = view.page;
			await page.setViewportSize({ width: 1280, height: 800 });
			page.setDefaultTimeout(5000);
			const card = page.locator(`[data-proposal="${proposed.question}"]`);
			await card.waitFor();
			// What the card says the proposal leaves: its text without the words a diff strikes out.
			const proposedText = () =>
				card.evaluate((element) => {
					const copy = element.cloneNode(true) as HTMLElement;
					for (const struck of copy.querySelectorAll("del")) struck.remove();
					return copy.textContent ?? "";
				});
			const shown = [
				"Sign in with a passkey",
				"Pay by voucher",
				"C-1 becomes archived",
				"C-2 · removes tags old",
				"tags refunds · covers WEB-900",
				"Refund by voucher",
				"C-1 · asked to follow C-2",
				"New folder Later.",
				"Setting unlinked: track becomes create",
			];
			const text = await eventually(proposedText, (value) => shown.every((part) => value.includes(part))).catch(
				proposedText,
			);
			for (const part of shown) expect(text).toContain(part);
			// A folder made by a proposal is made active, whatever the edit says of archiving.
			expect(text).not.toContain("is archived");
			const open = async () => (await server.api("inbox", { kind: "adopt" })).items.map((q) => q.q);
			// The last edits are below the end of the card's scrolling edits. A click on Accept pages through them,
			// as the key does, and accepts only once the last one is showing.
			const atEnd = () =>
				card
					.locator(".proposal-edits")
					.evaluate((edits) => edits.scrollTop + edits.clientHeight >= edits.scrollHeight - 2);
			const accept = card.getByRole("button", { name: "Accept" });
			let clicks = 0;
			for (; clicks < 30 && !(await atEnd()); clicks++) {
				await accept.click();
				await page.waitForTimeout(60);
				expect(await open()).toEqual([proposed.question ?? ""]);
			}
			expect(clicks).toBeGreaterThan(1);
			await accept.click();
			await eventually(open, (items) => items.length === 0);
			const cases = await server.api("get", { refs: ["C-1", "C-2", "C-3"] });
			expect(cases.map((row) => [row.title, row.state, row.tags, row.covers])).toEqual([
				["Sign in with a passkey", "archived", [], []],
				["Pay by voucher", "active", ["keep"], []],
				["Refund by voucher", "active", ["refunds"], ["WEB-900"]],
			]);
			const policy = z
				.object({ settings: z.object({ unlinked: z.string() }) })
				.parse(await server.api("admin", { do: "policy.show", project: "scratch" }));
			expect(policy.settings.unlinked).toBe("create");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"a case's proposal card shows what accepting writes: all a restore brings back, and the case's newer version",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			await server.api("propose", { edits: [{ op: "create", outline: "Checkout\n  Open > Original result" }] });
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "Before precondition", fields: { risk: "low" } } }],
			});
			await server.api("propose", {
				edits: [{ op: "edit", case: "C-1", base: 2, body: { pre: "Current precondition", fields: { risk: "high" } } }],
			});
			const writer = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const restore = await server.api(
				"propose",
				{ edits: [{ op: "restore", case: "C-1", to: 2 }] },
				{ token: writer },
			);
			expect(restore.status).toBe("open");
			view = await openPage(server, { path: "/p/scratch/suite/c/1" });
			const page = view.page;
			page.setDefaultTimeout(5000);
			const proposedText = (q: string) => () =>
				page.locator(`[data-proposal="${q}"]`).evaluate((element) => {
					const copy = element.cloneNode(true) as HTMLElement;
					for (const struck of copy.querySelectorAll("del")) struck.remove();
					return copy.textContent ?? "";
				});
			// Before, a restore showed its title and steps: not the precondition or the field it brings back.
			const restored = await eventually(proposedText(restore.question ?? ""), (text) =>
				text.includes("Before precondition"),
			).catch(proposedText(restore.question ?? ""));
			expect(restored).toContain("Before precondition");
			expect(restored).toContain("low");
			expect(restored).not.toContain("Current precondition");
			const question = (await server.api("inbox", { kind: "adopt" })).items[0];
			if (!question) throw new Error("No restore question");
			await server.api("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "reject" } });

			const renamed = await server.api(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base: 3, body: { title: "Checkout with a voucher" } }] },
				{ token: writer },
			);
			expect(renamed.status).toBe("open");
			await page.locator(`[data-proposal-evidence="${renamed.question}"][data-proposal-loaded="true"]`).waitFor();
			// A person changes the case while the card is open. Accepting merges the title onto that version, and
			// the card shows it so: before, it kept the version it first read.
			const steps = z
				.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() }))
				.parse((await server.api("get", { refs: ["C-1"] }))[0]?.steps);
			await server.api("propose", {
				edits: [
					{
						op: "edit",
						case: "C-1",
						base: 3,
						body: { steps: steps.map((step) => ({ ...step, expected: "New person result" })) },
					},
				],
			});
			const merged = await eventually(proposedText(renamed.question ?? ""), (text) =>
				text.includes("New person result"),
			).catch(proposedText(renamed.question ?? ""));
			expect(merged).toContain("Checkout with a voucher");
			expect(merged).toContain("New person result");
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

(browserAvailable ? test : test.skip)(
	"a case's proposal card is not answered while it is short of edits, read again, or changed above where it was read",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const steps = Array.from({ length: 40 }, (_, i) => `  Step ${i + 1} > Result ${i + 1}`);
			await server.api("propose", { edits: [{ op: "create", outline: ["Checkout", ...steps].join("\n") }] });
			const writer = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			).token;
			const proposed = await server.api(
				"propose",
				{ edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Checkout with a voucher" } }] },
				{ token: writer },
			);
			if (!proposed.question || !proposed.proposal) throw new Error("No proposal");
			const q = proposed.question;
			view = await openPage(server);
			const page = view.page;
			page.setDefaultTimeout(5000);
			await page.setViewportSize({ width: 1280, height: 800 });
			const decides: string[] = [];
			page.on("request", (request) => {
				if (request.url().endsWith("/decide")) decides.push(request.url());
			});
			// A reply that holds fewer edits than the proposal has (a page holds 200 at most) is not answered.
			await page.route("**/get", async (route) => {
				const input = z.object({ refs: z.array(z.string()) }).parse(route.request().postDataJSON());
				if (!input.refs.includes(proposed.proposal ?? "")) return route.continue();
				const reply = await route.fetch();
				const envelope = z.object({ result: z.array(z.record(z.string(), z.unknown())) }).parse(await reply.json());
				const rows = envelope.result.map((row) => ({ ...row, count: Number(row.count) + 1 }));
				await route.fulfill({ response: reply, json: { ...envelope, ok: true, result: rows } });
			});
			await page.goto(`${server.url}/p/scratch/suite/c/1`);
			const edits = page.locator(`[data-proposal-evidence="${q}"]`);
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-read="error"]`).waitFor();
			expect(await edits.getAttribute("data-proposal-error")).toBe(
				"This proposal has 2 edits, and a page shows the first 1. Accepting applies all of them, so it cannot be answered here.",
			);
			const accept = page.locator(`[data-proposal="${q}"]`).getByRole("button", { name: "Accept" });
			for (let i = 0; i < 3; i++) await accept.click();
			expect(decides).toEqual([]);
			await page.unroute("**/get");
			await page.reload();
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();

			const atEnd = () =>
				edits.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2);
			const pageToEnd = async () => {
				for (let clicks = 0; clicks < 30 && !(await atEnd()); clicks++) {
					await accept.click();
					await page.waitForTimeout(60);
				}
				expect(await atEnd()).toBe(true);
			};
			const changeStep = async (index: number, expected: string) => {
				const [row] = await server.api("get", { refs: ["C-1"] });
				const body = z
					.object({
						version: z.number(),
						steps: z.array(z.object({ id: z.string(), action: z.string(), expected: z.string().nullable() })),
					})
					.parse(row);
				await server.api("propose", {
					edits: [
						{
							op: "edit",
							case: "C-1",
							base: body.version,
							body: { steps: body.steps.map((step, i) => (i === index ? { ...step, expected } : step)) },
						},
					],
				});
			};
			// Read to its end, then a person changes the first step: the card starts again from the top.
			await pageToEnd();
			await changeStep(0, "Newly critical result");
			await page.locator(`[data-proposal="${q}"]`).getByText("Newly critical result").waitFor();
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-loaded="true"]`).waitFor();
			expect(await edits.evaluate((element) => element.scrollTop)).toBe(0);
			await accept.click();
			expect(decides).toEqual([]);

			// While the card is read again after a change, it is not answered.
			await pageToEnd();
			let held = () => {};
			const hold = new Promise<void>((resolve) => {
				held = resolve;
			});
			let reads = 0;
			await page.route("**/get", async (route) => {
				const input = z.object({ refs: z.array(z.string()) }).parse(route.request().postDataJSON());
				if (input.refs.includes(proposed.proposal ?? "")) {
					reads++;
					await hold;
				}
				await route.continue();
			});
			await changeStep(39, "Last result, changed");
			await eventually(
				async () => reads,
				(n) => n > 0,
			);
			await page.locator(`[data-proposal-evidence="${q}"][data-proposal-read="loading"]`).waitFor();
			for (let i = 0; i < 3; i++) await accept.click();
			expect(decides).toEqual([]);
			held();
			await page.locator(`[data-proposal="${q}"]`).getByText("Last result, changed").waitFor();
			await pageToEnd();
			await accept.click();
			const [adopted] = await eventually(
				() => server.api("get", { refs: ["C-1"] }),
				(rows) => rows[0]?.title === "Checkout with a voucher",
			);
			const kept = z.array(z.object({ expected: z.string().nullable() })).parse(adopted?.steps);
			expect([kept[0]?.expected, kept[39]?.expected]).toEqual(["Newly critical result", "Last result, changed"]);
			expect(view.errors).toEqual([]);
		} finally {
			await view?.page.unroute("**/get").catch(() => {});
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

for (const via of ["key", "button"] as const) {
	(browserAvailable ? test : test.skip)(
		`Queue ${via} shows the last edits before accepting the whole proposal`,
		async () => {
			const server = await fixture();
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			try {
				await server.api("propose", {
					edits: [
						{ op: "create", outline: "First case" },
						{ op: "create", outline: "Second case" },
					],
				});
				const { token } = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "writer",
						kind: "agent",
						can: ["read", "produce"],
						project: "scratch",
					}),
				);
				const proposed = await server.api(
					"propose",
					{
						edits: [
							{
								op: "edit",
								case: "C-1",
								base: 1,
								body: {
									steps: Array.from({ length: 45 }, (_, i) => ({
										id: `n${i}`,
										action: `Changed step ${i + 1}`,
										expected: `Result ${i + 1}`,
									})),
								},
							},
							{ op: "edit", case: "C-2", base: 1, body: { title: "Last renamed case" } },
							{ op: "state", cases: ["C-2"], to: "archived" },
						],
					},
					{ token },
				);
				view = await openPage(server, { path: "/p/scratch/queue" });
				const page = view.page;
				await page.setViewportSize({ width: 1280, height: 800 });
				await page.locator(`[data-proposal-evidence="${proposed.question}"][data-proposal-loaded="true"]`).waitFor();
				// Reading is recorded from scroll events, so let the page record each press before checking it.
				const press = async () => {
					await (via === "key"
						? page.keyboard.press("a")
						: page.getByRole("button", { name: "Accept", exact: false }).click());
					await page.evaluate(
						() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
					);
				};
				const readWhole = () =>
					page
						.locator(`[data-proposal-evidence="${proposed.question}"]`)
						.getAttribute("data-proposal-read")
						.then((read) => read === "ready");
				const atEnd = () =>
					page
						.locator(".queue-evidence")
						.evaluate((area) => area.scrollTop + area.clientHeight >= area.scrollHeight - 2);
				expect(await atEnd()).toBe(false);
				await press();
				expect((await server.api("get", { refs: ["C-2"] }))[0]).toMatchObject({
					title: "Second case",
					state: "active",
				});
				// A jump to the bottom leaves a gap. The next answer returns to the first unread part.
				await page.locator(".queue-evidence").evaluate((area) => {
					area.scrollTop = area.scrollHeight;
				});
				await press();
				expect((await server.api("inbox", { kind: "adopt" })).items.map((q) => q.q)).toEqual([proposed.question ?? ""]);
				expect(await atEnd()).toBe(false);
				for (let i = 0; i < 60 && !(await readWhole()); i++) {
					await press();
					expect((await server.api("inbox", { kind: "adopt" })).items.map((q) => q.q)).toEqual([
						proposed.question ?? "",
					]);
				}
				expect(await readWhole()).toBe(true);
				await press();
				const [adopted] = await eventually(
					() => server.api("get", { refs: ["C-2"] }),
					(rows) => rows[0]?.state === "archived",
				);
				expect(adopted).toMatchObject({ title: "Last renamed case", state: "archived" });
				expect(view.errors).toEqual([]);
			} finally {
				await view?.close();
				await server.stop();
			}
		},
		30000,
	);
}

(browserAvailable ? test : test.skip)(
	"Queue reads every page of a 250-edit proposal before accepting",
	async () => {
		const server = await fixture();
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const { token } = z.object({ token: z.string() }).parse(
				await server.api("admin", {
					do: "token.create",
					actor: "writer",
					kind: "agent",
					can: ["read", "produce"],
					project: "scratch",
				}),
			);
			const proposed = await server.api(
				"propose",
				{
					edits: Array.from({ length: 250 }, (_, i) => ({
						op: "create",
						outline: `Proposed case ${i + 1}`,
					})),
				},
				{ token },
			);
			view = await openPage(server, { path: "/p/scratch/queue" });
			const page = view.page;
			await page
				.locator(`[data-proposal-evidence="${proposed.question}"]`)
				.getByText("Proposed case 250", { exact: true })
				.waitFor();
			await page.locator(`[data-proposal-evidence="${proposed.question}"][data-proposal-loaded="true"]`).waitFor();
			const atEnd = () =>
				page.locator(".queue-evidence").evaluate((area) => area.scrollTop + area.clientHeight >= area.scrollHeight - 2);
			for (let i = 0; i < 150 && !(await atEnd()); i++) {
				await page.keyboard.press("a");
				expect((await server.api("inbox", { kind: "adopt" })).items.map((q) => q.q)).toEqual([proposed.question ?? ""]);
			}
			expect(await atEnd()).toBe(true);
			await page.keyboard.press("a");
			const [last] = await eventually(
				() => server.api("get", { refs: ["C-250"] }).catch(() => []),
				(rows) => rows[0]?.title === "Proposed case 250",
			);
			expect(last).toMatchObject({ title: "Proposed case 250", state: "active" });
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

async function strictEdit(server: Server) {
	const created = await server.api("propose", { edits: [{ op: "create", outline: "Original strict" }] });
	const initial = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === created.question);
	if (!initial) throw new Error("Missing creation question");
	await server.api("decide", {
		q: initial.q,
		onEvidence: initial.evidenceHash,
		answer: { is: "accept" },
		reason: "Establish the original case",
	});
	const proposed = await server.api("propose", {
		edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Changed strict" } }],
	});
	const question = (await server.api("inbox", { kind: "adopt" })).items.find((q) => q.q === proposed.question);
	if (!question) throw new Error("Missing edit question");
	return question;
}

(browserAvailable ? test : test.skip)(
	"a case reason keeps its selected answer and text while other answer controls are disabled",
	async () => {
		const server = await startServer({ preset: "strict", seed: false });
		let view: Awaited<ReturnType<typeof openPage>> | null = null;
		try {
			const question = await strictEdit(server);
			view = await openPage(server, { path: "/p/scratch/suite/c/1" });
			const { page } = view;
			await page.setViewportSize({ width: 1280, height: 800 });
			await page.locator(`[data-proposal-evidence="${question.q}"][data-proposal-read="ready"]`).waitFor();
			await page.getByRole("button", { name: "Accept" }).click();
			const reason = page.locator("#answer-extra");
			await reason.fill("Keep this acceptance reason");
			// Focus outside the input so the keys reach the case bindings, as they do after clicking the card.
			await page.locator(".history-title").click();
			await page.keyboard.press("r");
			await page.keyboard.press("a");
			expect(await reason.inputValue()).toBe("Keep this acceptance reason");
			expect(await page.getByRole("textbox", { name: "Accept: reason required by policy" }).count()).toBe(1);
			for (const label of ["Accept", "Reject"]) {
				const button = page.getByRole("button", { name: label });
				expect(await button.isDisabled()).toBe(true);
				await button.evaluate((element) => {
					if (!(element instanceof HTMLButtonElement)) throw new Error("Expected an answer button");
					element.click();
				});
				expect(await reason.inputValue()).toBe("Keep this acceptance reason");
			}
			const response = page.waitForResponse((reply) => reply.url().endsWith("/decide"));
			await reason.press("Enter");
			await response;
			expect((await server.api("get", { refs: [question.q] }))[0]?.decision).toMatchObject({
				answer: { is: "accept" },
				reason: "Keep this acceptance reason",
			});
			expect(view.errors).toEqual([]);
		} finally {
			await view?.close();
			await server.stop();
		}
	},
	30000,
);

for (const settled of ["accepted elsewhere", "rejected elsewhere", "with a lost reply"] as const)
	(browserAvailable ? test : test.skip)(
		`a case reason closes when its question is settled ${settled}`,
		async () => {
			const server = await startServer({ preset: "strict", seed: false });
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				const question = await strictEdit(server);
				const decision = settled === "rejected elsewhere" ? "reject" : "accept";
				view = await openPage(server, { path: "/p/scratch/suite/c/1" });
				const { page } = view;
				await page.locator(`[data-proposal-evidence="${question.q}"][data-proposal-read="ready"]`).waitFor();
				await page.getByRole("button", { name: decision === "accept" ? "Accept" : "Reject" }).click();
				const reason = page.locator("#answer-extra");
				await reason.fill("This proposal has been reviewed");
				if (settled !== "with a lost reply") {
					await server.api("decide", {
						q: question.q,
						onEvidence: question.evidenceHash,
						answer: { is: decision },
						reason: "Another reviewer settled it",
					});
				} else {
					await page.route("**/decide", async (route) => {
						await route.fetch();
						await held;
						await answer(route, {
							status: 503,
							json: { ok: false, error: { code: "internal", message: "Answer reply lost" } },
						});
					});
					await reason.press("Enter");
				}
				const remaining = await eventually(
					() => reason.count(),
					(count) => count === 0,
				).catch(() => reason.count());
				expect(remaining).toBe(0);
				await page.locator(".question-card").filter({ hasText: question.q }).waitFor();
				expect((await server.api("get", { refs: [question.q] }))[0]?.decision).toMatchObject({
					answer: { is: decision },
				});
				if (settled === "with a lost reply") {
					release();
					await page.locator("#bar").getByText("Answer reply lost", { exact: false }).waitFor();
					expect(await reason.count()).toBe(0);
					await page.locator(".question-card").filter({ hasText: question.q }).waitFor();
				}
				expect(view.errors).toEqual(
					settled === "with a lost reply"
						? ["Failed to load resource: the server responded with a status of 503 (Service Unavailable)"]
						: [],
				);
			} finally {
				release();
				await view?.close();
				await server.stop();
			}
		},
		30000,
	);

for (const failure of ["error", "refusal", "error without a stream update"] as const)
	(browserAvailable ? test : test.skip)(
		`a case answer ${failure} preserves the current timeline and restores its question`,
		async () => {
			const server = await startServer({ preset: "standard", seed: false });
			let view: Awaited<ReturnType<typeof openPage>> | null = null;
			let release = () => {};
			let releaseReads = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const reads = new Promise<void>((resolve) => {
				releaseReads = resolve;
			});
			try {
				await server.api("propose", { edits: [{ op: "create", outline: "Original title" }] });
				const { token } = z.object({ token: z.string() }).parse(
					await server.api("admin", {
						do: "token.create",
						actor: "writer",
						kind: "agent",
						can: ["read", "produce"],
						project: "scratch",
					}),
				);
				const proposed = await server.api(
					"propose",
					{
						edits: [{ op: "edit", case: "C-1", base: 1, body: { title: "Proposed title" } }],
					},
					{ token },
				);
				if (failure === "error without a stream update")
					await server.api("propose", {
						edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "New public precondition" } }],
					});
				view = await openPage(server, { path: "/p/scratch/suite/c/1" });
				const { page } = view;
				await page.locator(`[data-proposal-evidence="${proposed.question}"][data-proposal-read="ready"]`).waitFor();
				await page.route("**/decide", async (route) => {
					await held;
					await answer(
						route,
						failure !== "refusal"
							? { status: 503, json: { ok: false, error: { code: "internal", message: "Held answer failed" } } }
							: {
									json: {
										ok: true,
										result: [
											{
												q: proposed.question,
												status: "forbidden",
												needs: "Held answer refused",
												decision: null,
												effects: null,
												evidence: null,
											},
										],
									},
								},
					);
				});
				const sent = page.waitForRequest((request) => request.url().endsWith("/decide"));
				await page.getByRole("button", { name: "Reject" }).click();
				await sent;
				if (failure !== "error without a stream update")
					await server.api("propose", {
						edits: [{ op: "edit", case: "C-1", base: 1, body: { pre: "New public precondition" } }],
					});
				await page.locator('[data-version="2"]').waitFor({ state: "attached" });
				let rereads = 0;
				await page.route("**/timeline", async (route) => {
					rereads++;
					await reads;
					await route.continue();
				});
				release();
				await page
					.locator("#bar")
					.getByText(failure !== "refusal" ? "Held answer failed" : "Held answer refused", { exact: false })
					.waitFor();
				expect(await page.locator('[data-version="2"]').count()).toBe(1);
				expect(await page.locator(`[data-proposal="${proposed.question}"]`).count()).toBe(1);
				await eventually(
					async () => rereads,
					(count) => count > 0,
				);
				releaseReads();
				await page.locator(`[data-proposal-evidence="${proposed.question}"][data-proposal-read="ready"]`).waitFor();
				expect(await page.locator('[data-version="2"]').count()).toBe(1);
				expect(view.errors).toEqual(
					failure !== "refusal"
						? ["Failed to load resource: the server responded with a status of 503 (Service Unavailable)"]
						: [],
				);
			} finally {
				release();
				releaseReads();
				await view?.close();
				await server.stop();
			}
		},
		30000,
	);
