# 0113: Report order outlives the cockpit

Date: 2026-10-18

Leaving a planned run unmounts its cockpit. A report already started by that cockpit keeps running,
but its per-slot write queue and uncertain-command recovery used to disappear. Reopening could send
a pass before an older failure arrived, leaving both results active and the gate blocked.
[Issue #632](https://github.com/endqwerty/mainworthy/issues/632) records the reproduction.

Keep report state outside React in a tab-owned map, separated by project and run and bound to the
existing device session. Each slot retains its write chain, uncertain-command retry, latest confirmed
fill, confirmed snapshot, optimistic generation, and consumed note and step. Recording and undo keep
using the same chain. A later report resolves its predecessor and any uncertain command before
choosing the result it corrects. A new cockpit rereads notes and steps when a report from the earlier
cockpit settles. Presentation, cursor, unrecorded file selection and undo selection stay local.

An invalid session's queues are removed when a cockpit next mounts. Existing session checks still
stop delayed work from writing as another person or restoring cleared browser data. Different runs
and slots do not wait for each other. This queue survives screen navigation in the same tab; a full
reload or a session change ends it.

A localStorage journal, as proposed for the planner, can also survive reloads, but requires storing
and replaying report inputs, attachment data and work not yet sent. Retaining the existing live queue
solves this navigation bug without a second recovery mechanism or a dependency on the planner change.
Refusing delayed failures after receipt would require a new server ordering contract; retaining the
client's chain preserves the existing report operation.

The CLI, iPhone app, registry and archive rebuild do not use this React queue and need no changes.
The demo writes server data and cannot simulate a browser leaving while its report is held.
