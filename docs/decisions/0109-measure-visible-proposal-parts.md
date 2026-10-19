# 0109: Measure visible proposal parts while scrolling

Date: 2026-10-18. Status: proposed.

## Problem

The web proposal gate measured every part on every scroll, including scrolls elsewhere
in the document. Paging a short diff row also scrolled the case's outer pane, so the
next answer press had to bring the card back into view (issue #540).

## Decision

Keep the merged vertical ranges that have actually been on screen for each part.
An `IntersectionObserver` selects visible candidates. Captured scroll events measure
those candidates once per animation frame, and observer delivery records newly visible
parts. A set of unread parts determines readiness without scanning the whole proposal.
A `ResizeObserver` rechecks resized parts. Initial setup, window resize and an explicit
answer still measure all parts so changed heights reset coverage before an answer.
The observer callbacks, listeners and pending frame end when the watcher detaches.
An unchanged evidence node retains its coverage through a re-fetch.

Page both short and tall rows by moving the nearest scrollable ancestor to the first
unread range. Avoid `scrollIntoView`, which moves outer ancestors too. Queue and case
cards share this logic. Native clients and the operation contract do not change.

A card taller than its pane cannot be fully revealed. While it overlaps the pane,
page its evidence without moving the outer pane. If the card is entirely offscreen,
reveal it and page the first unread range in the same press. Measure shown ranges
before revealing so the reveal does not itself count newly exposed content as read.
With no unread content, revealing still requires another press before answering.
Unread presses keep the same status, so wrapping cannot alternate the pane's height
between a paging message and a shorter reveal message.

A cached coordinate index with binary search could also bound the measurements, but
would need invalidation for nested scrolling and reflow. Observer-selected candidates
leave that geometry tracking to the browser and preserve the existing range gate.
