const evidenceOf = (q: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-proposal-evidence="${CSS.escape(q)}"]`);

export function proposalReadMessage(q: string): string | null {
	const evidence = evidenceOf(q);
	if (evidence?.dataset.proposalRead === "ready") return null;
	return evidence?.dataset.proposalError || "Still reading the proposal. Read its edits before answering.";
}

/** A part of the evidence and the vertical ranges of it that have been on screen, in its own coordinates. */
type ShownPart = { element: Element; height: number; ranges: [number, number][] };
type Shown = { parts: ShownPart[]; unread: Set<ShownPart> };

/**
 * Scroll positions are rounded, so a part paged into view can stay a fraction of a pixel outside the visible area.
 * A gap of up to one pixel counts as seen; no line of text fits in it.
 */
const ROUNDING = 1;

function firstUnseen(part: ShownPart): number {
	const first = part.ranges[0];
	return first && first[0] <= ROUNDING ? first[1] : 0;
}

function partShown(part: ShownPart): boolean {
	return part.height > 0 && firstUnseen(part) >= part.height - ROUNDING;
}

function coverRange(part: ShownPart, start: number, end: number): void {
	if (end <= start) return;
	const merged: [number, number][] = [];
	for (const range of [...part.ranges, [start, end] satisfies [number, number]].sort((a, b) => a[0] - b[0])) {
		const last = merged.at(-1);
		if (last && range[0] <= last[1] + ROUNDING) last[1] = Math.max(last[1], range[1]);
		else merged.push(range);
	}
	part.ranges = merged;
}
const shown = new WeakMap<HTMLElement, Shown>();

/** The viewport clipped by every ancestor, including the desktop pane or the phone's page scroller. */
function visibleArea(evidence: HTMLElement): { top: number; bottom: number; left: number; right: number } {
	const area = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
	for (let element: HTMLElement | null = evidence; element; element = element.parentElement) {
		const style = getComputedStyle(element);
		const box = element.getBoundingClientRect();
		if (style.overflowY !== "visible") {
			area.top = Math.max(area.top, box.top);
			area.bottom = Math.min(area.bottom, box.bottom);
		}
		if (style.overflowX !== "visible") {
			area.left = Math.max(area.left, box.left);
			area.right = Math.min(area.right, box.right);
		}
	}
	return area;
}

function recordProposalShown(evidence: HTMLElement, parts?: Iterable<ShownPart>): void {
	const state = shown.get(evidence);
	if (!state || evidence.dataset.proposalLoaded !== "true") return;
	const area = visibleArea(evidence);
	if (area.bottom <= area.top || area.right <= area.left) return;
	for (const part of parts ?? state.parts) {
		const box = part.element.getBoundingClientRect();
		if (box.height !== part.height) {
			part.height = box.height;
			part.ranges = [];
			state.unread.add(part);
		}
		if (box.right <= area.left || box.left >= area.right) continue;
		// Short or tall, a part is read only where it was on screen: a fast scroll that showed only its bottom
		// edge does not count the rest.
		coverRange(part, Math.max(0, area.top - box.top), Math.min(box.height, area.bottom - box.top));
		if (partShown(part)) state.unread.delete(part);
	}
	evidence.dataset.proposalRead = state.unread.size === 0 ? "ready" : "loaded";
}

/** Capturing scroll observes every scroller without depending on which layout owns it. */
export function watchProposalShown(evidence: HTMLElement): () => void {
	if (!shown.has(evidence)) {
		// A single edit may contain many steps. Seeing its heading does not show its later diff rows.
		const elements = [...evidence.querySelectorAll("p, .dl, li")];
		const parts = (elements.length ? elements : [...evidence.children]).map(
			(element): ShownPart => ({ element, height: 0, ranges: [] }),
		);
		shown.set(evidence, { parts, unread: new Set(parts) });
		const area = evidence.closest<HTMLElement>(".queue-evidence") ?? evidence;
		area.scrollTop = 0;
	}
	const state = shown.get(evidence);
	if (!state) return () => {};
	const byElement = new Map(state.parts.map((part) => [part.element, part]));
	const visible = new Set<ShownPart>();
	const intersections = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			const part = byElement.get(entry.target);
			if (!part) continue;
			if (entry.isIntersecting) visible.add(part);
			else visible.delete(part);
		}
		// Entering parts are measured here too: a scroll's animation frame may run before observer delivery.
		recordProposalShown(evidence, visible);
	});
	const sizes = new ResizeObserver((entries) => {
		const changed = entries.flatMap((entry) => {
			const part = byElement.get(entry.target);
			return part ? [part] : [];
		});
		recordProposalShown(evidence, changed);
	});
	for (const part of state.parts) {
		intersections.observe(part.element);
		sizes.observe(part.element);
	}
	let frame = 0;
	const scroll = (event: Event) => {
		const target = event.target;
		if (target instanceof Element && !target.contains(evidence) && !evidence.contains(target)) return;
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			recordProposalShown(evidence, visible);
		});
	};
	const record = () => recordProposalShown(evidence);
	document.addEventListener("scroll", scroll, true);
	window.addEventListener("resize", record);
	record();
	return () => {
		document.removeEventListener("scroll", scroll, true);
		window.removeEventListener("resize", record);
		cancelAnimationFrame(frame);
		intersections.disconnect();
		sizes.disconnect();
	};
}

/** Returns a status after revealing or paging the evidence; null permits the answer. */
export function answerShown(q: string, answer: string, via: "key" | "button"): string | null {
	const evidence = evidenceOf(q);
	if (evidence) recordProposalShown(evidence);
	const card = evidence?.closest<HTMLElement>("[data-proposal]");
	const pane = card?.closest<HTMLElement>(".pane-scroll");
	const box = card?.getBoundingClientRect();
	const frame = pane?.getBoundingClientRect();
	const again =
		via === "key"
			? `press ${answer === "accept" ? "a" : "r"} again`
			: `choose ${answer === "accept" ? "Accept" : "Reject"} again`;
	let revealed = false;
	if (
		pane &&
		box &&
		frame &&
		(box.height > frame.height
			? box.bottom <= Math.max(frame.top, 0) || box.top >= Math.min(frame.bottom, window.innerHeight)
			: box.top < Math.max(frame.top, 0) - 1 || box.bottom > Math.min(frame.bottom, window.innerHeight) + 1)
	) {
		if (box.top < frame.top) pane.scrollTop += box.top - frame.top - 8;
		else pane.scrollTop += Math.min(box.bottom - frame.bottom + 8, box.top - frame.top - 8);
		revealed = true;
	}
	if (evidence?.dataset.proposalLoaded !== "true") return proposalReadMessage(q);
	const state = shown.get(evidence);
	if (evidence.dataset.proposalRead !== "ready") {
		const next = state?.parts.find((part) => !partShown(part));
		if (next) {
			const area = visibleArea(evidence);
			for (let scroller = next.element.parentElement; scroller; scroller = scroller.parentElement) {
				if (
					!/^(auto|scroll|hidden)$/.test(getComputedStyle(scroller).overflowY) ||
					scroller.scrollHeight <= scroller.clientHeight
				)
					continue;
				const scale = scroller.getBoundingClientRect().height / scroller.offsetHeight;
				const offset = next.element.getBoundingClientRect().top + firstUnseen(next) - area.top - 1;
				scroller.scrollTop += offset / scale;
				break;
			}
		}
		return `${q} has unread edits. Read the next part, then ${again}.`;
	}
	return revealed ? `${q} is now in view. Read it, then ${again}.` : null;
}
