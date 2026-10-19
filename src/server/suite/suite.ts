// The suite: what should be true. Owns folders, cases, case_tags, case_aliases, versions, placements, proposals,
// search_docs, requirements and covers.
//
// Two steps, always: `seal` turns a set of edits into a proposal (a fact: who wanted what, on which base), and
// `adopt` makes a sealed proposal current. `adopt` takes a Witness, so the head of a case cannot move without a
// decision. Saving a case in a loose project and proposing a change in a strict one are the same two calls.
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { claimHash, versionHash } from "../../core/hash.ts";
import { newStepId } from "../../core/ids.ts";
import type { Policy } from "../../core/kinds.ts";
import { parseCase } from "../../core/markdown.ts";
import { type Conflict, mergeBodies } from "../../core/merge3.ts";
import type { ConflictAddress } from "../../core/model.ts";
import {
	CaseBody,
	type CaseKind,
	cleanPath,
	cleanTag,
	type ExpandedStep,
	emptyBody,
	fieldErrors,
	REQUIREMENT_KEY,
	type Step,
	StepId,
	TAG,
} from "../../core/model.ts";
import { CaseAlias, type CaseStamp, type Edit } from "../../core/ops.ts";
import { parseOutline } from "../../core/outline.ts";
import { clip } from "../../core/text.ts";
import { type Ctx, parseRef, ref } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { conflict, invalid, notFound, OpError } from "../kernel/errors.ts";
import { complete } from "../kernel/steps.ts";
import { decisionOf, type Witness } from "../kernel/witness.ts";
import { currentPolicy, resolvePolicy, writePolicy } from "../policy/policy.ts";

export type CaseRow = {
	id: number;
	kind: CaseKind;
	project: number;
	no: number;
	head: number;
	head_hash: string;
	claim_hash: string;
	title: string;
	methods: string;
	automate: string;
	step_count: number;
	folder: number;
	rank: string;
	tags: string;
	state: "active" | "archived";
	aliases: string;
	created_by: number;
	created_at: number;
	updated_by: number;
	updated_at: number;
	rev: number;
};
export type FolderRow = {
	id: number;
	project: number;
	parent: number | null;
	name: string;
	rank: string;
	state: string;
	rev: number;
};
export type VersionRow = {
	case_id: number;
	no: number;
	parent: number | null;
	body: string;
	hash: string;
	claim_hash: string;
	proposal: number;
	decision: number;
	author: number;
	reason: string | null;
	at: number;
	seq: number;
};
export type ProposalRow = {
	id: number;
	project: number;
	no: number;
	author: number;
	reason: string | null;
	edits: string;
	resolved: string;
	at: number;
	seq: number;
};

/** A body with any field left out or explicitly undefined: what a client sends when it changes part of a case. */
export type PartialBody = { [K in keyof CaseBody]?: CaseBody[K] | undefined };
type FolderTarget = { id: number } | { path: string };
type Placement = { folder: number; rank: string; tags: string[]; state: "active" | "archived" };
type TagChange = { set: string[] | null; add: string[]; remove: string[] };

/** An edit with every ref looked up and every body built: exactly what `adopt` will apply. */
export type Resolved =
	| {
			op: "create";
			kind: CaseKind;
			body: CaseBody;
			folder: FolderTarget;
			tags: string[];
			covers: string[];
			aliases: string[];
			after: number | null;
	  }
	| {
			op: "edit";
			caseId: number;
			base: number;
			head: number;
			mine: CaseBody;
			body: CaseBody;
			conflicts: Conflict[];
			exact?: boolean;
	  }
	| {
			op: "place";
			caseIds: number[];
			folder: FolderTarget | null;
			after: number | null | undefined;
			/** The change asked for, applied to each case's tags as they are when the proposal is adopted. */
			tags: TagChange | null;
	  }
	| { op: "state"; caseIds: number[]; to: "active" | "archived" }
	| { op: "restore"; caseId: number; to: number; body: CaseBody }
	| { op: "folder"; id: number | null; name: string | null; parent: FolderTarget | null | undefined; archive: boolean }
	| { op: "cover"; caseId: number; key: string; title: string | null; on: boolean }
	| { op: "policy"; base: number; policy: Policy }
	| Extract<Edit, { op: "quarantine" }>;

const Q = {
	caseByNo: sql<{ project: number; no: number }, CaseRow>("SELECT * FROM cases WHERE project = $project AND no = $no"),
	caseById: sql<{ id: number }, CaseRow>("SELECT * FROM cases WHERE id = $id"),
	caseByAlias: sql<{ project: number; alias: string }, CaseRow>(
		"SELECT c.* FROM case_aliases a JOIN cases c ON c.id = a.case_id WHERE a.project = $project AND a.alias = $alias",
	),
	version: sql<{ id: number; no: number }, VersionRow>("SELECT * FROM versions WHERE case_id = $id AND no = $no"),
	folders: sql<{ project: number }, FolderRow>("SELECT * FROM folders WHERE project = $project ORDER BY parent, rank"),
	folderById: sql<{ id: number }, FolderRow>("SELECT * FROM folders WHERE id = $id"),
	folderCaseTags: sql<{ project: number; folder: number }, { tags: string }>(
		"SELECT tags FROM cases WHERE project = $project AND folder = $folder",
	),
	lastFolderRank: sql<{ project: number; parent: number | null }, { rank: string }>(
		"SELECT rank FROM folders WHERE project = $project AND parent IS $parent ORDER BY rank DESC LIMIT 1",
	),
	insertFolder: sql<{ project: number; parent: number | null; name: string; rank: string; rev: number }>(
		"INSERT INTO folders (project, parent, name, rank, rev) VALUES ($project, $parent, $name, $rank, $rev)",
	),
	updateFolder: sql<{ id: number; parent: number | null; name: string; state: string; rev: number }>(
		"UPDATE folders SET parent = $parent, name = $name, state = $state, rev = $rev WHERE id = $id",
	),
	lastRank: sql<{ project: number; folder: number }, { rank: string }>(
		"SELECT rank FROM cases WHERE project = $project AND folder = $folder ORDER BY rank DESC LIMIT 1",
	),
	nextRank: sql<{ project: number; folder: number; rank: string }, { rank: string }>(
		"SELECT rank FROM cases WHERE project = $project AND folder = $folder AND rank > $rank ORDER BY rank LIMIT 1",
	),
	insertCase: sql<{
		kind: CaseKind;
		project: number;
		no: number;
		hash: string;
		claim: string;
		title: string;
		methods: string;
		automate: string;
		steps: number;
		aliases: string;
		folder: number;
		rank: string;
		tags: string;
		actor: number;
		at: number;
		rev: number;
	}>(
		`INSERT INTO cases (kind, project, no, head, head_hash, claim_hash, title, methods, automate, step_count, folder, rank, tags,
		                    aliases, created_by, created_at, updated_by, updated_at, rev)
		 VALUES ($kind, $project, $no, 1, $hash, $claim, $title, $methods, $automate, $steps, $folder, $rank, $tags, $aliases, $actor, $at, $actor, $at, $rev)`,
	),
	insertAlias: sql<{ project: number; alias: string; id: number }>(
		"INSERT INTO case_aliases (project, alias, case_id) VALUES ($project, $alias, $id)",
	),
	moveHead: sql<{
		id: number;
		head: number;
		hash: string;
		claim: string;
		title: string;
		methods: string;
		automate: string;
		steps: number;
		actor: number;
		at: number;
		rev: number;
	}>(
		`UPDATE cases SET head = $head, head_hash = $hash, claim_hash = $claim, title = $title, methods = $methods,
		                  automate = $automate, step_count = $steps, updated_by = $actor, updated_at = $at, rev = $rev
		 WHERE id = $id`,
	),
	place: sql<{
		id: number;
		folder: number;
		rank: string;
		tags: string;
		state: string;
		actor: number;
		at: number;
		rev: number;
	}>(
		`UPDATE cases SET folder = $folder, rank = $rank, tags = $tags, state = $state, updated_by = $actor, updated_at = $at,
		                  rev = $rev WHERE id = $id`,
	),
	insertVersion: sql<{
		id: number;
		no: number;
		parent: number | null;
		body: string;
		hash: string;
		claim: string;
		proposal: number;
		decision: number;
		author: number;
		reason: string | null;
		at: number;
		seq: number;
	}>(
		`INSERT INTO versions (case_id, no, parent, body, hash, claim_hash, proposal, decision, author, reason, at, seq)
		 VALUES ($id, $no, $parent, $body, $hash, $claim, $proposal, $decision, $author, $reason, $at, $seq)`,
	),
	insertPlacement: sql<{
		id: number;
		before: string;
		after: string;
		proposal: number;
		decision: number;
		actor: number;
		at: number;
		seq: number;
	}>(
		`INSERT INTO placements (case_id, before, after, proposal, decision, actor, at, seq)
		 VALUES ($id, $before, $after, $proposal, $decision, $actor, $at, $seq)`,
	),
	clearTags: sql<{ id: number }>("DELETE FROM case_tags WHERE case_id = $id"),
	insertTag: sql<{ project: number; tag: string; id: number }>(
		"INSERT OR IGNORE INTO case_tags (project, tag, case_id) VALUES ($project, $tag, $id)",
	),
	dropDoc: sql<{ id: number }>("DELETE FROM search_docs WHERE rowid = $id"),
	insertDoc: sql<{ id: number; title: string; body: string; tags: string; project: number }>(
		"INSERT INTO search_docs (rowid, title, body, tags, project) VALUES ($id, $title, $body, $tags, $project)",
	),
	insertProposal: sql<{
		project: number;
		no: number;
		author: number;
		reason: string | null;
		edits: string;
		resolved: string;
		at: number;
		seq: number;
	}>(
		`INSERT INTO proposals (project, no, author, reason, edits, resolved, at, seq)
		 VALUES ($project, $no, $author, $reason, $edits, $resolved, $at, $seq)`,
	),
	proposalById: sql<{ id: number }, ProposalRow>("SELECT * FROM proposals WHERE id = $id"),
	proposalByNo: sql<{ project: number; no: number }, ProposalRow>(
		"SELECT * FROM proposals WHERE project = $project AND no = $no",
	),
	requirement: sql<{ project: number; key: string }, { id: number; title: string }>(
		"SELECT id, title FROM requirements WHERE project = $project AND key = $key",
	),
	insertRequirement: sql<{ project: number; key: string; title: string; rev: number }>(
		"INSERT INTO requirements (project, key, title, rev) VALUES ($project, $key, $title, $rev)",
	),
	insertCover: sql<{ requirement: number; id: number; decision: number }>(
		"INSERT OR IGNORE INTO covers (requirement, case_id, decision) VALUES ($requirement, $id, $decision)",
	),
	dropCover: sql<{ requirement: number; id: number }>(
		"DELETE FROM covers WHERE requirement = $requirement AND case_id = $id",
	),
	coversOf: sql<{ id: number }, { key: string }>(
		"SELECT r.key FROM covers c JOIN requirements r ON r.id = c.requirement WHERE c.case_id = $id ORDER BY r.key",
	),
};

// ── Lookups ────────────────────────────────────────────────────────────────────────────────────────────────

export const caseRef = (row: { no: number }): string => ref("case", row.no);

/** A case by `C-311`, by a bare number, or by a foreign alias kept from an import. */
export function findCase(db: Db, project: number, text: string): CaseRow | null {
	const parsed = parseRef(text);
	if (parsed?.name === "case") return db.get(Q.caseByNo, { project, no: parsed.no });
	if (/^\d+$/.test(text.trim())) return db.get(Q.caseByNo, { project, no: Number(text.trim()) });
	return db.get(Q.caseByAlias, { project, alias: text.trim() });
}

export function mustCase(db: Db, project: number, text: string): CaseRow {
	const row = findCase(db, project, text);
	if (!row) throw notFound(`case ${text}`);
	return row;
}

export const caseById = (db: Db, id: number): CaseRow | null => db.get(Q.caseById, { id });

export function versionOf(db: Db, caseId: number, no: number): VersionRow | null {
	return db.get(Q.version, { id: caseId, no });
}

export function bodyOf(db: Db, caseId: number, no: number): CaseBody {
	const row = versionOf(db, caseId, no);
	if (!row) throw notFound(`version ${no}`);
	return json<CaseBody>(row.body);
}

export const coversOf = (db: Db, caseId: number): string[] => db.all(Q.coversOf, { id: caseId }).map((r) => r.key);

export type FolderIndex = {
	byId: Map<number, FolderRow>;
	path: (id: number) => string;
	byPath: Map<string, FolderRow>;
};

/** Every folder of a project with its path. */
export function folderIndex(db: Db, project: number): FolderIndex {
	return indexFolders(db.all(Q.folders, { project }));
}

function indexFolders<T extends Pick<FolderRow, "id" | "parent" | "name">>(rows: readonly T[]) {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const paths = new Map<number, string>();
	const path = (id: number): string => {
		const known = paths.get(id);
		if (known !== undefined) return known;
		const row = byId.get(id);
		if (!row) return "";
		const full = row.parent === null ? row.name : `${path(row.parent)}/${row.name}`;
		paths.set(id, full);
		return full;
	};
	const byPath = new Map<string, T>();
	const ambiguous = new Set<string>();
	for (const row of rows) {
		const key = cleanPath(path(row.id)).join("/").toLowerCase();
		if (byPath.has(key)) ambiguous.add(key);
		byPath.set(key, row);
	}
	return { byId, path, paths, byPath, ambiguous };
}

function folderTarget(index: FolderIndex, target: number | string): FolderTarget {
	if (typeof target === "number") {
		if (!index.byId.has(target)) throw notFound(`folder ${target}`);
		return { id: target };
	}
	const parts = cleanPath(target);
	if (parts.length === 0) throw invalid("a folder path cannot be empty");
	if (parts.some((part) => part.length > 120)) throw invalid("a folder name is at most 120 characters");
	const found = index.byPath.get(parts.join("/").toLowerCase());
	return found ? { id: found.id } : { path: parts.join("/") };
}

/** The folder an adopted edit lands in, creating any part of the path that does not exist yet. */
function ensureFolder(ctx: Ctx, target: FolderTarget): number {
	if ("id" in target) return target.id;
	let parent: number | null = null;
	let walked = "";
	for (const name of cleanPath(target.path)) {
		walked = walked ? `${walked}/${name}` : name;
		const existing = folderIndex(ctx.db, ctx.project.id).byPath.get(walked.toLowerCase());
		if (existing) {
			parent = existing.id;
			continue;
		}
		const last = ctx.db.get(Q.lastFolderRank, { project: ctx.project.id, parent });
		const rank = generateKeyBetween(last?.rank ?? null, null);
		parent = ctx.db.run(Q.insertFolder, { project: ctx.project.id, parent, name, rank, rev: ctx.seq }).lastId;
	}
	if (parent === null) throw invalid("a folder path cannot be empty");
	return parent;
}

/** Where captured cases go when nobody said where. */
export const DEFAULT_FOLDER = "Unsorted";

// ── Building bodies ────────────────────────────────────────────────────────────────────────────────────────

function cleanTags(tags: readonly string[]): string[] {
	const out = new Set<string>();
	for (const raw of tags) {
		const tag = cleanTag(raw);
		if (!tag) continue;
		if (!TAG.test(tag))
			throw invalid(`tag "${raw}": lower case letters, digits and - _ . / only, at most 40 characters`);
		out.add(tag);
	}
	return [...out].sort();
}

function cleanCovers(keys: readonly string[]): string[] {
	const out = new Set<string>();
	for (const raw of keys) {
		const key = raw.trim().replace(/^@/, "").toUpperCase();
		if (!key) continue;
		if (!REQUIREMENT_KEY.test(key)) throw invalid(`requirement "${raw}": expected a key such as WEB-290`);
		out.add(key);
	}
	return [...out].sort();
}

/** What adopting an edit does now: writes `body`, or is refused with the error adopting raises. */
export type Adoption = { body: CaseBody; refused: OpError | null };

/** The policy a proposal's edits are adopted under: the one it sets, if it sets one, or the project's. */
export function adoptionPolicy(db: Db, project: number, edits: readonly Resolved[]): Policy {
	return edits.findLast((edit) => edit.op === "policy")?.policy ?? currentPolicy(db, project);
}

/**
 * What adopting an edit does to its case now. When the case has a newer version than the proposal was made on, the
 * body proposed is merged with it, and a body that would make a new version must meet the policy's field definitions
 * and pin fragments that can be pinned. Adopting checks this for each edit, in order, after the proposal's earlier
 * edits. A waiting proposal is read through it too, each edit against the suite as it is now, so a reader sees each
 * edit applied to its case and what would refuse that edit on its own.
 */
export function adoption(db: Db, row: CaseRow, edit: Extract<Resolved, { op: "edit" }>, policy: Policy): Adoption {
	if (edit.conflicts.length > 0) {
		const refused = conflict(`${caseRef(row)} has an unresolved conflict; its author must resolve it`, {
			addresses: edit.conflicts.map((c) => c.address),
		});
		return { body: edit.body, refused };
	}
	let body: CaseBody;
	if (row.head === edit.head) body = cleanBody(edit.body, edit.body);
	else if (edit.exact)
		return { body: edit.body, refused: conflict(`${caseRef(row)} changed; redo the fragment batch`) };
	else {
		const merge = mergeBodies({
			base: bodyOf(db, row.id, edit.base),
			mine: edit.mine,
			theirs: bodyOf(db, row.id, row.head),
		});
		if (merge.conflicts.length > 0) {
			const refused = conflict(
				`${caseRef(row)} changed after this proposal was made; redo the proposal on version ${row.head}`,
				{ addresses: merge.conflicts.map((c) => c.address) },
			);
			return { body: merge.merged, refused };
		}
		body = cleanBody(merge.merged, merge.merged);
	}
	if (versionHash(body) === row.head_hash) return { body, refused: null };
	const previous = bodyOf(db, row.id, row.head);
	try {
		validateFields(body, policy, previous);
		validateFragments(db, row.project, body, row.kind, previous);
	} catch (error) {
		if (error instanceof OpError) return { body, refused: error };
		throw error;
	}
	return { body, refused: null };
}

/**
 * Makes a body storable: trims text, drops empty steps, gives every step a valid id that is unique in the case,
 * and guarantees at least one method. Ids already on the steps are kept, because results and findings point at them.
 */
export function cleanBody(input: PartialBody, base: CaseBody): CaseBody {
	const taken = new Set<string>();
	const steps: Step[] = [];
	for (const step of input.steps ?? base.steps) {
		if (step.use) {
			let id = step.id;
			if (!StepId.safeParse(id).success || taken.has(id)) id = newStepId(taken);
			taken.add(id);
			steps.push({ id, use: step.use, action: "", expected: null });
			continue;
		}
		const action = step.action.trim();
		const expected = step.expected?.trim() || null;
		if (!action && !expected) continue;
		let id = step.id;
		if (!StepId.safeParse(id).success || taken.has(id)) id = newStepId(taken);
		taken.add(id);
		steps.push({ id, action: action || "(no action)", expected });
	}
	const methods = [...new Set(input.methods ?? base.methods)];
	const body: CaseBody = {
		title: clip((input.title ?? base.title).trim().replace(/\s+/g, " "), 300),
		pre: (input.pre ?? base.pre).trim(),
		steps,
		methods: methods.length > 0 ? methods : ["human"],
		automate: input.automate ?? base.automate,
		fields: input.fields ?? base.fields,
	};
	const parsed = CaseBody.safeParse(body);
	if (!parsed.success) throw invalid("case body is not valid", { issues: parsed.error.issues });
	return parsed.data;
}

function fromMarkdown(md: string, base: CaseBody = emptyBody()): { body: CaseBody; tags: string[]; covers: string[] } {
	const parsed = parseCase(md, { fields: base.fields });
	if (!parsed.ok) throw invalid("the Markdown is not a valid case", { errors: parsed.errors });
	return { body: parsed.doc.body, tags: parsed.doc.tags, covers: parsed.doc.covers };
}

function fromOutline(text: string): { body: PartialBody; tags: string[]; covers: string[] } {
	const outline = parseOutline(text);
	const steps = outline.steps.map((step) => ({ id: "", action: step.action, expected: step.expected }));
	return { body: { title: outline.title ?? "", steps }, tags: outline.tags, covers: outline.covers };
}

export function searchText(db: Db, project: number, body: CaseBody): string {
	return [
		body.pre,
		...expandSteps(db, project, body).map((step) => (step.expected ? `${step.action}\n${step.expected}` : step.action)),
	].join("\n");
}

// ── Seal ───────────────────────────────────────────────────────────────────────────────────────────────────

export type Sealed = {
	proposal: ProposalRow;
	resolved: Resolved[];
	/** Policy facts about this proposal: the author's kind, whether it conflicts, whether it changes the policy. */
	facts: string[];
	conflicts: { case: string; addresses: ConflictAddress[] }[];
	/** Refs of the existing cases the proposal would change. */
	cases: string[];
};

/**
 * Records a set of edits as a sealed proposal, or returns null when the edits change nothing.
 * Every edit of an existing case names the version it was made on. If the case has moved since, the edit is merged
 * field by field with the current version; an edit to the same field on both sides is a conflict that the proposal
 * carries, both sides kept, for its author to resolve (decision 0004).
 */
export function seal(ctx: Ctx, input: { edits: readonly Edit[]; reason: string | undefined }): Sealed | null {
	return complete(sealSteps(ctx, input));
}

// Each loop yields after about 200 case visits. Counters restart between phases, so this is not a shared bound.
const SLICE = 200;

export function* sealSteps(ctx: Ctx, input: Parameters<typeof seal>[1]): Generator<undefined, Sealed | null, void> {
	if (input.edits.some((edit) => edit.op === "quarantine") && (input.edits.length !== 1 || !input.reason?.trim()))
		throw invalid("a quarantine edit stands alone and needs a reason");
	const index = folderIndex(ctx.db, ctx.project.id);
	const resolved: Resolved[] = [];
	const conflicts: Sealed["conflicts"] = [];
	const cases = new Set<string>();
	const aliases = new Set<string>();
	const lookup = (text: string): CaseRow => {
		const row = mustCase(ctx.db, ctx.project.id, text);
		cases.add(caseRef(row));
		return row;
	};

	let work = 0;
	for (const edit of input.edits) {
		if (++work % SLICE === 0) yield;
		switch (edit.op) {
			case "fragment": {
				if (input.edits.length !== 1) throw invalid("a fragment batch must be the only edit");
				const fragment = mustCase(ctx.db, ctx.project.id, edit.fragment);
				if (fragment.kind !== "fragment") throw invalid("the target must be a fragment");
				if (edit.from === edit.to) throw invalid("choose a different fragment version");
				bodyOf(ctx.db, fragment.id, edit.from);
				bodyOf(ctx.db, fragment.id, edit.to);
				const selected = new Set<number>();
				for (const consumer of edit.cases) {
					if (++work % SLICE === 0) yield;
					const row = lookup(consumer.case);
					if (selected.has(row.id)) throw invalid("a fragment batch names each case once");
					selected.add(row.id);
					if (row.head !== consumer.base) throw conflict(`${caseRef(row)} changed; redo the fragment batch`);
					const base = bodyOf(ctx.db, row.id, row.head);
					let changed = false;
					const body = {
						...base,
						steps: base.steps.map((step): Step => {
							if (step.use?.fragment !== caseRef(fragment) || step.use.version !== edit.from) return step;
							changed = true;
							return {
								id: step.id,
								action: "",
								expected: null,
								use: { fragment: caseRef(fragment), version: edit.to },
							};
						}),
					};
					if (!changed) throw conflict(`${caseRef(row)} does not use that fragment version`);
					resolved.push({
						op: "edit",
						caseId: row.id,
						base: row.head,
						head: row.head,
						mine: body,
						body,
						conflicts: [],
						exact: true,
					});
				}
				break;
			}
			case "create": {
				const kind = edit.md !== undefined ? markdownKind(edit.md) : (edit.kind ?? "case");
				if (edit.kind !== undefined && edit.kind !== kind)
					throw invalid("the creation kind must match the Markdown kind");
				const keptAliases = [
					...new Set(
						(edit.aliases ?? []).map((alias) => {
							const parsed = CaseAlias.safeParse(alias);
							if (!parsed.success) throw invalid(`invalid case alias ${JSON.stringify(alias)}`);
							return parsed.data;
						}),
					),
				];
				for (const alias of keptAliases) {
					if (aliases.has(alias) || ctx.db.get(Q.caseByAlias, { project: ctx.project.id, alias }))
						throw conflict(`case alias ${alias} is already in use`);
					aliases.add(alias);
				}
				let built: { body: PartialBody; tags: string[]; covers: string[] } = {
					body: edit.body ?? {},
					tags: [],
					covers: [],
				};
				if (edit.md !== undefined) built = fromMarkdown(edit.md);
				else if (edit.outline !== undefined) built = fromOutline(edit.outline);
				const after = edit.after ? lookup(edit.after) : null;
				const folder = edit.folder ?? (after ? after.folder : DEFAULT_FOLDER);
				resolved.push({
					op: "create",
					kind,
					body: cleanBody(built.body, emptyBody()),
					folder: folderTarget(index, folder),
					tags: cleanTags([...built.tags, ...(edit.tags ?? [])]),
					covers: cleanCovers([...built.covers, ...(edit.covers ?? [])]),
					aliases: keptAliases,
					after: after?.id ?? null,
				});
				break;
			}
			case "edit": {
				const row = lookup(edit.case);
				if (edit.base < 1 || edit.base > row.head) throw invalid(`${caseRef(row)} has no version ${edit.base}`);
				if (edit.md !== undefined && markdownKind(edit.md) !== row.kind) throw invalid("a case kind cannot be changed");
				const base = bodyOf(ctx.db, row.id, edit.base);
				const mine = cleanBody(edit.md !== undefined ? fromMarkdown(edit.md, base).body : (edit.body ?? {}), base);
				const head = edit.base === row.head ? base : bodyOf(ctx.db, row.id, row.head);
				const merge =
					edit.base === row.head ? { merged: mine, conflicts: [] } : mergeBodies({ base, mine, theirs: head });
				if (versionHash(merge.merged) === row.head_hash && merge.conflicts.length === 0) break;
				if (merge.conflicts.length > 0)
					conflicts.push({ case: caseRef(row), addresses: merge.conflicts.map((c) => c.address) });
				resolved.push({
					op: "edit",
					caseId: row.id,
					base: edit.base,
					head: row.head,
					mine,
					body: merge.merged,
					conflicts: merge.conflicts,
				});
				break;
			}
			case "place": {
				const rows: CaseRow[] = [];
				for (const ref of edit.cases) {
					rows.push(lookup(ref));
					if (++work % SLICE === 0) yield;
				}
				const after = edit.after === undefined || edit.after === null ? edit.after : lookup(edit.after).id;
				const tags: TagChange | null = edit.tags
					? {
							set: edit.tags.set ? cleanTags(edit.tags.set) : null,
							add: cleanTags(edit.tags.add ?? []),
							remove: cleanTags(edit.tags.remove ?? []),
						}
					: null;
				resolved.push({
					op: "place",
					caseIds: rows.map((row) => row.id),
					folder: edit.folder === undefined ? null : folderTarget(index, edit.folder),
					after,
					tags,
				});
				break;
			}
			case "state": {
				const rows: CaseRow[] = [];
				for (const ref of edit.cases) {
					const row = lookup(ref);
					if (row.state !== edit.to) rows.push(row);
					if (++work % SLICE === 0) yield;
				}
				if (rows.length > 0) resolved.push({ op: "state", caseIds: rows.map((row) => row.id), to: edit.to });
				break;
			}
			case "restore": {
				const row = lookup(edit.case);
				const version = versionOf(ctx.db, row.id, edit.to);
				if (!version) throw invalid(`${caseRef(row)} has no version ${edit.to}`);
				if (version.hash === row.head_hash) break;
				resolved.push({ op: "restore", caseId: row.id, to: edit.to, body: json<CaseBody>(version.body) });
				break;
			}
			case "folder": {
				let id: number | null = null;
				if (edit.folder !== undefined) {
					const target = folderTarget(index, edit.folder);
					if (!("id" in target)) throw notFound(`folder ${edit.folder}`);
					id = target.id;
				} else if (!edit.name) {
					throw invalid("a new folder needs a name");
				}
				const parent =
					edit.parent === undefined || edit.parent === null ? edit.parent : folderTarget(index, edit.parent);
				if (id !== null && parent && isInside(index, deepestExisting(index, parent), id)) {
					throw invalid("a folder cannot be moved into itself or into a folder inside it");
				}
				const name = edit.name === undefined ? null : cleanPath(edit.name).join("/");
				if (name === "") throw invalid("a folder name cannot be empty");
				resolved.push({ op: "folder", id, name, parent, archive: edit.archive ?? false });
				break;
			}
			case "cover": {
				const row = lookup(edit.case);
				const [key] = cleanCovers([edit.requirement]);
				if (!key) throw invalid("a requirement key is required");
				resolved.push({ op: "cover", caseId: row.id, key, title: edit.title ?? null, on: edit.on });
				break;
			}
			case "quarantine":
				resolved.push(edit);
				break;
			case "policy": {
				if (resolved.some((edit) => edit.op === "policy")) throw invalid("send only one policy edit per proposal");
				const current = currentPolicy(ctx.db, ctx.project.id);
				if (edit.base === undefined && (edit.clauses !== undefined || edit.settings !== undefined))
					throw invalid("a policy edit with clauses or settings needs the policy version it was made on (base)");
				const base = edit.base ?? current.version;
				if (base !== current.version)
					throw conflict(`the policy changed; redo the proposal on version ${current.version}`);
				resolved.push({ op: "policy", base, policy: resolvePolicy(current, edit) });
				break;
			}
			default: {
				const _exhaustive: never = edit;
				throw invalid(`unknown edit ${JSON.stringify(_exhaustive)}`);
			}
		}
	}
	if (resolved.length === 0) return null;
	const policy = resolved.findLast((edit) => edit.op === "policy")?.policy ?? currentPolicy(ctx.db, ctx.project.id);
	for (const edit of resolved) {
		if (++work % SLICE === 0) yield;
		if (edit.op === "create" || edit.op === "edit" || edit.op === "restore") {
			const row = edit.op === "create" ? null : caseById(ctx.db, edit.caseId);
			validateFragments(
				ctx.db,
				ctx.project.id,
				edit.body,
				edit.op === "create" ? edit.kind : (row?.kind ?? "case"),
				row ? bodyOf(ctx.db, row.id, row.head) : undefined,
			);
		}
		if (edit.op === "create" || edit.op === "restore") validateFields(edit.body, policy);
		else if (edit.op === "edit") validateFields(edit.body, policy, bodyOf(ctx.db, edit.caseId, edit.head));
	}

	const folders = yield* projectFoldersSteps(index, resolved);
	if (folders.refusal?.kind === "ambiguous") throw invalid(folders.refusal.message);
	validateFolderPaths(index, folders);
	const facts = [`author:${ctx.actor.kind}`, ...(yield* scopeFactsSteps(ctx.db, ctx.project.id, resolved, folders))];
	if (conflicts.length > 0) facts.push("conflict");
	if (resolved.some((r) => r.op === "policy")) facts.push("policy");
	if (resolved.some((r) => r.op === "quarantine")) facts.push("quarantine");
	const no = ctx.nextNo("proposal");
	const { lastId } = ctx.db.run(Q.insertProposal, {
		project: ctx.project.id,
		no,
		author: ctx.actor.id,
		reason: input.reason ?? null,
		edits: JSON.stringify(input.edits),
		resolved: JSON.stringify(resolved),
		at: ctx.now,
		seq: ctx.seq,
	});
	const proposal = ctx.db.get(Q.proposalById, { id: lastId });
	if (!proposal) throw new Error("proposal was not stored");
	ctx.touched.add(ref("proposal", no));
	return { proposal, resolved, facts, conflicts, cases: [...cases] };
}

function isInside(
	index: { byId: ReadonlyMap<number, Pick<FolderRow, "parent">> },
	folder: number | null,
	ancestor: number,
): boolean {
	const seen = new Set<number>();
	for (let at: number | null = folder; at !== null && !seen.has(at); at = index.byId.get(at)?.parent ?? null) {
		if (at === ancestor) return true;
		seen.add(at);
	}
	return false;
}

type FolderProjection = {
	after: ReturnType<typeof indexFolders<Pick<FolderRow, "id" | "parent" | "name">>>;
	targets: Map<Resolved, number>;
	placed: Map<number, number>;
	touched: Set<number>;
	paths: Set<string>;
	refusal: { kind: "ambiguous" | "self-move"; message: string } | null;
};

/** Replay placement and folder edits in adoption order; new folders have proposal-local negative ids. */
function* projectFoldersSteps(
	index: FolderIndex,
	edits: readonly Resolved[],
): Generator<undefined, FolderProjection, void> {
	const after = indexFolders([...index.byId.values()].map(({ id, parent, name }) => ({ id, parent, name })));
	type Row = Pick<FolderRow, "id" | "parent" | "name">;
	const children = new Map<number | null, Set<number>>();
	const members = new Map<string, Set<number>>();
	const keyOf = (id: number) => cleanPath(after.path(id)).join("/").toLowerCase();
	const addPath = (row: Row) => {
		const key = keyOf(row.id);
		let bucket = members.get(key);
		if (!bucket) {
			bucket = new Set();
			members.set(key, bucket);
		}
		bucket.add(row.id);
		after.byPath.set(key, row);
		if (bucket.size > 1) after.ambiguous.add(key);
	};
	const removePath = (row: Row) => {
		const key = keyOf(row.id);
		const bucket = members.get(key);
		if (!bucket) return;
		bucket.delete(row.id);
		if (bucket.size < 2) after.ambiguous.delete(key);
		if (bucket.size === 0) {
			members.delete(key);
			after.byPath.delete(key);
		} else if (after.byPath.get(key)?.id === row.id) {
			const id = bucket.values().next().value;
			const remaining = id === undefined ? undefined : after.byId.get(id);
			if (remaining) after.byPath.set(key, remaining);
		}
	};
	const addChild = (row: Row) => {
		let bucket = children.get(row.parent);
		if (!bucket) {
			bucket = new Set();
			children.set(row.parent, bucket);
		}
		bucket.add(row.id);
	};
	let work = 0;
	for (const row of after.byId.values()) {
		addChild(row);
		addPath(row);
		if (++work % SLICE === 0) yield;
	}
	const add = (row: Row) => {
		after.byId.set(row.id, row);
		addChild(row);
		addPath(row);
	};
	let nextId = -1;
	const targets = new Map<Resolved, number>();
	const placed = new Map<number, number>();
	const touched = new Set<number>();
	const paths = new Set<string>();
	const refused = (kind: "ambiguous" | "self-move", message: string): FolderProjection => ({
		after,
		targets,
		placed,
		touched,
		paths,
		refusal: { kind, message },
	});
	const ensure = (target: FolderTarget): number | FolderProjection => {
		if ("id" in target) return target.id;
		let parent: number | null = null;
		let walked = "";
		for (const name of cleanPath(target.path)) {
			walked = walked ? `${walked}/${name}` : name;
			if (after.ambiguous.has(walked.toLowerCase()))
				return refused(
					"ambiguous",
					`folder path "${walked}" is ambiguous during the proposal; reorder the folder edits`,
				);
			const existing = after.byPath.get(walked.toLowerCase());
			if (existing) parent = existing.id;
			else {
				const row: Pick<FolderRow, "id" | "parent" | "name"> = { id: nextId--, parent, name };
				add(row);
				parent = row.id;
			}
		}
		if (parent === null) throw invalid("a folder path cannot be empty");
		return parent;
	};
	for (const edit of edits) {
		if (++work % SLICE === 0) yield;
		if (edit.op === "create") {
			const folder = ensure(edit.folder);
			if (typeof folder !== "number") return folder;
			targets.set(edit, folder);
			paths.add(after.path(folder));
		} else if (edit.op === "place" && edit.folder) {
			const folder = ensure(edit.folder);
			if (typeof folder !== "number") return folder;
			targets.set(edit, folder);
			paths.add(after.path(folder));
			for (const id of edit.caseIds) {
				placed.set(id, folder);
				if (++work % SLICE === 0) yield;
			}
		} else if (edit.op === "folder") {
			const parent = edit.parent === undefined ? undefined : edit.parent === null ? null : ensure(edit.parent);
			if (typeof parent === "object" && parent !== null) return parent;
			if (edit.id !== null && parent !== undefined && parent !== null && isInside(after, parent, edit.id)) {
				// An invalid pending proposal must still be readable and rejectable.
				return refused("self-move", "a folder cannot be moved into itself or into a folder inside it");
			}
			if (edit.id === null) {
				const row = { id: nextId--, parent: parent ?? null, name: edit.name ?? "Untitled" };
				add(row);
				touched.add(row.id);
				paths.add(after.path(row.id));
			} else {
				const row = after.byId.get(edit.id);
				if (!row) throw notFound(`folder ${edit.id}`);
				const subtree = [row.id];
				for (const id of subtree) {
					for (const child of children.get(id) ?? []) subtree.push(child);
					touched.add(id);
					paths.add(after.path(id));
					const child = after.byId.get(id);
					if (child) removePath(child);
					if (++work % SLICE === 0) yield;
				}
				const moved = { ...row, parent: parent === undefined ? row.parent : parent, name: edit.name ?? row.name };
				children.get(row.parent)?.delete(row.id);
				after.byId.set(row.id, moved);
				addChild(moved);
				for (const id of subtree) after.paths.delete(id);
				for (const id of subtree) {
					const child = after.byId.get(id);
					if (child) addPath(child);
					paths.add(after.path(id));
					if (++work % SLICE === 0) yield;
				}
			}
		}
	}
	return { after, targets, placed, touched, paths, refusal: null };
}

/** A refused replay keeps every possible name and parent; no candidate is chosen for adoption. */
function* refusedFolderScopesSteps(
	index: FolderIndex,
	edits: readonly Resolved[],
	affected: Set<number>,
): Generator<undefined, Map<number, Set<string>> | null, void> {
	const exhausted = new Error("refused folder scope budget exhausted");
	let remaining = 16_384;
	const spend = () => {
		if (--remaining < 0) throw exhausted;
	};
	try {
		const rows = new Map(
			[...index.byId.values()].map((row) => [
				row.id,
				{
					names: new Set([row.name]),
					parents: new Set([row.parent]),
				},
			]),
		);
		const pathsOf = (id: number, seen = new Set<number>()): Set<string> => {
			spend();
			const paths = new Set<string>();
			const row = rows.get(id);
			if (!row || seen.has(id)) return paths;
			const branch = new Set([...seen, id]);
			for (const parent of row.parents) {
				spend();
				const prefixes = parent === null ? [""] : pathsOf(parent, branch);
				for (const prefix of prefixes)
					for (const name of row.names) {
						spend();
						paths.add(prefix ? `${prefix}/${name}` : name);
					}
			}
			return paths;
		};
		let nextId = -1;
		const ensure = (target: FolderTarget): Set<number> => {
			if ("id" in target) return new Set([target.id]);
			let parents = new Set<number | null>([null]);
			let walked = "";
			for (const name of cleanPath(target.path)) {
				spend();
				walked = walked ? `${walked}/${name}` : name;
				const found = new Set<number>();
				for (const id of rows.keys()) {
					spend();
					if ([...pathsOf(id)].some((path) => cleanPath(path).join("/").toLowerCase() === walked.toLowerCase()))
						found.add(id);
				}
				// A renamed or moved candidate may have freed this child path in another replay.
				const missing = new Set(
					[...parents].filter(
						(parent) =>
							![...found].some((id) => {
								spend();
								const row = rows.get(id);
								return row?.names.size === 1 && row.parents.size === 1 && row.parents.has(parent);
							}),
					),
				);
				for (const parent of missing) {
					spend();
					const id = nextId--;
					rows.set(id, { names: new Set([name]), parents: new Set([parent]) });
					found.add(id);
				}
				parents = found;
			}
			return new Set([...parents].filter((id) => id !== null));
		};
		let work = 0;
		for (const edit of edits) {
			spend();
			if (++work % SLICE === 0) yield;
			if (edit.op === "create" || (edit.op === "place" && edit.folder)) {
				if (edit.folder) for (const id of ensure(edit.folder)) affected.add(id);
			} else if (edit.op === "folder") {
				const parents = edit.parent === undefined ? null : edit.parent === null ? new Set([null]) : ensure(edit.parent);
				if (parents) for (const id of parents) if (id !== null) affected.add(id);
				if (edit.id === null) {
					const id = nextId--;
					rows.set(id, { names: new Set([edit.name ?? "Untitled"]), parents: new Set(parents ?? [null]) });
					affected.add(id);
				} else {
					const row = rows.get(edit.id);
					if (!row) throw notFound(`folder ${edit.id}`);
					if (edit.name !== null) row.names.add(edit.name);
					if (parents) for (const parent of parents) row.parents.add(parent);
					affected.add(edit.id);
				}
			}
		}
		const children = new Map<number, Set<number>>();
		for (const [id, row] of rows) {
			for (const parent of row.parents) {
				spend();
				if (parent === null) continue;
				let bucket = children.get(parent);
				if (!bucket) {
					bucket = new Set();
					children.set(parent, bucket);
				}
				bucket.add(id);
			}
			if (++work % SLICE === 0) yield;
		}
		const scopes = new Map<number, Set<string>>();
		for (const id of affected) {
			spend();
			for (const child of children.get(id) ?? []) affected.add(child);
			scopes.set(id, pathsOf(id));
			if (++work % SLICE === 0) yield;
		}
		return scopes;
	} catch (error) {
		if (error === exhausted) return null;
		throw error;
	}
}

function validateFolderPaths(index: FolderIndex, { after }: FolderProjection): void {
	const paths = new Map<string, number>();
	for (const row of after.byId.values()) {
		const path = cleanPath(after.path(row.id)).join("/");
		const key = path.toLowerCase();
		const previous = paths.get(key);
		if (
			previous !== undefined &&
			(index.path(row.id) !== after.path(row.id) || index.path(previous) !== after.path(previous))
		)
			throw invalid(`folder path "${path}" is already in use; choose another name or parent`);
		paths.set(key, row.id);
	}
}

/** Scopes touched by the whole proposal, before and after its edits, including nested folders. */
export function scopeFacts(db: Db, project: number, edits: readonly Resolved[]): string[] {
	return complete(scopeFactsSteps(db, project, edits));
}

export function* scopeFactsSteps(
	db: Db,
	project: number,
	edits: readonly Resolved[],
	projection?: FolderProjection,
): Generator<undefined, string[], void> {
	const index = folderIndex(db, project);
	const { after, targets, placed, touched, paths, refusal } = projection ?? (yield* projectFoldersSteps(index, edits));
	const facts = new Set<string>();
	if (refusal) facts.add("replay:refused");
	if (refusal?.kind === "ambiguous") facts.add(`refused:${refusal.message}`);
	const folder = (path: string) => {
		const parts = cleanPath(path.toLowerCase());
		for (let n = 1; n <= parts.length; n++) facts.add(`folder:${parts.slice(0, n).join("/")}`);
	};
	for (const path of paths) folder(path);
	const targetPath = (target: FolderTarget) => ("id" in target ? index.path(target.id) : target.path);
	const tags = (values: readonly string[]) => {
		for (const tag of values) facts.add(`tag:${cleanTag(tag)}`);
	};
	const referencedFolders = new Set<number>();
	const existing = (id: number) => {
		const row = caseById(db, id);
		if (!row) throw notFound(`case ${id}`);
		referencedFolders.add(row.folder);
		folder(index.path(row.folder));
		folder(after.path(placed.get(id) ?? row.folder));
		tags(json<string[]>(row.tags));
	};
	let work = 0;
	for (const row of after.byId.values()) {
		if (++work % SLICE === 0) yield;
		const before = index.path(row.id);
		const next = after.path(row.id);
		if (before === next && !touched.has(row.id)) continue;
		folder(before);
		folder(next);
		if (index.byId.has(row.id))
			for (const rowWithTags of db.all(Q.folderCaseTags, { project, folder: row.id }))
				tags(json<string[]>(rowWithTags.tags));
	}
	for (const edit of edits) {
		if (++work % SLICE === 0) yield;
		const target = targets.get(edit);
		if (target !== undefined) folder(after.path(target));
		switch (edit.op) {
			case "create":
				folder(targetPath(edit.folder));
				tags(edit.tags);
				break;
			case "edit":
			case "restore":
			case "cover":
				existing(edit.caseId);
				break;
			case "place":
				if (edit.folder) folder(targetPath(edit.folder));
				if (edit.tags) tags([...(edit.tags.set ?? []), ...edit.tags.add]);
				for (const id of edit.caseIds) {
					existing(id);
					if (++work % SLICE === 0) yield;
				}
				break;
			case "state":
				for (const id of edit.caseIds) {
					existing(id);
					if (++work % SLICE === 0) yield;
				}
				break;
			case "folder":
			case "policy":
			case "quarantine":
				break;
			default: {
				const _exhaustive: never = edit;
				return _exhaustive;
			}
		}
	}
	if (refusal) {
		const scopes = yield* refusedFolderScopesSteps(index, edits, referencedFolders);
		if (scopes === null) {
			// The graph can encode exponentially many paths. Include every folder condition in either policy
			// so clauseFor can combine all possible matches without enumerating those paths.
			for (const policy of [currentPolicy(db, project), adoptionPolicy(db, project, edits)])
				for (const clause of policy.clauses)
					for (const predicate of clause.when) if (predicate.startsWith("folder:")) folder(predicate.slice(7));
			for (const row of index.byId.values()) {
				folder(index.path(row.id));
				for (const tagged of db.all(Q.folderCaseTags, { project, folder: row.id })) tags(json<string[]>(tagged.tags));
				yield;
			}
		} else {
			for (const [id, paths] of scopes) {
				for (const path of paths) folder(path);
				if (index.byId.has(id))
					for (const row of db.all(Q.folderCaseTags, { project, folder: id })) tags(json<string[]>(row.tags));
				yield;
			}
		}
	}
	return [...facts];
}

/** The folder a target names, or for a path that does not exist yet, the deepest part of it that does. */
function deepestExisting(index: FolderIndex, target: FolderTarget): number | null {
	if ("id" in target) return target.id;
	const parts = cleanPath(target.path);
	for (let length = parts.length; length > 0; length--) {
		const found = index.byPath.get(parts.slice(0, length).join("/").toLowerCase());
		if (found) return found.id;
	}
	return null;
}

export const proposalById = (db: Db, id: number): ProposalRow | null => db.get(Q.proposalById, { id });
export const proposalByNo = (db: Db, project: number, no: number): ProposalRow | null =>
	db.get(Q.proposalByNo, { project, no });
export const resolvedOf = (proposal: ProposalRow): Resolved[] => json<Resolved[]>(proposal.resolved);

// ── Adopt ──────────────────────────────────────────────────────────────────────────────────────────────────

export type Adopted = { cases: CaseStamp[]; created: string[]; policyVersion: number | null };

function validateFields(body: CaseBody, policy: Policy, previous?: CaseBody): void {
	const errors = fieldErrors(body.fields, policy.settings.fields ?? {}, previous?.fields);
	if (errors.length > 0) throw invalid(`case custom fields are not valid: ${errors.join("; ")}`, { errors });
}

/**
 * Makes a sealed proposal current. Standing: callable only with the witness of the decision that accepted it.
 * A proposal that carries a conflict is never adopted: its author resolves it with a new proposal. If a case moved
 * after the proposal was sealed, the edit is merged again; a new conflict stops the adoption (nothing is written)
 * and the proposal must be redone. Tags and folders are applied to the suite as it is now, not as it was sealed.
 */
export function* adoptSteps(ctx: Ctx, witness: Witness, proposal: ProposalRow): Generator<undefined, Adopted, void> {
	decisionOf(witness, "adopt");
	const out: Adopted = { cases: [], created: [], policyVersion: null };
	const author = proposal.author;
	const edits = resolvedOf(proposal);
	const index = folderIndex(ctx.db, ctx.project.id);
	const folders = yield* projectFoldersSteps(index, edits);
	if (folders.refusal) throw invalid(folders.refusal.message);
	validateFolderPaths(index, folders);
	const policy = adoptionPolicy(ctx.db, ctx.project.id, edits);
	const stamp = (row: CaseRow, version: number, hash: string) => {
		ctx.touched.add(caseRef(row));
		out.cases.push({ ref: caseRef(row), version, hash });
	};
	const writeVersion = (row: CaseRow, body: CaseBody, previous?: CaseBody) => {
		validateFields(body, policy, previous);
		validateFragments(ctx.db, ctx.project.id, body, row.kind, previous ?? bodyOf(ctx.db, row.id, row.head));
		const no = row.head + 1;
		const hash = versionHash(body);
		insertVersion(ctx, witness, proposal, row.id, no, row.head, body, hash);
		ctx.db.run(Q.moveHead, {
			id: row.id,
			head: no,
			hash,
			claim: claimHash(body),
			title: body.title,
			methods: JSON.stringify(body.methods),
			automate: body.automate,
			steps: expandSteps(ctx.db, ctx.project.id, body).length,
			actor: author,
			at: ctx.now,
			rev: ctx.seq,
		});
		indexCase(ctx, row.id, body, json<string[]>(row.tags));
		stamp(row, no, hash);
	};
	const mustRow = (id: number): CaseRow => {
		const row = caseById(ctx.db, id);
		if (!row) throw notFound(`case ${id}`);
		return row;
	};

	let work = 0;
	for (const edit of edits) {
		if (++work % SLICE === 0) yield;
		switch (edit.op) {
			case "create": {
				for (const alias of edit.aliases ?? []) {
					if (ctx.db.get(Q.caseByAlias, { project: ctx.project.id, alias }))
						throw conflict(`case alias ${alias} is already in use`);
				}
				validateFields(edit.body, policy);
				validateFragments(ctx.db, ctx.project.id, edit.body, edit.kind ?? "case");
				const folder = ensureFolder(ctx, edit.folder);
				const rank = rankAfter(ctx, folder, edit.after);
				const no = ctx.nextNo("case");
				const hash = versionHash(edit.body);
				const { lastId } = ctx.db.run(Q.insertCase, {
					kind: edit.kind ?? "case",
					project: ctx.project.id,
					no,
					hash,
					claim: claimHash(edit.body),
					title: edit.body.title,
					methods: JSON.stringify(edit.body.methods),
					automate: edit.body.automate,
					steps: expandSteps(ctx.db, ctx.project.id, edit.body).length,
					folder,
					rank,
					tags: JSON.stringify(edit.tags),
					aliases: JSON.stringify(edit.aliases ?? []),
					actor: author,
					at: ctx.now,
					rev: ctx.seq,
				});
				for (const alias of edit.aliases ?? [])
					ctx.db.run(Q.insertAlias, { project: ctx.project.id, alias, id: lastId });
				insertVersion(ctx, witness, proposal, lastId, 1, null, edit.body, hash);
				writeTags(ctx, lastId, edit.tags);
				indexCase(ctx, lastId, edit.body, edit.tags);
				for (const key of edit.covers) setCover(ctx, witness, lastId, key, null, true);
				const created = ref("case", no);
				ctx.touched.add(created);
				out.created.push(created);
				out.cases.push({ ref: created, version: 1, hash });
				break;
			}
			case "edit": {
				const row = mustRow(edit.caseId);
				const { body, refused } = adoption(ctx.db, row, edit, policy);
				if (refused) throw refused;
				if (versionHash(body) !== row.head_hash) writeVersion(row, body, bodyOf(ctx.db, row.id, row.head));
				else stamp(row, row.head, row.head_hash);
				break;
			}
			case "restore": {
				const row = mustRow(edit.caseId);
				if (versionHash(edit.body) !== row.head_hash) writeVersion(row, edit.body);
				break;
			}
			case "place": {
				const folder = edit.folder ? ensureFolder(ctx, edit.folder) : null;
				// A move to another folder or an explicit position re-ranks; a retag alone leaves the order alone.
				const rerank = folder !== null || edit.after !== undefined;
				// Each folder's cases follow one another from where its first one lands. A rank is only an order within
				// its own folder, so cases that stay in different folders keep one cursor each.
				const cursors = new Map<number, string>();
				for (const id of edit.caseIds) {
					if (++work % SLICE === 0) yield;
					const row = mustRow(id);
					const to = folder ?? row.folder;
					let rank = row.rank;
					if (rerank) {
						const cursor = cursors.get(to);
						rank = cursor === undefined ? rankAfter(ctx, to, edit.after ?? null, id) : rankBetween(ctx, to, cursor);
						cursors.set(to, rank);
					}
					const current = json<string[]>(row.tags);
					const remove = new Set(edit.tags?.remove ?? []);
					const tags = edit.tags
						? cleanTags(edit.tags.set ?? [...current, ...edit.tags.add]).filter((tag) => !remove.has(tag))
						: current;
					place(ctx, witness, proposal, row, { folder: to, rank, tags, state: row.state });
				}
				break;
			}
			case "state": {
				for (const id of edit.caseIds) {
					if (++work % SLICE === 0) yield;
					const row = mustRow(id);
					place(ctx, witness, proposal, row, {
						folder: row.folder,
						rank: row.rank,
						tags: json<string[]>(row.tags),
						state: edit.to,
					});
				}
				break;
			}
			case "folder": {
				applyFolder(ctx, witness, edit);
				break;
			}
			case "cover": {
				setCover(ctx, witness, edit.caseId, edit.key, edit.title, edit.on);
				ctx.touched.add(caseRef(mustRow(edit.caseId)));
				break;
			}
			case "quarantine":
				throw invalid("quarantine is applied by its decision handler");
			case "policy": {
				const current = currentPolicy(ctx.db, ctx.project.id);
				if (edit.base === undefined)
					throw conflict("this proposal was made before policy versions; redo it on the current policy");
				if (edit.base !== current.version)
					throw conflict(
						`the policy changed after this proposal was made; redo the proposal on version ${current.version}`,
					);
				out.policyVersion = writePolicy(ctx, witness, edit.policy);
				ctx.touched.add("policy");
				break;
			}
			default: {
				const _exhaustive: never = edit;
				throw new Error(`unknown resolved edit ${JSON.stringify(_exhaustive)}`);
			}
		}
	}
	return out;
}

function insertVersion(
	ctx: Ctx,
	witness: Witness,
	proposal: ProposalRow,
	id: number,
	no: number,
	parent: number | null,
	body: CaseBody,
	hash: string,
): void {
	ctx.db.run(Q.insertVersion, {
		id,
		no,
		parent,
		body: JSON.stringify(body),
		hash,
		claim: claimHash(body),
		proposal: proposal.id,
		decision: decisionOf(witness, "adopt"),
		author: proposal.author,
		reason: proposal.reason,
		at: ctx.now,
		seq: ctx.seq,
	});
}

function indexCase(ctx: Ctx, id: number, body: CaseBody, tags: readonly string[]): void {
	ctx.db.run(Q.dropDoc, { id });
	ctx.db.run(Q.insertDoc, {
		id,
		title: body.title,
		body: searchText(ctx.db, ctx.project.id, body),
		tags: tags.join(" "),
		project: ctx.project.id,
	});
}

function writeTags(ctx: Ctx, id: number, tags: readonly string[]): void {
	ctx.db.run(Q.clearTags, { id });
	for (const tag of tags) ctx.db.run(Q.insertTag, { project: ctx.project.id, tag, id });
}

function place(ctx: Ctx, witness: Witness, proposal: ProposalRow, row: CaseRow, to: Placement): void {
	const before: Placement = { folder: row.folder, rank: row.rank, tags: json<string[]>(row.tags), state: row.state };
	if (JSON.stringify(before) === JSON.stringify(to)) return;
	ctx.db.run(Q.place, {
		id: row.id,
		folder: to.folder,
		rank: to.rank,
		tags: JSON.stringify(to.tags),
		state: to.state,
		actor: proposal.author,
		at: ctx.now,
		rev: ctx.seq,
	});
	ctx.db.run(Q.insertPlacement, {
		id: row.id,
		before: JSON.stringify(before),
		after: JSON.stringify(to),
		proposal: proposal.id,
		decision: decisionOf(witness, "adopt"),
		actor: proposal.author,
		at: ctx.now,
		seq: ctx.seq,
	});
	if (before.tags.join(" ") !== to.tags.join(" ")) {
		writeTags(ctx, row.id, to.tags);
		indexCase(ctx, row.id, bodyOf(ctx.db, row.id, row.head), to.tags);
	}
	ctx.touched.add(caseRef(row));
}

/** A rank after `after` (a case in that folder), or at the end of the folder when `after` is null. */
function rankAfter(ctx: Ctx, folder: number, after: number | null, moving?: number): string {
	if (after !== null && after !== moving) {
		const anchor = caseById(ctx.db, after);
		if (anchor && anchor.folder === folder) return rankBetween(ctx, folder, anchor.rank);
	}
	const last = ctx.db.get(Q.lastRank, { project: ctx.project.id, folder });
	return generateKeyBetween(last?.rank ?? null, null);
}

function rankBetween(ctx: Ctx, folder: number, after: string): string {
	const next = ctx.db.get(Q.nextRank, { project: ctx.project.id, folder, rank: after });
	return generateKeyBetween(after, next?.rank ?? null);
}

/** Ranks for `n` new cases at the end of a folder, in order. One read, whatever `n` is. */
export function ranksAtEnd(ctx: Ctx, folder: number, n: number): string[] {
	const last = ctx.db.get(Q.lastRank, { project: ctx.project.id, folder });
	return generateNKeysBetween(last?.rank ?? null, null, n);
}

function applyFolder(ctx: Ctx, witness: Witness, edit: Extract<Resolved, { op: "folder" }>): void {
	decisionOf(witness, "adopt");
	const parent = edit.parent === undefined ? undefined : edit.parent === null ? null : ensureFolder(ctx, edit.parent);
	if (edit.id === null) {
		const last = ctx.db.get(Q.lastFolderRank, { project: ctx.project.id, parent: parent ?? null });
		ctx.db.run(Q.insertFolder, {
			project: ctx.project.id,
			parent: parent ?? null,
			name: edit.name ?? "Untitled",
			rank: generateKeyBetween(last?.rank ?? null, null),
			rev: ctx.seq,
		});
	} else {
		const row = ctx.db.get(Q.folderById, { id: edit.id });
		if (!row) throw notFound(`folder ${edit.id}`);
		ctx.db.run(Q.updateFolder, {
			id: row.id,
			parent: parent === undefined ? row.parent : parent,
			name: edit.name ?? row.name,
			state: edit.archive ? "archived" : row.state,
			rev: ctx.seq,
		});
	}
	ctx.touched.add("folders");
}

function setCover(ctx: Ctx, witness: Witness, caseId: number, key: string, title: string | null, on: boolean): void {
	let requirement = ctx.db.get(Q.requirement, { project: ctx.project.id, key });
	if (!requirement) {
		if (!on) return;
		const { lastId } = ctx.db.run(Q.insertRequirement, {
			project: ctx.project.id,
			key,
			title: title ?? "",
			rev: ctx.seq,
		});
		requirement = { id: lastId, title: title ?? "" };
	}
	if (on)
		ctx.db.run(Q.insertCover, { requirement: requirement.id, id: caseId, decision: decisionOf(witness, "adopt") });
	else ctx.db.run(Q.dropCover, { requirement: requirement.id, id: caseId });
}

function markdownKind(md: string): CaseKind {
	const parsed = parseCase(md);
	if (!parsed.ok) throw invalid("the Markdown is not a valid case", { errors: parsed.errors });
	return parsed.doc.kind ?? "case";
}

function validateFragments(db: Db, project: number, body: CaseBody, kind: CaseKind, previous?: CaseBody): void {
	for (const step of body.steps) {
		if (!step.use) continue;
		const pin = step.use;
		if (kind === "fragment") throw invalid("fragments cannot include fragments");
		const target = mustCase(db, project, pin.fragment);
		if (target.kind !== "fragment") throw invalid(`${pin.fragment} is not a fragment`);
		if (
			target.state === "archived" &&
			!previous?.steps.some(
				(part) => part.id === step.id && part.use?.fragment === pin.fragment && part.use.version === pin.version,
			)
		)
			throw invalid(`${pin.fragment} is archived; restore it before adding a pin`);
		const pinned = bodyOf(db, target.id, pin.version);
		if (pinned.steps.some((part) => part.use)) throw invalid("fragments cannot include fragments");
	}
}

/** Concrete steps carry occurrence-qualified ids so two uses of one fragment stay distinct in results. */
export function expandSteps(db: Db, project: number, body: CaseBody): ExpandedStep[] {
	return body.steps.flatMap((step): ExpandedStep[] => {
		if (!step.use) return [{ id: step.id, action: step.action, expected: step.expected }];
		const pin = step.use;
		const target = mustCase(db, project, pin.fragment);
		return bodyOf(db, target.id, pin.version).steps.map((part) => ({
			id: `${step.id}.${part.id}`,
			action: part.action,
			expected: part.expected,
			source: { ...pin, step: part.id, use: step.id },
		}));
	});
}

/** Uses come from current immutable bodies, including cases that opted to keep an older pin. */
export function fragmentUsers(
	db: Db,
	project: number,
	fragment: string,
): { case: string; base: number; versions: number[] }[] {
	return db
		.allDynamic<{ no: number; head: number; body: string }>(
			`SELECT c.no, c.head, v.body FROM cases c JOIN versions v ON v.case_id = c.id AND v.no = c.head
		 WHERE c.project = ? AND EXISTS (SELECT 1 FROM json_each(v.body, '$.steps') s WHERE json_extract(s.value, '$.use.fragment') = ?) ORDER BY c.no`,
			[project, fragment],
		)
		.map((row) => ({
			case: `C-${row.no}`,
			base: row.head,
			versions: [
				...new Set(
					json<CaseBody>(row.body).steps.flatMap((step) => (step.use?.fragment === fragment ? [step.use.version] : [])),
				),
			],
		}));
}
