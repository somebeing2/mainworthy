import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Api } from "../../core/api.ts";
import { PlanInput } from "../../core/ops.ts";
import { ApiError, call } from "../lib/api.ts";
import { invalidateProject, useQueryOp } from "../lib/data.ts";
import { deviceKey, deviceSession, sessionCurrent } from "../lib/device.ts";
import { randomId } from "../lib/ids.ts";
import { navigate, navigationToken, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { KeyCap, Select } from "../ui/index.tsx";

const PendingPlan = PlanInput.extend({ cmd: PlanInput.shape.cmd.unwrap() });
type Submission = { state: "sending" | "uncertain"; input: z.infer<typeof PendingPlan> };

function readPlan(key: string): Submission["input"] | null {
	try {
		const stored = localStorage.getItem(key);
		if (stored === null) return null;
		const parsed = PendingPlan.safeParse(JSON.parse(stored));
		if (parsed.success) return parsed.data;
	} catch {}
	try {
		localStorage.removeItem(key);
	} catch {}
	return null;
}

export function RunPlanner({ close }: { close: () => void }) {
	const { project, setStatus } = useApp();
	const owner = useRef(deviceSession()).current;
	const key = deviceKey("run-plan", project, owner.actorId);
	const [initial] = useState(() => readPlan(key));
	const [name, setName] = useState(initial?.name ?? "");
	const [mode, setMode] = useState<"all" | "folder" | "tag" | "text">(
		initial?.select.folders?.length
			? "folder"
			: initial?.select.tags?.length
				? "tag"
				: initial?.select.text
					? "text"
					: "all",
	);
	const [filter, setFilter] = useState(
		(typeof initial?.select.folders?.[0] === "string" ? initial.select.folders[0] : undefined) ??
			initial?.select.tags?.[0] ??
			initial?.select.text ??
			"",
	);
	const [query, setQuery] = useState(filter);
	const acceptedCommit = initial?.accepts && "commit" in initial.accepts ? initial.accepts.commit : "";
	const [target, setTarget] = useState<"self" | "commit">(acceptedCommit ? "commit" : "self");
	const [commit, setCommit] = useState(acceptedCommit);
	const [submission, setSubmission] = useState<Submission | null>(
		initial ? { state: "uncertain", input: initial } : null,
	);
	const submitting = useRef(submission);
	const hold = (next: Submission | null) => {
		submitting.current = next;
		setSubmission(next);
	};
	const busy = submission?.state === "sending";
	const nameRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		nameRef.current?.focus();
	}, []);
	useEffect(() => {
		const timer = setTimeout(() => setQuery(filter), 80);
		return () => clearTimeout(timer);
	}, [filter]);
	const folders = useQueryOp({ project, op: "find", input: { in: "folders" } });
	const parsedFolders = z.array(z.object({ path: z.string() })).safeParse(folders.data?.items);
	const selection = (value: string): Api["plan"]["input"]["select"] =>
		mode === "folder" && value
			? { folders: [value] }
			: mode === "tag" && value
				? { tags: [value.replace(/^#/, "")] }
				: mode === "text" && value
					? { text: value }
					: {};
	const found = useQueryOp({
		project,
		op: "find",
		input: {
			in: "cases",
			select: selection(query),
			limit: 1,
		},
	});
	return (
		<form
			className="run-planner"
			onSubmit={(event) => {
				event.preventDefault();
				if (
					!name.trim() ||
					submitting.current?.state === "sending" ||
					(target === "commit" && commit.trim().length < 7)
				)
					return;
				if (!sessionCurrent(owner)) return;
				let input: Submission["input"];
				try {
					const previous = submitting.current?.input ?? readPlan(key);
					if (!submitting.current && previous) {
						setStatus("Another tab's plan is waiting; Retry plan sends it.");
						setName(previous.name);
						setMode(
							previous.select.folders?.length
								? "folder"
								: previous.select.tags?.length
									? "tag"
									: previous.select.text
										? "text"
										: "all",
						);
						const filter =
							(typeof previous.select.folders?.[0] === "string" ? previous.select.folders[0] : undefined) ??
							previous.select.tags?.[0] ??
							previous.select.text ??
							"";
						setFilter(filter);
						setQuery(filter);
						const commit = previous.accepts && "commit" in previous.accepts ? previous.accepts.commit : "";
						setTarget(commit ? "commit" : "self");
						setCommit(commit);
						hold({ state: "uncertain", input: previous });
						return;
					}
					input = previous ?? {
						name: name.trim(),
						select: selection(filter),
						...(target === "commit" ? { accepts: { commit: commit.trim() } } : {}),
						cmd: randomId(),
					};
					localStorage.setItem(key, JSON.stringify(input));
				} catch {
					setStatus("This browser could not keep the plan request. Enable device storage before planning a run.");
					return;
				}
				const forget = () => {
					if (!sessionCurrent(owner)) return;
					try {
						if (readPlan(key)?.cmd === input.cmd) localStorage.removeItem(key);
					} catch {}
				};
				event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
				hold({ state: "sending", input });
				const navigation = navigationToken();
				void call("plan", input, { project, owner })
					.then((reply) => {
						forget();
						setStatus(`${reply.run} planned with ${reply.slots} slots; ${reply.already} already filled.`);
						void invalidateProject(project);
						navigate(routeUrl({ project, screen: "runs", ref: reply.run }), { ifCurrent: navigation });
					})
					.catch((error: unknown) => {
						const refused =
							error instanceof ApiError &&
							error.status !== null &&
							(error.code === "invalid" ||
								error.code === "conflict" ||
								(error.code === "not_found" &&
									error.message !== `no project named ${project}, or no grant on it` &&
									error.message !== "no operation named plan" &&
									error.message !== "no such route"));
						if (refused) forget();
						if (!sessionCurrent(owner)) return;
						hold(refused ? null : { state: "uncertain", input });
						setStatus(
							refused
								? error.message
								: "The run's outcome is unknown. Retry plan sends the same request; your submitted choices are kept.",
						);
					});
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					close();
				}
			}}
		>
			{submission?.state === "uncertain" && (
				<p className="dim" role="status">
					A plan's outcome is unknown. Retry plan sends the same request. Closing the planner keeps it on this device.
					This plan may already have been recorded. Discarding it does not undo a run.
				</p>
			)}
			<label htmlFor="run-name">Run name</label>
			<input
				className="form-input"
				id="run-name"
				ref={nameRef}
				value={name}
				readOnly={submission !== null}
				onChange={(event) => setName(event.target.value)}
				placeholder="Regression for 1.4 rc3"
				required
				maxLength={200}
			/>
			<label htmlFor="run-selection">Cases</label>
			<Select
				className="form-input"
				id="run-selection"
				value={mode}
				disabled={submission !== null}
				onChange={(event) => {
					const value = z.enum(["all", "folder", "tag", "text"]).parse(event.target.value);
					setMode(value);
					setFilter("");
				}}
			>
				<option value="all">All active cases</option>
				<option value="folder">By folder</option>
				<option value="tag">By tag</option>
				<option value="text">By search</option>
			</Select>
			{mode === "folder" ? (
				<Select
					className="form-input"
					aria-label="Folder"
					value={filter}
					disabled={submission !== null}
					onChange={(event) => {
						setFilter(event.target.value);
					}}
				>
					<option value="">All folders</option>
					{parsedFolders.success &&
						parsedFolders.data.map((folder) => (
							<option key={folder.path} value={folder.path}>
								{folder.path || "Root"}
							</option>
						))}
				</Select>
			) : (
				mode !== "all" && (
					<input
						className="form-input"
						aria-label={mode === "tag" ? "Tag" : "Search cases"}
						value={filter}
						readOnly={submission !== null}
						onChange={(event) => setFilter(event.target.value)}
						placeholder={mode === "tag" ? "regression" : "checkout"}
					/>
				)
			)}
			<div className="dim" role="status">
				{found.error ? found.error.message : `${found.data?.count ?? 0} matching cases`}
			</div>
			<label className="run-radio">
				<input
					type="radio"
					name="run-target"
					checked={target === "self"}
					disabled={submission !== null}
					onChange={() => setTarget("self")}
				/>{" "}
				Count only results recorded in this run
			</label>
			<label className="run-radio">
				<input
					type="radio"
					name="run-target"
					checked={target === "commit"}
					disabled={submission !== null}
					onChange={() => setTarget("commit")}
				/>{" "}
				Accept results for a commit
			</label>
			{target === "commit" && (
				<input
					className="form-input"
					aria-label="Commit"
					value={commit}
					readOnly={submission !== null}
					onChange={(event) => setCommit(event.target.value)}
					minLength={7}
					required
					placeholder="Commit SHA"
				/>
			)}
			<button type="submit" className="out" aria-disabled={busy || !name.trim()}>
				<KeyCap>Enter</KeyCap> {submission?.state === "uncertain" ? "Retry plan" : "Plan run"}
			</button>
			{submission?.state === "uncertain" && (
				<button
					type="button"
					className="dim"
					onClick={() => {
						if (!sessionCurrent(owner)) return;
						try {
							if (readPlan(key)?.cmd === submission.input.cmd) localStorage.removeItem(key);
						} catch {
							setStatus("This browser could not discard the saved plan. Enable device storage and try again.");
							return;
						}
						hold(null);
						setStatus("The saved plan was discarded. Any run already recorded is unchanged.");
						nameRef.current?.focus();
					}}
				>
					Discard this plan
				</button>
			)}
			<button type="button" className="dim" onClick={close}>
				Cancel <KeyCap>Esc</KeyCap>
			</button>
		</form>
	);
}
