// What this browser keeps for a person until the server has it: drafts, the step ids a case has used, and the
// notes typed for a run. Every key names the actor the session belongs to by its id, never by its sign-in name:
// a name outlives the person (an admin forgets them, and another person can be given it), an id does not. Somebody
// else who signs in on the same browser is never shown what the person before them typed, and cannot record it as
// their own. Sign-out can explicitly clear it; otherwise it stays for when that person signs in again. Work
// started as one person (a pending save, a retry, clean-up) carries the session it started in (`DeviceSession`)
// and stops when the page's person changes or the browser data is cleared, in this tab or another.
declare const actorIdBrand: unique symbol;
/** An actor id from the session reply: the only thing a device key can be built from. */
export type ActorId = number & { readonly [actorIdBrand]: true };
const nobody = 0 as ActorId;
let id = nobody;
let revision = 0;
let active = false;
export const deviceClearKey = "mainworthy:device-clear";
function clearRevision(): string {
	try {
		return localStorage.getItem(deviceClearKey) ?? "";
	} catch {
		return "";
	}
}
let cleared = clearRevision();
// Authentication changes replace the shared cookie, while same-actor drafts and pending files keep their UI owner.
// The local revision also invalidates requests when storage reads work but publishing fails.
const authenticationKey = "mainworthy:auth-generation";
let authenticationRevision = 0;
function sharedAuthentication(): string | null {
	try {
		return localStorage.getItem(authenticationKey) ?? "";
	} catch {
		return null;
	}
}
export const authenticationGeneration = () => ({ revision: authenticationRevision, shared: sharedAuthentication() });
export const authenticationUnchanged = (held: ReturnType<typeof authenticationGeneration>): boolean =>
	held.revision === authenticationRevision && held.shared === sharedAuthentication();
export function publishAuthentication(): void {
	authenticationRevision++;
	try {
		localStorage.setItem(authenticationKey, String(crypto.getRandomValues(new Uint32Array(4))));
	} catch {}
}

export const sessionPersonKey = "mainworthy:session-person";
export type DeviceSession = { actorId: ActorId; revision: number; cleared: string };

export function setDevicePerson(info: { actor: string; actorId: number }): void {
	if (!active || info.actorId !== id) revision++;
	id = info.actorId as ActorId;
	cleared = clearRevision();
	active = true;
	try {
		localStorage.setItem(sessionPersonKey, String(id));
	} catch {}
}
export function suspendDeviceSession(): void {
	active = false;
	cleared = clearRevision();
	revision++;
}
export const deviceSession = (): DeviceSession => ({ actorId: id, revision, cleared });
export const sessionUnchanged = (owner: DeviceSession): boolean =>
	owner.actorId === id && owner.revision === revision && owner.cleared === clearRevision();
export const sessionCurrent = (owner: DeviceSession): boolean => active && sessionUnchanged(owner);

/** Invalidate old work before deleting, so other tabs and delayed replies cannot put cleared drafts back. */
export function clearDevicePerson(owner: DeviceSession): void {
	localStorage.setItem(deviceClearKey, String(crypto.getRandomValues(new Uint32Array(4))));
	suspendDeviceSession();
	if (localStorage.getItem(sessionPersonKey) === String(owner.actorId)) localStorage.removeItem(sessionPersonKey);
	const prefix = personPrefix(owner.actorId);
	for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
}
/** What the device keeps for a person, each under its own kind of key. */
const PERSON_KINDS = [
	"active",
	"draft",
	"draft-copy",
	"home",
	"queue-input",
	"run-note",
	"run-plan",
	"run-step",
	"steps",
] as const;
type PersonKind = (typeof PERSON_KINDS)[number];
/** `#` is escaped in every name, so no sign-in name can write a key of this shape. */
const personPrefix = (actor: ActorId): string => `mainworthy:#${actor}:`;
export const deviceKey = (kind: PersonKind, rest: string, actor: ActorId = id): string =>
	`${personPrefix(actor)}${kind}:${rest}`;

/** A key an earlier version wrote under a sign-in name (escaped, so it holds no `:` and cannot start with `#`). */
const nameKeyed = new RegExp(`^mainworthy:(?!#)[^:]*:(?:${PERSON_KINDS.join("|")}):`);
/**
 * Removes what an earlier version kept under a sign-in name: a name can belong to another person later, so such
 * data is never read and does not linger (issue #380). Only a person's kinds of key go; every other key stays.
 */
export function dropNameKeyedData(store: Pick<Storage, "length" | "key" | "removeItem">): void {
	const named: string[] = [];
	for (let index = 0; index < store.length; index++) {
		const key = store.key(index);
		if (key && nameKeyed.test(key)) named.push(key);
	}
	for (const key of named) store.removeItem(key);
}
try {
	dropNameKeyedData(localStorage);
} catch {
	// No storage (a private window, a test outside a browser): nothing was kept, so nothing is dropped.
}
