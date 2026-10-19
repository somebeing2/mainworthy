// The project's policy: a versioned clause table. Owns the table `policies`.
// Reading is open to every module; the only writer is the effect of an `adopt` decision (see suite/adopt).
import { type Ask, type Clause, clauseOf, type Facts, Policy, type Unlinked } from "../../core/kinds.ts";
import { PRESETS, type PresetName, policyProblem, presetOf, storedPolicy } from "../../core/presets.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, sql } from "../kernel/db.ts";
import { invalid } from "../kernel/errors.ts";
import { decisionOf, type Witness } from "../kernel/witness.ts";

type PolicyRow = { project: number; version: number; preset: string; clauses: string; settings: string };

const Q = {
	current: sql<{ project: number }, PolicyRow>(
		"SELECT project, version, preset, clauses, settings FROM policies WHERE project = $project ORDER BY version DESC LIMIT 1",
	),
	at: sql<{ project: number; version: number }, PolicyRow>(
		"SELECT project, version, preset, clauses, settings FROM policies WHERE project = $project AND version = $version",
	),
	insert: sql<{
		project: number;
		version: number;
		preset: string;
		clauses: string;
		settings: string;
		actor: number;
		decision: number | null;
		at: number;
		seq: number;
	}>(
		`INSERT INTO policies (project, version, preset, clauses, settings, actor, decision, at, seq)
		 VALUES ($project, $version, $preset, $clauses, $settings, $actor, $decision, $at, $seq)`,
	),
};

export type CurrentPolicy = Policy & { version: number };

const read = (row: PolicyRow): CurrentPolicy => ({ version: row.version, ...storedPolicy(row) });

export function currentPolicy(db: Db, project: number): CurrentPolicy {
	const row = db.get(Q.current, { project });
	if (!row) throw new Error(`project ${project} has no policy`);
	return read(row);
}

/** The policy as it was at one version, or null: what a decision's signature says it was given under. */
export function policyAt(db: Db, project: number, version: number): CurrentPolicy | null {
	const row = db.get(Q.at, { project, version });
	return row ? read(row) : null;
}

/**
 * What a policy is called where only its name is shown (the project list, the session, the banner): its preset
 * while it has that preset's clauses, otherwise `custom`. The stored name can outlive its clauses.
 */
export const policyName = (policy: Pick<Policy, "preset" | "clauses">): string => presetOf(policy) ?? "custom";

/**
 * What a project list says of a policy without its clauses: the name, and what happens to a test with no case,
 * which a project's admin may change and so must be able to read.
 */
export const policySummary = (policy: Policy): { policy: string; unlinked: Unlinked } => ({
	policy: policyName(policy),
	unlinked: policy.settings.unlinked,
});

/** The owning clause, or combined review requirements when a refused replay has several possible matches. */
export function clauseFor(policy: Policy, facts: Facts): Clause {
	if (facts.kind === "adopt" && facts.facts.has("quarantine"))
		return {
			id: "quarantine-person",
			kind: "adopt",
			when: ["always"],
			blocks: "nothing",
			ask: { who: "member", agents: "advise", notProducer: false, reason: "required" },
		};
	const clause = clauseOf(policy, facts);
	if (!clause) throw new Error(`policy ${policy.preset} has no clause for a ${facts.kind} question`);
	if (!facts.facts.has("replay:refused") || facts.kind !== "adopt") return clause;
	// Scope facts cover every resolution, but their union can select an earlier, looser clause. Combine every
	// possible match until a match independent of those scopes makes all later clauses unreachable.
	const ask: Ask = { ...clause.ask, who: clause.ask.who === "rule" ? "member" : clause.ask.who, agents: "none" };
	for (const candidate of policy.clauses) {
		if (!clauseOf({ clauses: [candidate], settings: policy.settings }, facts)) continue;
		const who = candidate.ask.who === "rule" ? "member" : candidate.ask.who;
		if (ask.who !== who) {
			if (ask.who === "member" && who.startsWith("role:")) ask.who = who;
			else if (!(who === "member" && ask.who.startsWith("role:"))) ask.who = "admin";
		}
		ask.notProducer ||= candidate.ask.notProducer;
		if (candidate.ask.reason === "required") ask.reason = "required";
		if (candidate.when.every((predicate) => !predicate.startsWith("folder:") && !predicate.startsWith("tag:"))) break;
	}
	return { id: "refused-replay", kind: "adopt", when: ["always"], blocks: clause.blocks, ask };
}

export const isPreset = (name: string): name is PresetName => name in PRESETS;

/** Builds the policy an edit asks for and refuses one that would leave a kind of question unowned. */
export function resolvePolicy(
	current: Policy,
	change: {
		preset?: string | undefined;
		clauses?: Clause[] | undefined;
		settings?: Policy["settings"] | undefined;
		unlinked?: Unlinked | undefined;
		emptyReports?: Policy["settings"]["emptyReports"] | undefined;
	},
): Policy {
	let next: Policy = current;
	if (change.preset !== undefined) {
		if (!isPreset(change.preset))
			throw invalid(`unknown preset ${change.preset}; one of ${Object.keys(PRESETS).join(", ")}`);
		next = {
			...PRESETS[change.preset],
			settings: {
				...PRESETS[change.preset].settings,
				...(current.settings.fields ? { fields: current.settings.fields } : {}),
			},
		};
	}
	if (change.clauses !== undefined) next = { ...next, preset: change.preset ?? "custom", clauses: change.clauses };
	if (change.settings !== undefined)
		next = {
			...next,
			settings: {
				...(current.settings.fields ? { fields: current.settings.fields } : {}),
				...change.settings,
			},
		};
	if (change.unlinked !== undefined) next = { ...next, settings: { ...next.settings, unlinked: change.unlinked } };
	if (change.emptyReports !== undefined)
		next = { ...next, settings: { ...next.settings, emptyReports: change.emptyReports } };
	const parsed = Policy.safeParse(next);
	if (!parsed.success) throw invalid("policy is not valid", { issues: parsed.error.issues });
	const problem = policyProblem(parsed.data);
	if (problem) throw invalid(problem);
	return parsed.data;
}

/** The first policy of a new project. Not a decision: there is no earlier standing to change. */
export function seedPolicy(ctx: Ctx, preset: PresetName, unlinked?: Unlinked): void {
	const policy = resolvePolicy(PRESETS[preset], { unlinked });
	ctx.db.run(Q.insert, {
		project: ctx.project.id,
		version: 1,
		preset: policy.preset,
		clauses: JSON.stringify(policy.clauses),
		settings: JSON.stringify(policy.settings),
		actor: ctx.actor.id,
		decision: null,
		at: ctx.now,
		seq: ctx.seq,
	});
}

/**
 * Puts a policy in force. Standing: callable only with the witness of the decision that adopted it. A proposal made
 * before this check, or restored from an archive, may hold a policy that is refused today, so it is checked again here.
 */
export function writePolicy(ctx: Ctx, witness: Witness, policy: Policy): number {
	const problem = policyProblem(policy);
	if (problem) throw invalid(problem);
	const version = currentPolicy(ctx.db, ctx.project.id).version + 1;
	ctx.db.run(Q.insert, {
		project: ctx.project.id,
		version,
		preset: policy.preset,
		clauses: JSON.stringify(policy.clauses),
		settings: JSON.stringify(policy.settings),
		actor: witness.signers[0] ?? ctx.actor.id,
		decision: decisionOf(witness, "adopt"),
		at: ctx.now,
		seq: ctx.seq,
	});
	return version;
}
