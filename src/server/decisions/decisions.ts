// Decisions: the only writer of standing. Questions are raised here, one per cause; answers are checked against
// the policy here; and `settle` is the single place that mints a witness and applies a decision's effect.
//
// Three rules hold everywhere (decision 0008):
// - a detector suggests, a decision excuses: nothing in this file changes standing without a decision row;
// - an answer names the evidence it saw, and an answer on changed evidence is a conflict, not a decision;
// - a decision carries forward only while its hold stands, and is asked again with the old answer shown when not.
import { contentHash } from "../../core/hash.ts";
import {
	type ActorKind,
	ANSWERS,
	type AnyAnswer,
	type Ask,
	applicableAnswers,
	type Blocks,
	describeAsk,
	type Kind,
	standingOf,
} from "../../core/kinds.ts";
import type { DecideReply, QuestionItem } from "../../core/ops.ts";
import { clip } from "../../core/text.ts";
import {
	type ChangeRow,
	changeById,
	excuseFor,
	excuseForResult,
	failedIn,
	mustTarget,
	ownChangeOf,
	resultById,
	scopeEnded,
	scopeOf,
	signatureById,
	type TargetRow,
	testById,
	testRef,
} from "../evidence/evidence.ts";
import { sameCodeEvidence } from "../evidence/flaky.ts";
import { actorLabel, ruleActor } from "../identity/identity.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { type Db, json } from "../kernel/db.ts";
import { conflict, OpError } from "../kernel/errors.ts";
import { complete } from "../kernel/steps.ts";
import { claimMint } from "../kernel/witness.ts";
import { clauseFor, currentPolicy, policyAt } from "../policy/policy.ts";
import {
	type Blocker,
	causeKey,
	changeRunsOf,
	countedTestsOf,
	disputedRuns,
	disputesOf,
	effectiveFillsOf,
	type FailingGroup,
	failsOnBase,
	failsWith,
	inheritanceAffected,
	inheritanceRuns,
	inheritedEvidenceOf,
	newestInScope,
	passesAny,
	passingIn,
	type Retallied,
	type RunRow,
	retally,
	runById,
	runRef,
	runsDependingOn,
	runsShowing,
	shownFailure,
	slotById,
	stillArriving,
	unexplainedIn,
	unexplainedShown,
} from "../runs/runs.ts";
import { caseById, caseRef, proposalById, resolvedOf, scopeFactsSteps } from "../suite/suite.ts";
import { disputeParties, HANDLERS, runsAbout } from "./kinds.ts";
import {
	addQuestionParties,
	alsoAbout,
	answersOf,
	attachEvidence,
	attributedQuestionsOn,
	type DecisionRow,
	decisionById,
	decisionsOf,
	everyQuestionOn,
	type HoldTerm,
	holdEndingById,
	insertAnswer,
	insertDecision,
	insertQuestion,
	latestByFingerprint,
	liveByFingerprint,
	mustQuestion,
	noteCarried,
	openQuestionIds,
	openQuestionsOn,
	type QuestionRow,
	questionById,
	questionRef,
	refsOf,
	type Signer,
	setDecisionEffects,
	setQuestionAsk,
	setQuestionFacts,
	setQuestionState,
} from "./questions.ts";

export type Raise = {
	kind: Kind;
	/** Names the cause. Two raises with the same kind and key are the same question. */
	key: string;
	subject: Record<string, unknown>;
	title: string;
	/** Whose evidence raised it: shown as the producer glyph in the queue. */
	producer: ActorKind;
	/** What the person answering sees. */
	evidence: Record<string, unknown>;
	/** The part of the evidence an answer stands on. When it changes, earlier answers no longer apply. */
	material: unknown;
	/** Policy facts (`scope:change`, `hint:disputed`, `author:agent`, ...). */
	facts: readonly string[];
	/** Things the question is about: `C-311`, `R-4`, `T-12`, `pr:482`. */
	refs: readonly string[];
	/** Runs the question may list as waiting for it, as far as the clause's `blocks` allows. It decides no verdict. */
	runs: readonly Pick<RunRow, "id" | "origin">[];
	/** The target this occurrence was seen on, for decisions that hold for one target only. */
	target?: number;
};

export type Raised =
	| { s: "open"; question: QuestionRow }
	| { s: "attached"; question: QuestionRow }
	| { s: "carried"; question: QuestionRow; decision: DecisionRow }
	| { s: "decided"; question: QuestionRow; decision: DecisionRow; effects: Record<string, unknown> };

/**
 * What is kept as a question's evidence: what the answerer sees, plus the policy facts and the target of the
 * latest occurrence, which answering and holds read back. Built in one place so an occurrence attached to an open
 * question carries them exactly as the first one did.
 */
function stored(r: Raise): Record<string, unknown> {
	return { ...r.evidence, facts: r.facts, ...(r.target !== undefined ? { targetId: r.target } : {}) };
}

/**
 * More raises of one question for one target in one command than any real sequence needs (a handful: the report,
 * the check after each recompute, an answer ended and asked again). Beyond it something is going round.
 */
const RAISE_LIMIT = 50;

/** The one mint of decision witnesses. Claimed here when the module loads; nothing else can claim it. */
const mintWitness = claimMint();

const PRIORITY: Record<Blocks, number> = { all: 3, change: 2, release: 2, nothing: 1 };

/**
 * Where a new question stands in the queue: what it blocks first. Among the questions that block nothing, a
 * test with no case comes last. A proposal or a finding is one judgement somebody is waiting for; a file of
 * tests with no case arrives with every report, so by age alone it would always stand above them, and the
 * owner's rule is that it is worth resolving, only not ahead of anything else (decision 0021).
 */
const priorityOf = (kind: Kind, blocks: Blocks): number =>
	kind === "map" && blocks === "nothing" ? 0 : PRIORITY[blocks];

function blockedRuns(blocks: Blocks, runs: Raise["runs"]): number[] {
	return runs
		.filter(
			(run) =>
				blocks === "all" ||
				(blocks === "change" && run.origin === "change") ||
				(blocks === "release" && run.origin === "planned"),
		)
		.map((run) => run.id);
}

/**
 * The one way a question comes to exist. Looks at what is already asked and decided about this cause and then:
 * nothing: opens a question; a decision that still holds for this occurrence: carries the answer forward (no new
 * question); an open question: attaches the occurrence; otherwise asks again, with the old answer linked. A
 * decision that no longer holds is withdrawn on the way, and every run that rested on it is recomputed. If the
 * policy's clause for the question is a rule, the rule answers at once and the decision is recorded like any
 * other, unless a person withdrew its answer on this evidence or answered against it (`heldOpen`, `overruled`).
 *
 * A cause can have more than one answer in force. One that holds for certain targets (an infrastructure failure
 * in one environment) leaves the cause open elsewhere, where it is asked and answered on its own. So every
 * standing decision about the cause is looked at, never only the newest question's.
 */
export function raise(ctx: Ctx, r: Raise): Raised {
	return complete(raiseSteps(ctx, r));
}

export function* raiseSteps(ctx: Ctx, r: Raise): Generator<undefined, Raised, void> {
	const fingerprint = contentHash({ kind: r.kind, key: r.key });
	// A cause seen in two hundred environments is raised two hundred times in one command, once for each: that
	// is work. The same cause on the same target over and over is a circle.
	const seen = `${fingerprint}|${r.target ?? ""}`;
	const times = (ctx.raised.get(seen) ?? 0) + 1;
	ctx.raised.set(seen, times);
	if (times > RAISE_LIMIT)
		throw new Error(`one command raised the question "${r.title}" ${times} times for one target: stopped`);
	// Two hashes. The basis is what a decision stands on: the cause, without the build, so an answer carries from
	// one commit to the next. The evidence hash is what a person answering must have seen: the basis and the
	// latest build, so an answer prepared before a newer build arrived is a conflict and not a decision about a
	// build its author never saw.
	const basis = contentHash(r.material);
	const hash = seenHash(basis, r.target);
	const latest = latestByFingerprint(ctx.db, ctx.project.id, fingerprint);
	if (!latest) return yield* openSteps(ctx, r, fingerprint, hash, basis, 0, null);
	const occurrence = { hash: basis, target: r.target, facts: r.facts, now: ctx.now };
	const standing = standingOn(ctx, fingerprint).map(({ question, decision }) => ({
		question,
		decision,
		terms: json<HoldTerm[]>(decision.holds),
	}));
	for (const { question, decision, terms } of standing) {
		if (!stillHolds(terms, occurrence)) continue;
		noteCarried(ctx, question, r.refs);
		const parties = (r.evidence as { parties?: number[] }).parties;
		if (parties && parties.length > 0) addQuestionParties(ctx, question, parties);
		return { s: "carried", question, decision };
	}
	// A decision that covers certain targets still stands on those when the cause turns up on another one: the
	// new occurrence is asked about, and what was decided where it was decided is left as it is. Any other way
	// of no longer holding (the evidence changed, the time ran out) withdraws its standing.
	const rested: number[] = [];
	let ended: QuestionRow | null = null;
	for (const { question, decision, terms } of standing) {
		// An answer given for certain targets is judged only by what is reported about those targets. The same
		// cause on another commit says nothing about it: without this, an answer for one commit and a failure on
		// another could undo each other for ever.
		const here = terms.find((term) => term.until === "this-target");
		if (here?.until === "this-target" && (r.target === undefined || !here.targets.includes(r.target))) continue;
		if (stillHolds(terms, occurrence, { anyTarget: true })) continue;
		HANDLERS[question.kind].revert(ctx, question, decision);
		lapse(ctx, question, decision, occurrence.now);
		rested.push(...runsDependingOn(ctx.db, decision.id));
		ended ??= question;
	}
	const joined = openFor(ctx.db, ctx.project.id, fingerprint, r.target);
	let raised: Raised;
	if (joined) {
		const clause = clauseFor(currentPolicy(ctx.db, ctx.project.id), { kind: r.kind, facts: new Set(r.facts) });
		const question = attachEvidence(ctx, joined, {
			title: r.title,
			evidence: stored(r),
			hash,
			basis,
			blocks: blockedRuns(clause.blocks, r.runs),
			refs: r.refs,
		});
		if (clause.ask.who === "rule" && !heldOpen(ctx, question, basis) && !overruled(ctx, question, clause.answer)) {
			setQuestionAsk(ctx, question, clause.ask);
			raised = yield* settleByRuleSteps(ctx, question, clause.id, clause.answer);
		} else raised = { s: "attached", question };
	} else {
		// Asked again. It follows the question whose answer just ended, so that answer's chain runs on through it.
		raised = yield* openSteps(ctx, r, fingerprint, hash, basis, latest.epoch + 1, (ended ?? latest).id);
	}
	// The runs that counted a failure as excused by a decision withdrawn above: an earlier commit of the change,
	// a run planned on it, a run since closed. The question asked in its place names them, and they are recomputed
	// now: none is left reading `passed` on an answer that no longer stands, or blocked with nobody asked.
	if (rested.length > 0 || ctx.recompute.size > 0) {
		const named = rested.flatMap((id) => {
			const run = runById(ctx.db, id);
			return run ? [runRef(run)] : [];
		});
		alsoAbout(ctx, raised.question, named);
		refold(ctx, rested);
	}
	return raised;
}

/** The decisions in force about a cause, newest question first. */
function standingOn(ctx: Ctx, fingerprint: string): { question: QuestionRow; decision: DecisionRow }[] {
	return liveByFingerprint(ctx.db, ctx.project.id, fingerprint).flatMap((question) => {
		const decision =
			question.state === "decided" && question.decision !== null ? decisionById(ctx.db, question.decision) : null;
		return decision ? [{ question, decision }] : [];
	});
}

/**
 * The open question a new occurrence of a cause joins: the one that has already seen this target, else the
 * newest. Usually there is at most one; two when an answer for one environment was withdrawn while the other
 * environment's question is still open.
 */
export function openFor(db: Db, project: number, fingerprint: string, target: number | undefined): QuestionRow | null {
	const opened = liveByFingerprint(db, project, fingerprint).filter((question) => question.state === "open");
	const seenHere =
		target === undefined
			? undefined
			: opened.find((question) => (json<{ targets?: number[] }>(question.evidence).targets ?? []).includes(target));
	return seenHere ?? opened[0] ?? null;
}

/** A failure's cause in a scope: one question asks about it, whichever tests and runs show it. */
const failureFingerprint = (signature: string, scope: string): string =>
	contentHash({ kind: "failure", key: `${signature}|${scope}` });

/** The open question about a failure's cause, which a gate that shows the failure unexplained waits for. */
export const openFailureQuestion = (
	db: Db,
	project: number,
	cause: { signature: string; scope: string; target: number },
): QuestionRow | null => openFor(db, project, failureFingerprint(cause.signature, cause.scope), cause.target);

const seenHash = (basis: string, target: number | undefined): string => contentHash({ basis, target: target ?? null });

/**
 * Records in the ledger that a decision stopped holding (its time ran out, the evidence it stood on changed, or
 * another answer took its place) and that its question was asked again. The row is signed by the rule actor and supersedes the decision; the
 * question then points at it, so the timed sweep does not find the old decision and reopen a question that has
 * already been asked again, and the next answer's chain runs through it.
 */
function lapse(ctx: Ctx, question: QuestionRow, decision: DecisionRow, now: number): DecisionRow {
	const timedOut = json<HoldTerm[]>(decision.holds).some((term) => term.until === "time" && now >= term.at);
	const row = insertDecision(ctx, {
		question,
		answer: { is: timedOut ? "expired" : "outdated" },
		signers: [
			{
				by: ruleActor(ctx.db).id,
				clause: timedOut ? "hold-expired" : "hold-ended",
				policy: currentPolicy(ctx.db, ctx.project.id).version,
				reason: null,
			},
		],
		holds: [],
		supersedes: decision.id,
	});
	setQuestionState(ctx, question, "decided", row.id);
	return row;
}

/**
 * A person withdrew the decision on this question and nothing material has changed since. A rule must not answer
 * it again behind their back: it stays open until a person answers or the evidence moves.
 */
function heldOpen(ctx: Ctx, question: QuestionRow, hash: string): boolean {
	const last = decisionsOf(ctx.db, question.id).at(-1);
	return last !== undefined && json<{ is?: string }>(last.answer).is === "withdrawn" && last.basis === hash;
}

/**
 * A person answered this question, or the one it follows, against what a rule's clause answers. The rule does
 * not take the question back: it was overruled by someone with the right to, so a person is asked the next time
 * too, until a person gives the answer the rule would. (A withdrawal alone is not a refusal: see `heldOpen`.)
 *
 * Overruling takes a rule to overrule. A person who answered while the policy asked people decided what nobody
 * else would: a rule the policy gets later answers the next question. A signature names the clause it was given
 * under and the version of the policy that clause was in, and that version says whether the clause was a rule.
 * The policy in force now does not: a clause can be renamed, or keep its name and become a rule.
 */
function overruled(ctx: Ctx, question: QuestionRow | null, ruleAnswer: unknown): boolean {
	const rule = ruleActor(ctx.db).id;
	const wanted = (ruleAnswer as { is?: string } | undefined)?.is;
	const overRule = (signer: Signer): boolean =>
		signer.by !== rule &&
		(policyAt(ctx.db, ctx.project.id, signer.policy)?.clauses.some(
			(clause) => clause.id === signer.clause && clause.ask.who === "rule",
		) ??
			false);
	const walked = new Set<number>();
	for (let at = question; at && !walked.has(at.id); at = at.prior !== null ? questionById(ctx.db, at.prior) : null) {
		walked.add(at.id);
		const given = decisionsOf(ctx.db, at.id).filter(
			(decision) => !["expired", "outdated", "withdrawn"].includes(json<{ is?: string }>(decision.answer).is ?? ""),
		);
		const last = given.at(-1);
		if (last) {
			return json<Signer[]>(last.signers).some(overRule) && json<{ is?: string }>(last.answer).is !== wanted;
		}
	}
	return false;
}

function* openSteps(
	ctx: Ctx,
	r: Raise,
	fingerprint: string,
	hash: string,
	basis: string,
	epoch: number,
	prior: number | null,
): Generator<undefined, Raised, void> {
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const found = clauseFor(policy, { kind: r.kind, facts: new Set(r.facts) });
	// Where the clause is a rule that a person has overruled on this question, a person is asked.
	const refused =
		found.ask.who === "rule" && prior !== null && overruled(ctx, questionById(ctx.db, prior), found.answer);
	const clause = refused ? { ...found, ask: { ...found.ask, who: "member" as const } } : found;
	const question = insertQuestion(ctx, {
		kind: r.kind,
		subject: r.subject,
		fingerprint,
		epoch,
		prior,
		title: r.title,
		producer: r.producer,
		evidence: stored(r),
		hash,
		basis,
		ask: clause.ask,
		blocks: blockedRuns(clause.blocks, r.runs),
		// Most blocking first, then newest first: one ascending range read is the queue. One command that raises
		// more than 1,000 questions repeats ranks, so the queue is read by rank and id together.
		rank: -(priorityOf(r.kind, clause.blocks) * 1_000_000_000_000 + ctx.seq * 1000 + (ctx.ord() % 1000)),
		refs: r.refs,
	});
	if (clause.ask.who === "rule") return yield* settleByRuleSteps(ctx, question, clause.id, clause.answer);
	return { s: "open", question };
}

function* settleByRuleSteps(
	ctx: Ctx,
	question: QuestionRow,
	clause: string,
	answer: unknown,
): Generator<undefined, Raised, void> {
	const parsed = ANSWERS[question.kind].safeParse(answer);
	if (!parsed.success)
		throw new Error(`clause ${clause} gives an answer that a ${question.kind} question does not accept`);
	const facts = yield* factsNowSteps(ctx.db, question);
	if (answerApplicabilityProblem(question.kind, facts, parsed.data)) {
		setQuestionAsk(ctx, question, { ...json<Ask>(question.ask), who: "member" });
		return { s: "open", question };
	}
	const policy = currentPolicy(ctx.db, ctx.project.id).version;
	const signer: Signer = { by: ruleActor(ctx.db).id, clause, policy, reason: null };
	try {
		const settled = yield* ctx.db.savepointSteps(() => settleSteps(ctx, question, [signer], parsed.data as AnyAnswer));
		return {
			s: "decided",
			question: questionById(ctx.db, question.id) ?? question,
			decision: settled.decision,
			effects: settled.effects,
		};
	} catch (error) {
		// The rule could not apply its answer (a conflict it cannot resolve). The question stays open for a person.
		if (error instanceof OpError) return { s: "open", question };
		throw error;
	}
}

/** Reconcile existing inherited standing and let the new policy answer unlinked tests by rule. */
function* reconsiderPolicySteps(ctx: Ctx): Generator<undefined, number, void> {
	for (const id of inheritanceRuns(ctx.db, ctx.project.id)) ctx.recompute.add(id);
	const policy = currentPolicy(ctx.db, ctx.project.id);
	if (!policy.clauses.some((clause) => clause.kind === "map" && clause.ask.who === "rule")) return 0;
	let taken = 0;
	// Every one of them, by id: answering one changes the queue the loop would be reading.
	for (const id of openQuestionIds(ctx.db, ctx.project.id, "map")) {
		const question = questionById(ctx.db, id);
		if (question?.state !== "open") continue;
		const clause = clauseFor(policy, { kind: "map", facts: factsNow(ctx.db, question) });
		if (clause.ask.who !== "rule") continue;
		if (heldOpen(ctx, question, question.basis) || overruled(ctx, question, clause.answer)) continue;
		setQuestionAsk(ctx, question, clause.ask);
		if ((yield* settleByRuleSteps(ctx, question, clause.id, clause.answer)).s === "decided") taken++;
	}
	return taken;
}

/**
 * Does a decision still cover a new occurrence? It stops as soon as any one of its hold terms ends. With
 * `anyTarget` the target term is left out: the answer is whether it would hold on the targets it does cover.
 */
export function stillHolds(
	terms: readonly HoldTerm[],
	occurrence: { hash: string; target: number | undefined; facts: readonly string[]; now: number },
	options: { anyTarget?: boolean } = {},
): boolean {
	return terms.every((term) => {
		switch (term.until) {
			case "basis-changes":
				return term.basis === occurrence.hash;
			case "this-target":
				return options.anyTarget || (occurrence.target !== undefined && term.targets.includes(occurrence.target));
			case "time":
				return occurrence.now < term.at;
			case "results-named":
				// It covers the results it named and no occurrence reported since. Like a target term, that is not a
				// reason to withdraw it: what it decided about those results stands.
				return options.anyTarget === true;
			default: {
				const _exhaustive: never = term;
				return _exhaustive;
			}
		}
	});
}

// ── Answering ──────────────────────────────────────────────────────────────────────────────────────────────

const reply = (q: QuestionRow, status: DecideReply["status"], more: Partial<DecideReply> = {}): DecideReply => ({
	q: questionRef(q),
	status,
	needs: null,
	decision: null,
	effects: null,
	evidence: null,
	...more,
});

function answerApplicabilityProblem(kind: Kind, facts: ReadonlySet<string>, given: AnyAnswer): string | null {
	if (kind !== "failure" && kind !== "adopt") return null;
	const allowed = applicableAnswers(kind, facts);
	return allowed.includes(given.is)
		? null
		: `one of ${allowed.join(", ")}: \`${given.is}\` does not apply to this ${kind === "adopt" ? "proposal" : "failure"}`;
}

class RefusedReplacement extends Error {
	constructor(readonly reply: DecideReply) {
		super(reply.needs ?? "the cause answer could not be recorded");
	}
}

/**
 * One actor's answer to one question. Policy decides what it is worth: it may settle the question, be recorded as
 * advice, or be refused. The same call at every strictness and from every surface.
 */
export function answer(ctx: Ctx, input: Parameters<typeof answerSteps>[1]): DecideReply {
	return complete(answerSteps(ctx, input));
}

export function* answerSteps(
	ctx: Ctx,
	input: { q: string; onEvidence: string; answer: unknown; reason?: string | undefined; ifOpen?: boolean | undefined },
	mode: "answer" | "replace-inherited" = "answer",
): Generator<undefined, DecideReply, void> {
	const question = mustQuestion(ctx.db, ctx.project.id, input.q);
	if (input.ifOpen && question.state !== "open") {
		return reply(question, "conflict", { needs: "the question is no longer open; read it again before answering" });
	}
	const parsed = ANSWERS[question.kind].safeParse(input.answer);
	if (!parsed.success) {
		const allowed = (ANSWERS[question.kind].options as readonly { shape: { is: { value: string } } }[]).map(
			(o) => o.shape.is.value,
		);
		return reply(question, "invalid", {
			needs: `an answer for a ${question.kind} question: is one of ${allowed.join(", ")}`,
		});
	}
	const given = parsed.data as AnyAnswer;
	if (input.onEvidence !== question.evidence_hash) {
		return reply(question, "conflict", {
			needs: "the evidence changed; read the question again and answer on its current evidence",
			evidence: question.evidence_hash,
		});
	}
	if (question.state === "dissolved") return reply(question, "conflict", { needs: "this question no longer applies" });
	const asked = askedAgain(ctx, question);
	if (asked) return reply(question, "conflict", { needs: asked });
	if (question.state === "decided" && question.decision !== null) {
		const prior = decisionById(ctx.db, question.decision);
		if (
			prior &&
			mode === "answer" &&
			!json<{ perResult?: boolean }>(question.subject).perResult &&
			JSON.stringify(json(prior.answer)) === JSON.stringify(given)
		)
			return reply(question, "already", { decision: prior.id });
	}

	const policy = currentPolicy(ctx.db, ctx.project.id);
	const facts = yield* factsNowSteps(ctx.db, question);
	const problem = answerApplicabilityProblem(question.kind, facts, given);
	if (problem) return reply(question, "invalid", { needs: problem });
	const clause = clauseFor(policy, { kind: question.kind, facts, answer: given.is });
	// The clause that would settle this answer. A rule clause still lets a person overrule it; then the general
	// clause for the kind says who that person must be.
	const ask: Ask = clause.ask.who === "rule" ? { ...clause.ask, who: "member" } : clause.ask;
	const standing = standingOf({
		actor: ctx.actor,
		ask,
		isAuthor: HANDLERS[question.kind].isAuthor(ctx, question),
		// Read from the results, and only where the clause asks: most clauses do not.
		isProducer: ask.notProducer && HANDLERS[question.kind].isProducer(ctx, question),
	});
	if (standing === "forbidden") return reply(question, "forbidden", { needs: describeAsk(ask) });
	if (ask.reason === "required" && !input.reason?.trim()) return reply(question, "invalid", { needs: "a reason" });
	if (standing === "counts") {
		const kept = wouldOverturn(ctx, question, given);
		if (kept)
			return reply(question, "forbidden", {
				needs: `somebody who may settle the dispute ${questionRef(kept)} answers: this answer would take the place of that one. An answer for this build only does not`,
			});
	}

	try {
		if (
			standing === "counts" &&
			question.kind === "failure" &&
			json<{ perResult?: boolean }>(question.subject).perResult
		) {
			return yield* ctx.db.savepointSteps(function* () {
				const withdrawn = undo(ctx, { q: input.q, ifDecision: question.decision ?? undefined, reason: input.reason });
				if (withdrawn.status !== "reopened") throw new RefusedReplacement(withdrawn);
				const subject = json<{ signature: number; scope: string }>(question.subject);
				const signature = signatureById(ctx.db, subject.signature);
				const target = json<{ targetId: number }>(question.evidence).targetId;
				const cause = signature
					? (openFailureQuestion(ctx.db, ctx.project.id, { signature: signature.hash, scope: subject.scope, target }) ??
						standingOn(ctx, failureFingerprint(signature.hash, subject.scope)).find(({ question, decision }) =>
							stillHolds(json<HoldTerm[]>(decision.holds), {
								hash: question.basis,
								target,
								facts: [...factsNow(ctx.db, question)],
								now: ctx.now,
							}),
						)?.question)
					: null;
				if (!cause) throw conflict("this failure no longer has a cause question");
				const replacement = yield* answerSteps(
					ctx,
					{ ...input, q: questionRef(cause), onEvidence: cause.evidence_hash },
					"replace-inherited",
				);
				if (replacement.status !== "decided")
					throw new RefusedReplacement({
						...replacement,
						status: replacement.status === "advised" ? "forbidden" : replacement.status,
					});
				return { ...replacement, q: input.q, effects: { ...replacement.effects, question: replacement.q } };
			});
		}
		insertAnswer(ctx, {
			question: question.id,
			answer: given,
			reason: input.reason ?? null,
			hash: question.evidence_hash,
			counts: standing === "counts",
		});
		if (standing === "advice") {
			ctx.touched.add(questionRef(question));
			return reply(question, "advised", { needs: describeAsk({ ...ask, agents: "none" }) });
		}
		const signer: Signer = {
			by: ctx.actor.id,
			clause: clause.id,
			policy: policy.version,
			reason: input.reason ?? null,
		};
		const settled = yield* ctx.db.savepointSteps(function* () {
			// The facts this answer is given under stay with the question while the answer is in force: an answer
			// given to a dispute is still an answer to a dispute after it has set the disputed result aside, or
			// the run has closed on it, and changing or withdrawing it is held to the same clause.
			if (question.kind === "failure") {
				const kept = json<{ parties?: number[] }>(question.evidence).parties ?? [];
				const parties = facts.has("hint:disputed") ? [...new Set([...kept, ...disputeParties(ctx, question)])] : kept;
				setQuestionFacts(ctx, question, [...facts], parties);
			}
			return yield* settleSteps(ctx, question, [signer], given);
		});
		return reply(question, "decided", { decision: settled.decision.id, effects: settled.effects });
	} catch (error) {
		if (error instanceof RefusedReplacement) return { ...error.reply, q: input.q };
		if (error instanceof OpError)
			return reply(question, error.code === "conflict" ? "conflict" : "invalid", { needs: error.message });
		throw error;
	}
}

/**
 * A question that was asked again after its decision stopped holding is history: the newer question is the one to
 * answer or to undo. Answering the old one would decide the same cause twice. A question that is open, or whose
 * decision is still in force, is answered and undone where it is, even when the cause has since been asked about
 * for another target: that question is about the other target, and its answer is not this one's.
 */
function askedAgain(ctx: Ctx, question: QuestionRow): string | null {
	if (question.state === "open") return null;
	const latest = latestByFingerprint(ctx.db, ctx.project.id, question.fingerprint);
	if (!latest || latest.id === question.id) return null;
	const inForce = liveByFingerprint(ctx.db, ctx.project.id, question.fingerprint).some(
		(live) => live.id === question.id,
	);
	return inForce ? null : `this question was asked again as ${questionRef(latest)}; answer that one`;
}

/**
 * Records a decision and applies its effect. The only caller of any standing writer: it mints the witness.
 * A decision that replaces an earlier one on the same question first withdraws what the earlier one did; the
 * earlier row is never edited, and the new row names it in `supersedes`.
 */
function* settleSteps(
	ctx: Ctx,
	question: QuestionRow,
	signers: Signer[],
	given: AnyAnswer,
): Generator<undefined, { decision: DecisionRow; effects: Record<string, unknown> }, void> {
	const handler = HANDLERS[question.kind];
	let supersedes: number | null = null;
	if (question.state === "decided" && question.decision !== null) {
		const prior = decisionById(ctx.db, question.decision);
		if (prior) {
			handler.revert(ctx, question, prior);
			supersedes = prior.id;
		}
	} else {
		// A reopened question: the new decision follows the last row in its ledger (a withdrawal or an expiry). For
		// a question asked again after its hold ended, it follows the row that says so on the question before it. One
		// asked again because the earlier answer covered other targets supersedes nothing: that answer still stands.
		supersedes = decisionsOf(ctx.db, question.id).at(-1)?.id ?? endedBefore(ctx, question);
	}
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const holds = handler.holds({ question, answer: given, now: ctx.now, policy });
	const byRule = signers.every((signer) => signer.by === ruleActor(ctx.db).id);
	const rested = endReplaced(ctx, question, holds, byRule);
	const decision = insertDecision(ctx, { question, answer: given, signers, holds, supersedes });
	setQuestionState(ctx, question, "decided", decision.id);
	const witness = mintWitness(
		decision.id,
		question.kind,
		signers.map((signer) => signer.by),
		decision.expires_at,
	);
	const effects = yield* handler.effect(ctx, witness, question, given, { raise, raiseSteps, reconsiderPolicySteps });
	setDecisionEffects(ctx, decision.id, effects);
	const about = runsAbout(ctx, question);
	if (Array.isArray(effects.reask) && effects.reask.length > 0) askAgain(ctx, question, effects.reask as number[]);
	about.push(...closeAnswered(ctx, question), ...rested);
	// A cause answer reaches older commits and planned runs the question never named. An inherited answer
	// excuses only its exact results: its named commit and that commit's planned runs are folded by refold.
	if (question.kind === "failure") {
		const subject = json<{ signature?: number; scope?: string; slot?: number; perResult?: boolean }>(question.subject);
		if (
			!subject.perResult &&
			subject.slot === undefined &&
			subject.signature !== undefined &&
			subject.scope !== undefined
		)
			about.push(...runsShowing(ctx.db, ctx.project.id, subject.signature));
	}
	refold(ctx, [...about, ...(supersedes !== null ? runsDependingOn(ctx.db, supersedes) : [])], {
		dissolveStale: json<{ slot?: number }>(question.subject).slot !== undefined,
	});
	return { decision: { ...decision, effects: JSON.stringify(effects) }, effects };
}

/** What a decision covers: the targets it names, every target of the cause's scope, or only the results it named. */
const covers = (holds: readonly HoldTerm[]): readonly number[] | "all" | "results" => {
	if (holds.some((term) => term.until === "results-named")) return "results";
	const here = holds.find((term) => term.until === "this-target");
	return here?.until === "this-target" ? here.targets : "all";
};

/**
 * One answer in force per cause and target. A decision about to be made on this question takes the place of
 * another question's answer when both cover the whole cause, or both name the same target. That other answer is
 * ended here, with a row in the ledger that says so, before the new one is recorded: it is not left listed as
 * standing with its effect overwritten. Returns the runs that rested on it or were about it, to be recomputed.
 */
function endReplaced(ctx: Ctx, question: QuestionRow, holds: readonly HoldTerm[], byRule: boolean): number[] {
	const mine = covers(holds);
	const runs: number[] = [];
	for (const { question: other, decision } of standingOn(ctx, question.fingerprint)) {
		if (other.id === question.id) continue;
		const theirs = covers(json<HoldTerm[]>(decision.holds));
		// A decision about named results takes nobody's place and nobody takes its place. An answer for the whole
		// cause takes the place of every other answer, narrower ones included: it is the newer judgement on each
		// of their targets too. An answer for certain targets takes the place of an answer naming one of them, and
		// leaves an older answer for the whole cause standing for every other target.
		const same =
			mine === "results" || theirs === "results"
				? false
				: mine === "all" || (theirs !== "all" && theirs.some((target) => mine.includes(target)));
		if (!same) continue;
		// The answer to a dispute, when whoever is answering now may not settle that dispute: it is not theirs
		// to replace by answering another question about the cause. An answer for certain targets stays the
		// answer for those targets under their answer for the whole cause; `answer` has refused the rest.
		if (!maySettle(ctx, other, decision, byRule)) {
			if (mine === "all" && theirs !== "all") continue;
			throw conflict(`${questionRef(other)} answers a dispute that this answer may not replace`);
		}
		HANDLERS[other.kind].revert(ctx, other, decision);
		lapse(ctx, other, decision, ctx.now);
		runs.push(...runsDependingOn(ctx.db, decision.id), ...runsAbout(ctx, other));
	}
	return runs;
}

/**
 * May whoever is acting now change the answer in force on this question? Always, unless it is the answer to a
 * dispute and the policy's clause for disputes keeps it from them: a producer of the evidence, a party to the
 * dispute, an agent where the clause wants a person, or a rule. The same test `answer` and `undo` apply to the
 * question itself, asked here about a question whose answer another question's answer would end.
 */
function maySettle(ctx: Ctx, question: QuestionRow, decision: DecisionRow, byRule: boolean): boolean {
	const facts = factsNow(ctx.db, question);
	if (question.kind !== "failure" || !facts.has("hint:disputed")) return true;
	const given = json<{ is?: string }>(decision.answer).is;
	const clause = clauseFor(currentPolicy(ctx.db, ctx.project.id), {
		kind: question.kind,
		facts,
		...(given ? { answer: given } : {}),
	});
	// The whole of what the clause asks, not only whether it shuts out producers: the role it wants, whether an
	// agent may, and who produced the evidence where it says so.
	if (byRule) return clause.ask.who === "rule";
	const handler = HANDLERS[question.kind];
	const ask: Ask = clause.ask.who === "rule" ? { ...clause.ask, who: "member" } : clause.ask;
	const standing = standingOf({
		actor: ctx.actor,
		ask,
		isAuthor: handler.isAuthor(ctx, question),
		isProducer: ask.notProducer && handler.isProducer(ctx, question),
	});
	return standing === "counts";
}

/**
 * The answer to a dispute that this answer would end without its author having the right to settle that
 * dispute, where the two cannot both stand (both for the whole cause, or both naming one target). Null when
 * there is none: `endReplaced` then ends what may be ended and leaves a narrower dispute answer standing.
 */
function wouldOverturn(ctx: Ctx, question: QuestionRow, given: AnyAnswer): QuestionRow | null {
	if (question.kind !== "failure") return null;
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const mine = covers(HANDLERS[question.kind].holds({ question, answer: given, now: ctx.now, policy }));
	if (mine === "results") return null;
	for (const { question: other, decision } of standingOn(ctx, question.fingerprint)) {
		if (other.id === question.id) continue;
		const theirs = covers(json<HoldTerm[]>(decision.holds));
		if (theirs === "results") continue;
		const same = mine === "all" || (theirs !== "all" && theirs.some((target) => mine.includes(target)));
		if (!same || (mine === "all" && theirs !== "all")) continue;
		if (!maySettle(ctx, other, decision, false)) return other;
	}
	return null;
}

/** The row that ended the answer of the question this one was asked after, if it was asked for that reason. */
function endedBefore(ctx: Ctx, question: QuestionRow): number | null {
	const before = question.prior !== null ? questionById(ctx.db, question.prior) : null;
	const last = before?.decision != null ? decisionById(ctx.db, before.decision) : null;
	const is = last ? json<{ is?: string }>(last.answer).is : undefined;
	return last && (is === "expired" || is === "outdated") ? last.id : null;
}

/**
 * Closes the open questions about a cause that have nothing left to ask: every target they had seen the cause on
 * has an answer in force. Called when an answer is given (it may answer a neighbouring question too) and when
 * one is withdrawn or runs out (another answer may still cover what its question asked about). What counts is
 * what the runs count, the excuses in force, whichever question's answer they came from. Nobody is left asked
 * about something that is answered. Returns the runs those questions named, to be recomputed.
 */
function closeAnswered(ctx: Ctx, question: QuestionRow): number[] {
	if (question.kind !== "failure") return [];
	if (json<{ slot?: number }>(question.subject).slot !== undefined) return [];
	const subject = json<{ signature?: number; scope?: string }>(question.subject);
	const { signature, scope } = subject;
	if (signature === undefined || scope === undefined) return [];
	const runs: number[] = [];
	for (const other of liveByFingerprint(ctx.db, ctx.project.id, question.fingerprint)) {
		if (other.state !== "open") continue;
		const seen = json<{ targets?: number[]; targetId?: number }>(other.evidence);
		const targets = seen.targets ?? (seen.targetId !== undefined ? [seen.targetId] : []);
		const covered =
			targets.length > 0 &&
			targets.every((target) => excuseFor(ctx.db, ctx.project.id, signature, scope, target) !== null);
		if (!covered) continue;
		runs.push(...runsAbout(ctx, other));
		setQuestionState(ctx, other, "dissolved", null);
	}
	return runs;
}

/**
 * Opens the question again for targets its decision did not cover. The new question follows the decided one
 * (`prior`) and shows the same evidence, so the person who answered for one environment is asked about the other
 * with their first answer in view. It names the runs that still show the cause unexplained, and no others. A
 * target that another answer in force already covers, or that an open question about this cause already lists,
 * is not asked about a second time.
 */
function askAgain(ctx: Ctx, question: QuestionRow, targets: readonly number[]): void {
	const {
		facts,
		targetId: _decided,
		...shown
	} = json<Record<string, unknown> & { facts?: string[] }>(question.evidence);
	const others = liveByFingerprint(ctx.db, ctx.project.id, question.fingerprint).filter(
		(other) => other.id !== question.id,
	);
	const covered = new Set<number>();
	for (const other of others) {
		if (other.state === "open") {
			for (const target of json<{ targets?: number[] }>(other.evidence).targets ?? []) covered.add(target);
			continue;
		}
		const decision = other.decision !== null ? decisionById(ctx.db, other.decision) : null;
		if (decision === null) continue;
		const terms = json<HoldTerm[]>(decision.holds);
		if (terms.some((term) => term.until === "results-named")) continue;
		if (
			!stillHolds(
				terms,
				{ hash: question.basis, target: undefined, facts: facts ?? [], now: ctx.now },
				{ anyTarget: true },
			)
		)
			continue;
		const targetTerms = terms.filter((term) => term.until === "this-target");
		const first = targetTerms[0];
		if (first === undefined) return;
		const remaining = targetTerms.slice(1).map((term) => new Set(term.targets));
		for (const target of first.targets) {
			if (remaining.every((targets) => targets.has(target))) covered.add(target);
		}
	}
	const pending = targets.filter((target) => !covered.has(target));
	const latest = pending.at(-1);
	if (latest === undefined) return;
	const subject = json<Record<string, unknown> & { signature?: number; scope?: string }>(question.subject);
	const key =
		subject.signature !== undefined && subject.scope !== undefined ? causeKey(subject.signature, subject.scope) : null;
	const runs = runsAbout(ctx, question).flatMap((id) => {
		const run = runById(ctx.db, id);
		return run && (key === null || unexplainedIn(ctx.db, run).has(key)) ? [run] : [];
	});
	const newest = latestByFingerprint(ctx.db, ctx.project.id, question.fingerprint) ?? question;
	complete(
		openSteps(
			ctx,
			{
				kind: question.kind,
				key: "",
				subject,
				title: question.title,
				producer: question.producer,
				evidence: { ...shown, targets: pending },
				material: null,
				facts: facts ?? [],
				refs: [...refsOf(ctx.db, question.id).filter((about) => !/^R-\d+$/.test(about)), ...runs.map(runRef)],
				runs,
				target: latest,
			},
			question.fingerprint,
			seenHash(question.basis, latest),
			question.basis,
			newest.epoch + 1,
			question.id,
		),
	);
}

/**
 * Withdraws the current decision on a question and opens it again. The withdrawal is itself a decision in the
 * ledger, superseding the one it withdraws, so both remain (commitment L6: undo never erases).
 */
export function undo(
	ctx: Ctx,
	input: { q: string; ifDecision: number | undefined; reason: string | undefined },
): DecideReply {
	const question = mustQuestion(ctx.db, ctx.project.id, input.q);
	if (input.ifDecision !== undefined && (question.state !== "decided" || question.decision !== input.ifDecision))
		return reply(question, "conflict", { needs: "the decision changed; read the question again before withdrawing" });
	if (question.state !== "decided" || question.decision === null)
		return reply(question, "invalid", { needs: "a decided question" });
	const asked = askedAgain(ctx, question);
	if (asked) return reply(question, "conflict", { needs: asked });
	const prior = decisionById(ctx.db, question.decision);
	if (!prior) return reply(question, "invalid", { needs: "a decided question" });
	const handler = HANDLERS[question.kind];
	if (!handler.undoable) return reply(question, "invalid", { needs: handler.undoHint });
	// Taking an answer away is held to what giving it was: the clause for that answer says who may (not a producer
	// of the evidence, where it says so) and whether a reason is owed.
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const facts = factsNow(ctx.db, question);
	const given = json<{ is?: string }>(prior.answer).is;
	const clause = clauseFor(policy, { kind: question.kind, facts, ...(given ? { answer: given } : {}) });
	const ask: Ask = clause.ask.who === "rule" ? { ...clause.ask, who: "member" } : clause.ask;
	const standing = standingOf({
		actor: ctx.actor,
		ask,
		isAuthor: handler.isAuthor(ctx, question),
		isProducer: ask.notProducer && handler.isProducer(ctx, question),
	});
	if (standing !== "counts") return reply(question, "forbidden", { needs: describeAsk(ask) });
	if (ask.reason === "required" && !input.reason?.trim()) return reply(question, "invalid", { needs: "a reason" });
	handler.revert(ctx, question, prior);
	const signer: Signer = { by: ctx.actor.id, clause: clause.id, policy: policy.version, reason: input.reason ?? null };
	const decision = insertDecision(ctx, {
		question,
		answer: { is: "withdrawn" },
		signers: [signer],
		holds: [],
		supersedes: prior.id,
	});
	if (question.kind === "failure" && json<{ perResult?: boolean }>(question.subject).perResult) {
		setQuestionState(ctx, question, "dissolved", decision.id);
		refold(ctx, [...runsAbout(ctx, question), ...runsDependingOn(ctx.db, prior.id)]);
		return reply(question, "reopened", {
			decision: decision.id,
			needs: "withdrawn; automatic inheritance is disabled for this commit and cause",
		});
	}
	setQuestionState(ctx, question, "open", null);
	// Open again, it asks what any question of its kind asks. Where that is a rule, a person now decides: the
	// rule does not answer again behind the back of whoever withdrew its answer.
	const general = clauseFor(policy, { kind: question.kind, facts }).ask;
	setQuestionAsk(ctx, question, general.who === "rule" ? { ...general, who: "member" } : general);
	// Another answer may still cover everything this question asked about (an older answer for the whole cause
	// under an answer for one target): then nothing is left to ask, and the question is closed, not left open.
	const closed = closeAnswered(ctx, question);
	refold(ctx, [...runsAbout(ctx, question), ...runsDependingOn(ctx.db, prior.id), ...closed]);
	const covered = questionById(ctx.db, question.id)?.state === "dissolved";
	const ended = !covered && endedUnawaited(ctx, question);
	const gone = !covered && closeIfGone(ctx, question.id);
	return reply(question, "reopened", {
		decision: decision.id,
		...(covered
			? { needs: "withdrawn; another answer in force still covers this failure, so nobody is asked about it" }
			: ended
				? { needs: "withdrawn; the change this failure was on has ended, so nobody is asked about it" }
				: gone
					? { needs: "withdrawn; nothing shows this failure any more, so nobody is asked about it" }
					: {}),
	});
}

// ── Failures ───────────────────────────────────────────────────────────────────────────────────────────────

/** Reconcile inherited standing once for all the causes in a report, before raising their questions. */
export function raiseFailures(ctx: Ctx, inputs: readonly Parameters<typeof raiseFailure>[1][]): Raised[] {
	const active = ctx.folding;
	ctx.folding = true;
	try {
		const runs = new Map(inputs.flatMap(({ group }) => group.runs.map((run) => [run.id, run] as const)));
		const automatic = new Map(
			[...runs.values()]
				.flatMap((run) => refreshInherited(ctx, run))
				.map((raised) => [json<{ signature: number }>(raised.question.subject).signature, raised] as const),
		);
		return inputs.map((input) => raiseFailure(ctx, input, automatic));
	} finally {
		ctx.folding = active;
	}
}

/**
 * Puts one cause of failure to the queue. `by` is the actor whose result shows it, `producer` that actor's kind.
 * Called for the failures of a report as it is applied, and for the failures a run shows when it is planned
 * over evidence that already fails: there is one door, so the question, its carried answer and the runs it
 * reaches are the same either way.
 */
export function raiseFailure(
	ctx: Ctx,
	input: {
		group: FailingGroup;
		target: TargetRow;
		by: number;
		producer: ActorKind;
		/** How many tests the cause is known to have failed, when the group holds only a sample of them. */
		count?: number;
		/** Parties to a dispute about the cause that the caller already knows of (a question asked again elsewhere). */
		parties?: readonly number[];
	},
	automatic: ReadonlyMap<number, Raised> = new Map(),
): Raised {
	const { group, target } = input;
	if (
		automatic.size > 0 &&
		group.results.length > 0 &&
		group.results.every((id) => {
			const row = resultById(ctx.db, id);
			return row && excuseForResult(ctx.db, row, group.scope);
		})
	) {
		const matching = automatic.get(group.signature.id);
		if (matching) return matching;
	}
	const scopeKind = group.scope.startsWith("change:") ? "change" : group.scope.startsWith("line:") ? "trunk" : "run";
	const key = `${group.signature.hash}|${group.scope}`;
	// One question per cause: an occurrence adds its tests to the open question instead of opening another.
	const open = openFailureQuestion(ctx.db, ctx.project.id, {
		signature: group.signature.hash,
		scope: group.scope,
		target: target.id,
	});
	const earlier = open
		? json<{
				tests?: { id: number; t: string; name: string; case: string | null; counted?: boolean }[];
				count?: number;
				message?: string | null;
				sample?: number | null;
				producers?: number[];
				parties?: number[];
				targets?: number[];
			}>(open.evidence)
		: {};
	const tests = new Map((earlier.tests ?? []).map((test) => [test.id, test]));
	for (const test of group.tests) {
		const row = test.case_id !== null ? caseById(ctx.db, test.case_id) : null;
		// `counted`: a commit's gate counted this test failing with the cause (now or in an earlier occurrence).
		// Only such a test's later pass says the failure stopped; see `stoppedFailing`.
		const counted = group.gateTests.includes(test.id) || tests.get(test.id)?.counted === true;
		tests.set(test.id, {
			id: test.id,
			t: testRef(test),
			name: test.name,
			case: row ? caseRef(row) : null,
			...(counted ? { counted: true } : {}),
		});
	}
	// The base hint describes these results; inherited rule answers use their own complete evidence question.
	const shown: string[] = [];
	if (
		scopeKind === "change" &&
		group.results.length > 0 &&
		group.results.every((result) => failsOnBase(ctx.db, result))
	)
		shown.push("hint:fails-on-base");
	const change = target.change !== null ? changeById(ctx.db, target.change) : null;
	const listed = [...tests.values()];
	const detectorSettings = currentPolicy(ctx.db, ctx.project.id).settings.flakyDetection;
	const cases = [...new Set(listed.flatMap((test) => (test.case ? [test.case] : [])))];
	return raise(ctx, {
		kind: "failure",
		key,
		subject: { signature: group.signature.id, scope: group.scope },
		title: clip(group.signature.text, 160),
		producer: input.producer,
		evidence: {
			signature: { class: group.signature.class, text: group.signature.text },
			scope: change ? change.key : group.scope,
			// An occurrence that brings no failing result of its own (a pass that makes the slot a dispute) leaves
			// what the question already shows of the failure.
			message: group.message ?? earlier.message ?? null,
			tests: listed.slice(0, 50).map((test) => {
				const sameCode = sameCodeEvidence(ctx.db, {
					project: ctx.project.id,
					test: test.id,
					now: ctx.now,
					settings: detectorSettings,
				});
				sameCode.signals = sameCode.signals.filter((signal) => signal.signature.id === group.signature.id);
				return { ...test, ...(sameCode.signals.length > 0 ? { sameCode } : {}) };
			}),
			// The list is cut to fifty; the count is not taken from the cut list, so it never falls when a later
			// occurrence adds a test to a question that has seen hundreds.
			count: Math.max(listed.length, earlier.count ?? 0, input.count ?? 0),
			target: target.commit_sha ? target.commit_sha.slice(0, 12) : target.what,
			branch: target.branch,
			hints: shown.map((hint) => hint.slice(5)),
			producers: [...new Set([...(earlier.producers ?? []), input.by])],
			parties: [],
			// Every target this question has seen the cause on. An answer that holds "here only" covers the
			// latest of them; the others of that commit are asked about again.
			targets: [...new Set([...(earlier.targets ?? []), target.id])],
			sample: group.results[0] ?? earlier.sample ?? null,
		},
		// A slot dispute has its own question. New reports never end an answer about this cause in its scope.
		material: { signature: group.signature.id, scope: group.scope },
		facts: [`scope:${scopeKind}`],
		refs: [
			`scope:${group.scope}`,
			...group.runs.map(runRef),
			...(change ? [change.key] : []),
			...listed.slice(0, 20).map((test) => test.t),
			...cases.slice(0, 20),
		],
		runs: group.runs,
		target: target.id,
	});
}

/**
 * Every failure a run shows unexplained has a question somebody can answer. That is checked here, each time a run
 * is recomputed, and not left to each path that can take a question away: an answer changed to one that covers
 * less, an answer withdrawn after another closed its neighbour's question, a closed run opened again. A run that
 * speaks (an open planned run, or the run of the newest commit in its scope) is never blocked with nobody asked.
 * An older commit of a change is not asked about again: a newer commit has replaced it. Nor is a change that has
 * ended: it was merged or closed, and nobody will act on an answer about it.
 */
function askUnexplained(ctx: Ctx, run: RunRow): boolean {
	const speaks =
		run.origin === "planned"
			? run.state === "open"
			: run.scope !== null &&
				!scopeEnded(ctx.db, run.scope) &&
				newestInScope(ctx.db, run.project, run.scope)?.id === run.id;
	if (!speaks) return false;
	let asked = false;
	for (const cause of unexplainedShown(ctx.db, run)) {
		const signature = signatureById(ctx.db, cause.signature);
		if (!signature) continue;
		const open = openFailureQuestion(ctx.db, ctx.project.id, {
			signature: signature.hash,
			scope: cause.scope,
			target: cause.target,
		});
		if (open && (json<{ targets?: number[] }>(open.evidence).targets ?? []).includes(cause.target)) {
			// Already asked. If the question did not name this run yet, the run is recomputed to list it.
			if (alsoAbout(ctx, open, [runRef(run)]) > 0) asked = true;
			continue;
		}
		const shown = shownFailure(ctx, run, cause);
		if (!shown) continue;
		const raised = raiseFailure(ctx, {
			group: shown.group,
			target: mustTarget(ctx.db, cause.target),
			by: shown.by,
			producer: actorLabel(ctx.db, shown.by).kind,
		});
		asked ||= raised.s !== "carried";
	}
	return asked;
}

/**
 * A change has ended: its open failure questions are closed, and their refs returned. Nobody will act on an
 * answer about a pull request that was merged or closed, and a failure that came with it into the line fails
 * there and is asked about there. A question an open planned run still shows unexplained stays: that run waits
 * for the answer whatever became of the change. Answers already given stand as they are.
 */
export function stopAskingAbout(ctx: Ctx, change: ChangeRow): string[] {
	const scope = `change:${change.id}`;
	const closed: string[] = [];
	for (const asked of openQuestionsOn(ctx.db, ctx.project.id, `scope:${scope}`)) {
		const question = questionById(ctx.db, asked.id);
		if (question?.state !== "open" || json<{ scope?: string }>(question.subject).scope !== scope) continue;
		if (!endedUnawaited(ctx, question)) continue;
		dissolve(ctx, question);
		ctx.touched.add(questionRef(question));
		closed.push(questionRef(question));
	}
	return closed;
}

/**
 * A change that had ended is open again: ask about unexplained failures in its observed head's run, if that run
 * belongs to this scope. An unreported head or a run in another scope supplies no evidence to re-ask here.
 * Returns the refs of the failure questions open in its scope.
 */
export function askAgainAbout(ctx: Ctx, change: ChangeRow): string[] {
	const scope = `change:${change.id}`;
	const newest = newestInScope(ctx.db, ctx.project.id, scope);
	if (newest) refold(ctx, [newest.id]);
	return openQuestionsOn(ctx.db, ctx.project.id, `scope:${scope}`).flatMap((asked) =>
		asked.kind === "failure" && json<{ scope?: string }>(asked.subject).scope === scope ? [`Q-${asked.no}`] : [],
	);
}

// ── Keeping runs in step ───────────────────────────────────────────────────────────────────────────────────

/**
 * Asks, where a commit now is, what was asked about it before it had a place. Until a pipeline or a person
 * reports a commit, what an agent found on it is asked about under the commit itself: nobody a gate listens to
 * has said which line or pull request it belongs to. The first such report says so. Each question about the
 * commit is then asked there instead, through the one door every failure goes through (so it joins a question
 * already open there, or meets an answer in force there), naming the runs it named, and is closed where it was.
 *
 * An answer already given there ends, like any answer whose ground has moved: it was a judgement about the
 * commit on its own, and it is not carried into a line or a pull request where it would cover other builds.
 * The ledger says so (`outdated`), the runs that rested on it are recomputed (the caller has them), and the
 * question asked in its place names them, a run that has since closed included.
 */
export function askWhereCommitIs(ctx: Ctx, target: TargetRow): void {
	if (target.commit_sha === null) return;
	const own = ownChangeOf(ctx.db, ctx.project.id, target.repo, target.commit_sha);
	if (!own || own.id === target.change) return;
	const before = `change:${own.id}`;
	type Seen = {
		tests?: { id: number; counted?: boolean }[];
		count?: number;
		targets?: number[];
		sample?: number | null;
		message?: string | null;
		producers?: number[];
		parties?: number[];
	};
	// What there is to ask about again, by cause: gathered from every question about the commit before anything
	// is asked, so that each cause is asked about once for each target however many questions had seen it (an
	// answer for one environment leaves the others in a question that still lists them all).
	const causes = new Map<
		number,
		{
			question: QuestionRow;
			seen: Seen;
			targets: Set<number>;
			tests: Map<number, boolean>;
			disputed: boolean;
			parties: Set<number>;
			runs: Set<number>;
			count: number;
		}
	>();
	const moved: QuestionRow[] = [];
	for (const asked of everyQuestionOn(ctx.db, ctx.project.id, `scope:${before}`)) {
		const question = questionById(ctx.db, asked.id);
		if (question?.kind !== "failure") continue;
		const subject = json<{ signature: number; scope: string }>(question.subject);
		if (subject.scope !== before) continue;
		const standing =
			question.state === "decided" && question.decision !== null ? decisionById(ctx.db, question.decision) : null;
		const inForce =
			standing !== null &&
			!["expired", "outdated", "withdrawn"].includes(json<{ is?: string }>(standing.answer).is ?? "");
		if (question.state !== "open" && !inForce) continue;
		// Whether this is a dispute, read before anything is taken away: asked about again where the commit is,
		// a dispute is still a dispute, kept from the same people, and no rule for plain failures answers it.
		const disputed = factsNow(ctx.db, question).has("hint:disputed");
		const seen = json<Seen>(question.evidence);
		const cause = causes.get(subject.signature) ?? {
			question,
			seen,
			targets: new Set<number>(),
			tests: new Map<number, boolean>(),
			disputed: false,
			parties: new Set<number>(),
			runs: new Set<number>(),
			count: 0,
		};
		causes.set(subject.signature, cause);
		cause.disputed ||= disputed;
		// Every test any of the questions named: two environments can have shown the cause in different tests.
		for (const test of seen.tests ?? [])
			cause.tests.set(test.id, cause.tests.get(test.id) === true || test.counted === true);
		cause.count = Math.max(cause.count, seen.count ?? 0, cause.tests.size);
		if (disputed)
			for (const actor of [...(seen.parties ?? []), ...disputeParties(ctx, question)]) cause.parties.add(actor);
		for (const id of runsAbout(ctx, question)) cause.runs.add(id);
		for (const id of seen.targets ?? []) cause.targets.add(id);
		if (standing && inForce) {
			for (const id of runsDependingOn(ctx.db, standing.id)) cause.runs.add(id);
			HANDLERS[question.kind].revert(ctx, question, standing);
			lapse(ctx, question, standing, ctx.now);
		} else moved.push(question);
	}
	for (const [id, cause] of causes) {
		const signature = signatureById(ctx.db, id);
		if (!signature) continue;
		const tests = [...cause.tests.keys()].flatMap((test) => {
			const row = testById(ctx.db, test);
			return row ? [row] : [];
		});
		const refs = [...cause.runs].flatMap((run) => {
			const row = runById(ctx.db, run);
			return row ? [runRef(row)] : [];
		});
		for (const at of cause.targets) {
			const where = mustTarget(ctx.db, at);
			// Only what moved: a target that is still where the question is about stays its to ask about.
			if (scopeOf(where, null) === before) continue;
			const raised = raiseFailure(ctx, {
				group: {
					signature,
					scope: scopeOf(where, null),
					tests,
					results: cause.seen.sample != null ? [cause.seen.sample] : [],
					message: cause.seen.message ?? null,
					disputed: cause.disputed,
					counted: false,
					gateTests: [...cause.tests].flatMap(([test, counted]) => (counted ? [test] : [])),
					runs: [],
				},
				target: where,
				by: cause.seen.producers?.at(-1) ?? ctx.actor.id,
				producer: cause.question.producer,
				parties: [...cause.parties],
				...(cause.count > 0 ? { count: cause.count } : {}),
			});
			if (raised.s === "open" || raised.s === "attached") alsoAbout(ctx, raised.question, refs);
		}
		for (const run of cause.runs) ctx.recompute.add(run);
	}
	for (const question of moved) {
		const seen = json<Seen>(question.evidence);
		const left = (seen.targets ?? []).some((id) => scopeOf(mustTarget(ctx.db, id), null) === before);
		if (!left) setQuestionState(ctx, question, "dissolved", null);
	}
}

/** Whether this question replaces an approval that stopped holding, rather than a rejection or dissolved ask. */
function renewedApproval(ctx: Ctx, asked: QuestionRow | null): boolean {
	if (asked?.prior === undefined || asked.prior === null) return false;
	const prior = questionById(ctx.db, asked.prior);
	const ended = prior?.decision ? decisionById(ctx.db, prior.decision) : null;
	if (!ended || json<{ is: string }>(ended.answer).is !== "outdated" || ended.supersedes === null) return false;
	const approval = decisionById(ctx.db, ended.supersedes);
	return approval !== null && json<{ closed?: string }>(approval.effects).closed !== undefined;
}

/** Reconcile a commit's rule answers with its complete effective results and the base's current lanes. */
function refreshInherited(ctx: Ctx, run: RunRow): Raised[] {
	if (run.origin !== "change") return [];
	const about = `inherited:${runRef(run)}`;
	const questions = everyQuestionOn(ctx.db, ctx.project.id, about);
	if (!run.scope?.startsWith("change:") && questions.length === 0) return [];
	const policy = currentPolicy(ctx.db, ctx.project.id);
	const enabled = policy.clauses.some(
		(clause) =>
			clause.kind === "failure" &&
			clause.ask.who === "rule" &&
			ANSWERS.failure.safeParse(clause.answer).data?.is === "inherited",
	);
	if (!enabled && questions.length === 0) return [];
	const withdrawn = new Set(
		questions.flatMap((question) =>
			question.decision !== null &&
			json<{ is?: string }>(decisionById(ctx.db, question.decision)?.answer ?? "{}").is === "withdrawn"
				? [json<{ signature: number }>(question.subject).signature]
				: [],
		),
	);
	const groups = new Map<number, { target: TargetRow; inherited: { result: number; base: number[] }[] }>();
	for (const row of inheritedEvidenceOf(ctx.db, run)) {
		if (row.signature === null || withdrawn.has(row.signature)) continue;
		const target = mustTarget(ctx.db, row.target);
		const scope = scopeOf(target, null);
		if (excuseFor(ctx.db, run.project, row.signature, scope, target.id)) continue;
		let group = groups.get(row.signature);
		if (!group) {
			group = { target, inherited: [] };
			groups.set(row.signature, group);
		}
		group.inherited.push({ result: row.result, base: row.base });
	}
	const live = questions.filter(
		(question) =>
			question.state === "open" ||
			(question.state === "decided" &&
				question.decision !== null &&
				!["outdated", "expired", "withdrawn"].includes(
					json<{ is: string }>(decisionById(ctx.db, question.decision)?.answer ?? "{}").is,
				)),
	);
	const raised: Raised[] = [];
	const bySignature = new Map(
		live.map((question) => [json<{ signature: number }>(question.subject).signature, question]),
	);
	for (const question of live) {
		const { signature } = json<{ signature: number }>(question.subject);
		if (groups.has(signature)) continue;
		if (question.state === "decided" && question.decision !== null) {
			const decision = decisionById(ctx.db, question.decision);
			if (decision) {
				HANDLERS.failure.revert(ctx, question, decision);
				lapse(ctx, question, decision, ctx.now);
				for (const id of runsDependingOn(ctx.db, decision.id)) ctx.recompute.add(id);
			}
		}
		setQuestionState(ctx, question, "dissolved", questionById(ctx.db, question.id)?.decision ?? null);
	}
	for (const [signatureId, group] of groups) {
		const signature = signatureById(ctx.db, signatureId);
		if (!signature) continue;
		const { target, inherited } = group;
		const scope = scopeOf(target, null);
		const material = { inherited };
		const prior = bySignature.get(signatureId);
		const facts = ["scope:change", "inherited"];
		const clause = clauseFor(policy, { kind: "failure", facts: new Set(facts) });
		const answer = ANSWERS.failure.safeParse(clause.answer);
		if (clause.ask.who !== "rule" || !answer.success || answer.data.is !== "inherited") {
			if (prior?.state === "decided" && prior.decision !== null) {
				const decision = decisionById(ctx.db, prior.decision);
				if (decision) {
					HANDLERS.failure.revert(ctx, prior, decision);
					lapse(ctx, prior, decision, ctx.now);
					for (const id of runsDependingOn(ctx.db, decision.id)) ctx.recompute.add(id);
				}
			}
			if (prior) setQuestionState(ctx, prior, "dissolved", questionById(ctx.db, prior.id)?.decision ?? null);
			continue;
		}
		if (prior?.state === "decided" && prior.decision !== null && prior.basis === contentHash(material)) {
			const decision = decisionById(ctx.db, prior.decision);
			if (decision) {
				raised.push({ s: "carried", question: prior, decision });
				continue;
			}
		}
		const change = target.change === null ? null : changeById(ctx.db, target.change);
		const tests = inherited.flatMap((item) => {
			const result = resultById(ctx.db, item.result);
			const test = result ? testById(ctx.db, result.test) : null;
			return test ? [{ id: test.id, t: testRef(test), name: test.name, case: null, counted: true }] : [];
		});
		raised.push(
			raise(ctx, {
				kind: "failure",
				key: `inherited:${run.id}:${signatureId}`,
				subject: { signature: signatureId, scope, perResult: true },
				title: clip(signature.text, 160),
				producer: "rule",
				evidence: {
					inherited,
					tests: tests.slice(0, 50),
					count: tests.length,
					targetId: target.id,
					target: target.commit_sha,
					targets: [
						...new Set(
							inherited.flatMap((item) => {
								const result = resultById(ctx.db, item.result);
								return result ? [result.target] : [];
							}),
						),
					],
					hints: ["fails-on-base"],
					scope,
				},
				material,
				facts,
				refs: [about, runRef(run), `scope:${scope}`, ...(change ? [change.key] : [])],
				runs: [run],
				target: target.id,
			}),
		);
	}
	return raised;
}

function unchangedSlotSettlement(ctx: Ctx, question: QuestionRow, run: RunRow): boolean {
	if (question.state !== "decided" || question.decision === null) return false;
	const decision = decisionById(ctx.db, question.decision);
	if (!decision || ["withdrawn", "expired", "outdated", "mistaken"].includes(json<{ is: string }>(decision.answer).is))
		return false;
	if (decision.expires_at !== null && decision.expires_at <= ctx.now) return false;
	if (!json<Signer[]>(decision.signers).some((signer) => actorLabel(ctx.db, signer.by).kind === "human")) return false;
	const subject = json<{ slot: number; scope: string }>(question.subject);
	const evidence = json<{ effective: number[]; results: number[] }>(question.evidence);
	if (
		evidence.results.some((id) => {
			const result = resultById(ctx.db, id);
			return !result || scopeOf(mustTarget(ctx.db, result.target), run.id) !== subject.scope;
		})
	)
		return false;
	const before = evidence.effective.filter((id) => resultById(ctx.db, id)?.method !== "agent").sort((a, b) => a - b);
	const now = effectiveFillsOf(ctx.db, subject.slot)
		.filter((fill) => fill.method !== "agent")
		.map((fill) => fill.id)
		.sort((a, b) => a - b);
	return contentHash(before) === contentHash(now);
}

/** Slot settlements have their own question and basis; changing them never withdraws a cause answer. */
function refreshDisputes(ctx: Ctx, run: RunRow): void {
	if (run.origin !== "planned") return;
	const about = `dispute:${runRef(run)}`;
	const previous = everyQuestionOn(ctx.db, ctx.project.id, about);
	const active = new Set<string>();
	for (const dispute of disputesOf(ctx.db, run)) {
		const { slot, signature, scope, failures, effective } = dispute;
		const key = `dispute:${slot.id}:${signature}:${scope}`;
		const fingerprint = contentHash({ kind: "failure", key });
		active.add(fingerprint);
		const material = { results: effective.map((fill) => fill.id).sort((a, b) => a - b) };
		const prior = latestByFingerprint(ctx.db, ctx.project.id, fingerprint);
		if (prior?.basis === contentHash(material) && (prior.state === "open" || prior.state === "decided")) continue;
		if (prior && unchangedSlotSettlement(ctx, prior, run)) continue;
		const cause = signatureById(ctx.db, signature);
		const latest = failures.at(-1);
		if (!cause || !latest) continue;
		const parties = new Set(effective.map((fill) => fill.actor));
		if (prior) for (const actor of json<{ parties?: number[] }>(prior.evidence).parties ?? []) parties.add(actor);
		const target = mustTarget(ctx.db, latest.target);
		const change = target.change === null ? null : changeById(ctx.db, target.change);
		const caseRow = caseById(ctx.db, slot.case_id);
		const tests = [...new Set(failures.map((fill) => fill.test))].flatMap((id) => {
			const test = testById(ctx.db, id);
			return test ? [{ id, t: testRef(test), name: test.name, case: caseRow ? caseRef(caseRow) : null }] : [];
		});
		raise(ctx, {
			kind: "failure",
			key,
			subject: { slot: slot.id, signature, scope },
			title: `Disputed ${caseRow ? caseRef(caseRow) : "slot"} in ${runRef(run)}: ${clip(cause.text, 110)}`,
			producer: actorLabel(ctx.db, latest.actor).kind,
			evidence: {
				signature: { class: cause.class, text: cause.text },
				message: latest.message,
				scope: change ? change.key : scope,
				slot: slot.id,
				run: runRef(run),
				results: failures.map((fill) => fill.id),
				effective: material.results,
				parties: [...parties],
				producers: [...parties],
				tests: tests.slice(0, 50),
				count: tests.length,
				targets: [...new Set(failures.map((fill) => fill.target))],
				target: target.commit_sha ?? target.what,
				branch: target.branch,
				hints: ["disputed"],
				sample: latest.id,
			},
			material,
			facts: ["scope:run", "hint:disputed"],
			refs: [about, runRef(run), ...(caseRow ? [caseRef(caseRow)] : [])],
			runs: [run],
		});
	}
	for (const question of previous) {
		if (active.has(question.fingerprint)) continue;
		if (unchangedSlotSettlement(ctx, question, run)) continue;
		if (question.state === "decided" && question.decision !== null) {
			const decision = decisionById(ctx.db, question.decision);
			if (!decision || json<{ is: string }>(decision.answer).is === "mistaken") continue;
			if (["withdrawn", "expired", "outdated"].includes(json<{ is: string }>(decision.answer).is)) continue;
			HANDLERS.failure.revert(ctx, question, decision);
			lapse(ctx, question, decision, ctx.now);
			for (const id of runsDependingOn(ctx.db, decision.id)) ctx.recompute.add(id);
		}
		if (question.state === "open" || question.state === "decided")
			setQuestionState(ctx, question, "dissolved", questionById(ctx.db, question.id)?.decision ?? null);
	}
}

/** Upgrade earlier disputes before serving reads. Later starts find their slot questions and do no work. */
export function recoverDisputes(ctx: Ctx): number {
	const missing = disputedRuns(ctx.db, ctx.project.id).filter((id) => {
		const run = runById(ctx.db, id);
		return run && everyQuestionOn(ctx.db, ctx.project.id, `dispute:${runRef(run)}`).length === 0;
	});
	if (missing.length > 0) refold(ctx, missing, { dissolveStale: true });
	return missing.length;
}

/** Recompute affected runs and raise sign-off for a planned run that now passes. */
export function refold(ctx: Ctx, runIds: Iterable<number>, options: { dissolveStale?: boolean } = {}): void {
	for (const id of runIds) ctx.recompute.add(id);
	ctx.dissolveStale ||= options.dissolveStale === true;
	if (ctx.folding) return;
	ctx.folding = true;
	try {
		do {
			// Runs whose counted results a decision changed on the way here (`ctx.recompute`) come along.
			const ids = new Set(ctx.recompute);
			for (const change of ctx.changedBases) for (const id of changeRunsOf(ctx.db, change)) ids.add(id);
			ctx.changedBases.clear();
			ctx.recompute.clear();
			// Base results and retargeting reach every affected commit and planned run in this transaction.
			for (const id of ids) {
				const run = runById(ctx.db, id);
				if (run) for (const affected of inheritanceAffected(ctx.db, run)) ids.add(affected);
			}
			for (const id of ids) {
				const run = runById(ctx.db, id);
				if (run) refreshInherited(ctx, run);
			}
			for (const id of ids) {
				ctx.recompute.delete(id);
				const existing = runById(ctx.db, id);
				if (!existing) continue;
				refreshDisputes(ctx, existing);
				let result = retally(
					ctx,
					id,
					blockersOf(ctx, existing),
					currentPolicy(ctx.db, ctx.project.id).settings.emptyReports,
				);
				if (result.failing.size > 0 && askUnexplained(ctx, result.run))
					result = retally(
						ctx,
						id,
						blockersOf(ctx, result.run),
						currentPolicy(ctx.db, ctx.project.id).settings.emptyReports,
					);
				if (ctx.dissolveStale) {
					dissolveStale(ctx, result);
					endPassed(ctx, result.run);
				}
				const run = result.run;
				const asked =
					run.origin === "planned"
						? openFor(ctx.db, ctx.project.id, contentHash({ kind: "signoff", key: `run:${run.id}` }), undefined)
						: null;
				// A commit run's late report changes the basis of its approval even when it no longer passes. Keep
				// that new question current while the failure is resolved; approving still requires a passing gate.
				const material = { tally: json(run.tally), applied: run.applied_seq };
				const approval = run.signoff !== null ? decisionById(ctx.db, run.signoff) : null;
				const reconsider =
					run.origin === "planned" &&
					json<{ commit?: string }>(run.accepts).commit !== undefined &&
					run.outstanding === 0 &&
					((run.state === "closed" && approval?.basis !== contentHash(material)) || renewedApproval(ctx, asked));
				if (!result.wantsSignoff && !reconsider) {
					// A first sign-off was asked while the run passed. It no longer does, so nobody can approve it on
					// what it showed then. A late report to an approved commit run is reconsidered above instead.
					if (asked && run.state === "open" && run.verdict !== "passed" && run.outstanding === 0)
						setQuestionState(ctx, asked, "dissolved", null);
					continue;
				}
				raise(ctx, {
					kind: "signoff",
					key: `run:${run.id}`,
					subject: { run: run.id },
					title: `Close ${runRef(run)} ${run.name}`,
					producer: "rule",
					evidence: { run: runRef(run), name: run.name, verdict: run.verdict, tally: json(run.tally) },
					material,
					facts: [`verdict:${run.verdict}`],
					refs: [runRef(run)],
					runs: [],
				});
			}
		} while (ctx.recompute.size > 0 || ctx.changedBases.size > 0);
	} finally {
		ctx.folding = false;
		ctx.dissolveStale = false;
	}
}

/** The open questions about a run, as the run fold needs them. */
function blockersOf(ctx: Ctx, run: RunRow): Blocker[] {
	return openQuestionsOn(ctx.db, ctx.project.id, runRef(run)).map((open) => ({
		ref: questionRef(open),
		kind: open.kind,
		signature: open.kind === "failure" ? (json<{ signature?: number }>(open.subject).signature ?? null) : null,
		scope: open.kind === "failure" ? (json<{ scope?: string }>(open.subject).scope ?? null) : null,
		slot: open.kind === "failure" ? json<{ slot?: number }>(open.subject).slot : undefined,
		blocks: json<number[]>(open.blocks),
	}));
}

/**
 * A failure question about a cause that stopped failing is closed as dissolved: nobody should be asked why
 * something failed after it passed. The question and its history remain. Called for each run a report counted
 * toward, about the questions that name the run or its scope.
 */
function dissolveStale(ctx: Ctx, { run, failing }: Pick<Retallied, "run" | "failing">): void {
	const candidates = new Set<number>();
	for (const about of [runRef(run), ...(run.scope !== null ? [`scope:${run.scope}`] : [])]) {
		for (const open of openQuestionsOn(ctx.db, ctx.project.id, about)) {
			if (open.kind === "failure") candidates.add(open.id);
		}
	}
	// The latest tally includes rules applied while asking. Dissolving open questions changes no standing.
	const shown = new Map<number, Set<string>>([[run.id, failing]]);
	// One report can make thousands of questions go away, all waited for by the same run: it is recomputed once,
	// when they are all closed, not once for each.
	const waited = new Set<number>();
	for (const id of candidates) {
		const question = questionById(ctx.db, id);
		if (question?.state === "open" && stoppedFailing(ctx, question, shown)) dissolve(ctx, question, waited);
	}
	for (const id of waited) {
		const named = runById(ctx.db, id);
		if (named)
			retally(ctx, named.id, blockersOf(ctx, named), currentPolicy(ctx.db, ctx.project.id).settings.emptyReports);
	}
}

/**
 * An answer that says the target needs a fix (`ATTRIBUTED`) ends when its cause passes in the newest commit of its
 * scope: the fix arrived, so a later failure of the cause is asked about and not put down to the old answer
 * (decision 0102). Like every ending, it stops explaining the commits that failed before: they read `blocked`, and
 * nobody is asked about them. Called for each run a report counted toward, like `dissolveStale`.
 */
function endPassed(ctx: Ctx, run: RunRow): void {
	if (run.origin !== "change" || run.scope === null) return;
	if (newestInScope(ctx.db, ctx.project.id, run.scope)?.id !== run.id) return;
	for (const question of attributedQuestionsOn(ctx.db, ctx.project.id, `scope:${run.scope}`)) {
		if (json<{ scope?: string }>(question.subject).scope !== run.scope || question.decision === null) continue;
		const decision = decisionById(ctx.db, question.decision);
		const passed = decision ? passedIn(ctx, question, run) : null;
		if (decision && passed) endHold(ctx, decision, { is: "outdated", clause: "passed", ...passed });
	}
}

/**
 * Did the cause of an answered question pass in this run? Absence is not proof, and an early report is not the
 * whole run, so it asks for more than `stoppedFailing` does of an open question:
 *
 * - no test fails with the cause in the run, whether an answer explains it or not;
 * - every test the question lists passes, in each environment where it has failed with the cause in the scope, so a
 *   shard that has not reported one of them yet holds the answer, and so does a test
 *   the fix renamed or removed. Which job ran a test does not matter: a sharded pipeline moves tests between jobs.
 *   The history is read from the results as reported, which a passing retry does not change;
 * - the question lists every test it has seen (it keeps fifty), and no open planned run names it: that run was
 *   asked for by a person and waits for its own evidence.
 *
 * Returns the reason to record.
 */
function passedIn(ctx: Ctx, question: QuestionRow, run: RunRow): { reason: string } | null {
	const { signature, scope } = json<{ signature: number; scope: string }>(question.subject);
	const evidence = json<{ tests?: { id: number }[]; count?: number }>(question.evidence);
	const listed = new Set((evidence.tests ?? []).map((test) => test.id));
	if (listed.size === 0 || (evidence.count ?? 0) > listed.size) return null;
	const planned = runsAbout(ctx, question).some((id) => {
		const named = runById(ctx.db, id);
		return named?.origin === "planned" && named.state === "open";
	});
	if (planned) return null;
	const tests = [...listed];
	// The cheap questions first: they settle the usual report, in which the cause still fails or did not run.
	if (failsWith(ctx.db, run.id, signature) || !passesAny(ctx.db, run.id, tests)) return null;
	// A report not yet applied, or a shard that has not reported, may hold the cause failing (decision 0092).
	if (stillArriving(ctx.db, run)) return null;
	// Where the cause has failed: every listed test in every environment a pipeline or a person saw it fail with
	// the cause in this scope, as reported. No point in time bounds it, so no way of raising a question can leave a
	// failure out; a retry that passed changes nothing.
	const failed = failedIn(ctx.db, { project: ctx.project.id, signature, scope, tests: listed });
	const where = (row: { test: number; env: string }): string => JSON.stringify([row.test, row.env]);
	const passing = new Set(passingIn(ctx.db, run.id, tests).map(where));
	if (failed.length === 0 || failed.some((row) => !passing.has(where(row)))) return null;
	const commit = json<{ commit?: string }>(run.accepts).commit?.slice(0, 12) ?? runRef(run);
	return { reason: `Every test it named passed on ${commit} where it had failed; the answer ended.` };
}

/**
 * Closes a question as dissolved, and recomputes each run that listed it among those it waits for. Given
 * `later`, it names those runs there instead and the caller recomputes them when it has closed all it will.
 */
function dissolve(ctx: Ctx, question: QuestionRow, later?: Set<number>): void {
	setQuestionState(ctx, question, "dissolved", null);
	for (const about of runsAbout(ctx, question)) {
		if (later?.has(about)) continue;
		const named = runById(ctx.db, about);
		if (!named || !json<string[]>(named.blocking).includes(questionRef(question))) continue;
		if (later) later.add(named.id);
		else retally(ctx, named.id, blockersOf(ctx, named), currentPolicy(ctx.db, ctx.project.id).settings.emptyReports);
	}
}

/**
 * A question put back in front of people, because its answer was withdrawn or ran out, is closed again when the
 * failure it asks about went away meanwhile: nobody is asked about a failure that nothing shows, and no commit's
 * gate names a question for it until some later report happens to look. The same when its change has ended
 * meanwhile: nobody would act on the answer. True when it was closed.
 */
function closeIfGone(ctx: Ctx, id: number): boolean {
	const question = questionById(ctx.db, id);
	if (question?.kind !== "failure" || question.state !== "open") return false;
	if (!endedUnawaited(ctx, question) && !stoppedFailing(ctx, question, new Map())) return false;
	dissolve(ctx, question);
	return true;
}

/**
 * Is this a failure question about a change that has ended, which no open planned run still shows unexplained?
 * Then nobody is asked: a pull request that was merged or closed is acted on by nobody. A planned run was asked
 * for by a person, and waits for the answer whatever became of the change.
 */
function endedUnawaited(ctx: Ctx, question: QuestionRow): boolean {
	if (question.kind !== "failure") return false;
	if (json<{ slot?: number }>(question.subject).slot !== undefined) return false;
	const subject = json<{ signature?: number; scope?: string }>(question.subject);
	if (subject.signature === undefined || subject.scope === undefined) return false;
	if (!scopeEnded(ctx.db, subject.scope)) return false;
	const key = causeKey(subject.signature, subject.scope);
	return !runsAbout(ctx, question).some((id) => {
		const run = runById(ctx.db, id);
		return run?.origin === "planned" && run.state === "open" && unexplainedIn(ctx.db, run).has(key);
	});
}

/**
 * Has the cause of this question stopped failing everywhere that speaks for it? Two kinds of run speak: the run
 * of the newest commit in the question's scope (an older commit's late report says nothing about the current
 * one), and every open planned run the question names. None of them may still show the cause unexplained: a
 * question is never closed while a run it would unblock is blocked by it. A planned run counts what it asked for,
 * so a pipeline's pass does not clear a slot that asked for an agent.
 *
 * And absence is not proof. Something must show the failure gone: one of the question's own tests passing in the
 * newest commit's run (a newer commit whose failing job has not reported yet says nothing), or a planned run
 * that showed the cause and no longer does, which only a newer attempt, a correction or a decision can bring about.
 * The pass must be of a test a commit's gate counted as failing with the cause: a pipeline that always passed a
 * test says nothing about the failure an agent found in it, which stays asked about until a person answers.
 */
function stoppedFailing(ctx: Ctx, question: QuestionRow, shown: Map<number, Set<string>>): boolean {
	const subject = json<{ signature: number; scope: string; slot?: number }>(question.subject);
	if (subject.slot !== undefined) return slotById(ctx.db, subject.slot)?.state !== "disputed";
	const key = causeKey(subject.signature, subject.scope);
	const shows = (run: RunRow): boolean => {
		let causes = shown.get(run.id);
		if (!causes) {
			causes = unexplainedIn(ctx.db, run);
			shown.set(run.id, causes);
		}
		return causes.has(key);
	};
	let gone = false;
	const newest = newestInScope(ctx.db, ctx.project.id, subject.scope);
	// A commit whose results are still arriving (a report not yet applied, a shard of a job not yet reported) may yet
	// show the cause: nothing closes the question meanwhile, not even a planned run that cleared (decision 0092).
	if (newest && stillArriving(ctx.db, newest)) return false;
	if (newest) {
		if (shows(newest)) return false;
		// A commit's gate counts pipelines and people, so its pass speaks only for a test it counted as failing.
		const tests = (json<{ tests?: { id: number; counted?: boolean }[] }>(question.evidence).tests ?? []).flatMap(
			(test) => (test.counted ? [test.id] : []),
		);
		gone =
			passesAny(ctx.db, newest.id, tests) ||
			countedTestsOf(ctx.db, newest.id).some(
				(row) =>
					row.signature === subject.signature &&
					tests.includes(row.test) &&
					excuseForResult(
						ctx.db,
						{ id: row.result, project: newest.project, signature: row.signature, target: row.target },
						subject.scope,
					) !== null,
			);
	}
	for (const id of runsAbout(ctx, question)) {
		const run = runById(ctx.db, id);
		if (run?.origin !== "planned" || run.state !== "open") continue;
		if (shows(run)) return false;
		gone = true;
	}
	return gone;
}

/**
 * Reopens every question whose decision has run out of time, and recomputes the runs that rested on it. The gate
 * already reads `pending` once a hold expires; this makes the question visible again without waiting for the next
 * report. The expiry is a row in the ledger, signed by the rule actor and superseding the decision that ran out, so
 * the next answer follows it and the chain is unbroken. Returns the number reopened.
 */
export function sweepExpired(ctx: Ctx, expired: readonly DecisionRow[]): number {
	let reopened = 0;
	for (const decision of expired) {
		if (endHold(ctx, decision, { is: "expired", clause: "hold-expired", reason: null })) reopened++;
	}
	return reopened;
}

export function endDefectHold(ctx: Ctx, decision: DecisionRow, ref: string): boolean {
	const current = decisionById(ctx.db, decision.id);
	if (!current || current.project !== ctx.project.id || current.kind !== "failure") return false;
	const answer = json<{ is?: string; ref?: string }>(current.answer);
	if (answer.is !== "defect" || answer.ref !== ref) return false;
	return endHold(ctx, current, {
		is: "outdated",
		clause: "tracker-closed",
		reason: `Tracker issue ${ref} is closed; the defect hold ended.`,
	});
}

/**
 * A decision stops holding by the rule: its time ran out (`hold-expired`), its tracker issue closed
 * (`tracker-closed`), or its cause passed (`passed`). Each way it no longer explains anything.
 */
type Ending = {
	is: "expired" | "outdated";
	clause: "hold-expired" | "tracker-closed" | "passed";
	reason: string | null;
};

function endHold(ctx: Ctx, decision: DecisionRow, ending: Ending): boolean {
	const question = questionById(ctx.db, decision.question);
	if (question?.state !== "decided" || question.decision !== decision.id) return false;
	HANDLERS[question.kind].revert(ctx, question, decision);
	const ended = insertDecision(ctx, {
		question,
		answer: { is: ending.is },
		signers: [
			{
				by: ruleActor(ctx.db).id,
				clause: ending.clause,
				policy: currentPolicy(ctx.db, ctx.project.id).version,
				reason: ending.reason,
			},
		],
		holds: [],
		supersedes: decision.id,
	});
	setQuestionState(ctx, question, "open", null);
	const closed = closeAnswered(ctx, question);
	refold(ctx, [...runsAbout(ctx, question), ...runsDependingOn(ctx.db, decision.id), ...closed]);
	closeIfGone(ctx, question.id);
	if (questionById(ctx.db, question.id)?.state === "dissolved") setQuestionState(ctx, question, "dissolved", ended.id);
	return true;
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────

/** Current clause facts. Only a slot question asks about a dispute; cause answers retain their own policy. */
export function factsNow(db: Db, question: QuestionRow): Set<string> {
	return complete(factsNowSteps(db, question));
}

function* factsNowSteps(db: Db, question: QuestionRow): Generator<undefined, Set<string>, void> {
	const facts = new Set(json<{ facts?: string[] }>(question.evidence).facts ?? []);
	if (question.kind === "adopt" && question.state !== "decided") {
		const subject = json<{ proposal: number }>(question.subject);
		const proposal = proposalById(db, subject.proposal);
		if (proposal) {
			for (const fact of facts) if (fact.startsWith("folder:") || fact.startsWith("tag:")) facts.delete(fact);
			for (const fact of yield* scopeFactsSteps(db, question.project, resolvedOf(proposal))) facts.add(fact);
		}
	}
	if (question.kind !== "failure") return facts;
	const subject = json<{ signature?: number; scope?: string; slot?: number }>(question.subject);
	if (subject.signature === undefined || subject.scope === undefined) return facts;
	if (subject.slot !== undefined) facts.add("hint:disputed");
	else facts.delete("hint:disputed");
	return facts;
}

/**
 * Who is asked, as things are now: what the policy in force says for the facts as they are. The question keeps
 * what it was asked under, and that goes stale two ways: a dispute arises or ends, and the policy is changed.
 * Where the clause is a rule and a person is asked in its stead (its answer was withdrawn or overruled), a
 * member is.
 */
function askNow(db: Db, question: QuestionRow, facts: ReadonlySet<string>): Ask {
	const stored = json<Ask>(question.ask);
	const ask = clauseFor(currentPolicy(db, question.project), { kind: question.kind, facts: new Set(facts) }).ask;
	return ask.who === "rule" && stored.who !== "rule" ? { ...ask, who: "member" } : ask;
}

/** A question as the queue, a case page and an agent see it. */
export function toItem(db: Db, row: QuestionRow): QuestionItem {
	const facts = factsNow(db, row);
	return itemOf(db, row, facts, askNow(db, row, facts));
}

/**
 * A question as its reader sees it in the queue: the item, and what the reader's own answer would be worth. The
 * facts and who is asked are read once for both: a queue page reads them for every question it shows.
 */
export function toItemFor(ctx: Ctx, row: QuestionRow): QuestionItem & { you: "counts" | "advice" | "forbidden" } {
	const facts = factsNow(ctx.db, row);
	const ask = askNow(ctx.db, row, facts);
	return { ...itemOf(ctx.db, row, facts, ask), you: standingFor(ctx, row, ask) };
}

function itemOf(db: Db, row: QuestionRow, facts: ReadonlySet<string>, ask: Ask): QuestionItem {
	const stored = json<Record<string, unknown> & { hints?: string[] }>(row.evidence);
	if (row.kind === "adopt" && typeof stored.authorId === "number") stored.author = actorLabel(db, stored.authorId).name;
	if (row.kind === "finding" && typeof stored.finderId === "number")
		stored.finder = actorLabel(db, stored.finderId).name;
	const hints = (stored.hints ?? []).filter((hint) => hint !== "disputed");
	if (facts.has("hint:disputed")) hints.unshift("disputed");
	const answers = answersOf(db, row.id);
	const decision = row.decision !== null ? decisionById(db, row.decision) : null;
	const supersedes =
		decision && decision.supersedes !== null && holdEndingById(db, decision.id) !== null
			? decisionById(db, decision.supersedes)
			: null;
	return {
		q: questionRef(row),
		kind: row.kind,
		title: row.title,
		producer: row.producer,
		state: row.state,
		evidence: row.kind === "failure" ? { ...stored, hints, facts: [...facts] } : stored,
		evidenceHash: row.evidence_hash,
		seen: { count: row.seen_count, carried: row.carried },
		needs: describeAsk(ask),
		answers: applicableAnswers(row.kind, facts),
		blocks: json<number[]>(row.blocks).flatMap((id) => {
			const run = runById(db, id);
			return run ? [runRef(run)] : [];
		}),
		about: refsOf(db, row.id),
		openedAt: row.opened_at,
		advice: answers
			.filter((a) => a.counts === 0 && a.on_evidence === row.evidence_hash)
			.map((a) => ({
				by: actorLabel(db, a.actor).name,
				kind: actorLabel(db, a.actor).kind,
				answer: json<Record<string, unknown>>(a.answer),
				reason: a.reason,
			})),
		decision: decision
			? {
					...decisionItem(db, decision),
					effects: json<Record<string, unknown>>(decision.effects),
					...(supersedes ? { supersedes: decisionItem(db, supersedes) } : {}),
				}
			: null,
	};
}

function decisionItem(db: Db, decision: DecisionRow) {
	const signers = json<Signer[]>(decision.signers);
	return {
		id: decision.id,
		answer: json<Record<string, unknown>>(decision.answer),
		by: signers.map((signer) => actorLabel(db, signer.by).name),
		rule: signers.find((signer) => actorLabel(db, signer.by).kind === "rule")?.clause ?? null,
		reason: signers.find((signer) => signer.reason)?.reason ?? null,
		at: decision.at,
	};
}

/** Whether the acting actor may settle this question, so a surface can show the keys or say who is needed. */
function standingFor(ctx: Ctx, row: QuestionRow, ask: Ask): "counts" | "advice" | "forbidden" {
	const handler = HANDLERS[row.kind];
	return standingOf({
		actor: ctx.actor,
		ask: ask.who === "rule" ? { ...ask, who: "member" } : ask,
		isAuthor: handler.isAuthor(ctx, row),
		isProducer: ask.notProducer && handler.isProducer(ctx, row),
	});
}
