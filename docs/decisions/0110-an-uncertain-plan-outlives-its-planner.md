# 0110: An uncertain plan outlives its planner

- Date: 2026-10-18
- Status: proposed

A plan's reply can be lost after the server creates the run. The web planner retained the command for
Retry plan while it stayed open, but Cancel, Escape, another screen, or reload discarded it. Planning
again created a second run. Two synchronous clicks also passed the React state guard before a render.
[Issue #588](https://github.com/endqwerty/mainworthy/issues/588) records both paths.

Save the exact submitted plan, including its command id, in localStorage before sending it. The key uses
the device's existing actor id and the project. Reopening restores the choices and offers Retry plan.
The saved input is parsed with the core PlanInput schema and requires a command id. A ref changes to
sending synchronously, so the next submit cannot send another command before React renders.

Cancel and Escape may close the planner because the command survives outside the component. A readable
success removes only the matching saved command. An operation's `invalid`, `conflict`, or `not_found`
refusal releases the choices, including on a retry: the registry replays a matching recorded command
before running `plan`. The fixed request passes the same input schema, and `plan` records atomically.
An unreadable or lost reply, `internal`, `unauthenticated`, `forbidden`, or `limited` reply keeps the
command saved. These failures can happen before replay. The registry also returns `not_found` before
replay for an unknown operation or a missing project or grant. HTTP can also refuse a missing route.
Those exact replies keep the command.

Discard this plan releases a pending request with a warning that it may already have been recorded.
It does not undo a run. Invalid saved data is removed at the storage boundary and treated as absent.
A planner that discovers another tab's pending request on submit shows its choices and a notice,
then waits for an explicit Retry plan before sending it. Late replies cannot clear another command
or restore data that the person cleared. If the browser cannot save the request, planning stops before
the network write.

Reading the server's command outcome before leaving would also preserve the run, but it adds another
request and a reconciliation flow. Retaining the input uses the existing plan replay contract and the
same device ownership and clearing rules as drafts. The CLI, MCP, native app, and archives do not use
this React component or its lifetime. Their contracts do not change. The demo cannot simulate a lost
browser reply, so its generated data stays the same.
