# Planned runs

Choose cases for a run, record results against their pinned versions, and close
the run with a verdict. Let CI results fill slots so you do not repeat completed work.

![A planned run with CI results, unfilled slots, and the selected case](../ui/screenshots/runs-light.png)

## Find a run

Runs (<kbd>g</kbd> <kbd>r</kbd>) lists every run of the project, newest first.
A planned run is one somebody planned, as this page describes.
A change run is the one Mainworthy makes for each commit a report names; its name is the
commit and the change or branch it is on, such as `58fbc1c on pr:482`.
Each row shows the verdict, the slot count of a planned run, and how long ago the run was made.

Choose **Planned** or **Change** to see one kind, and **Open** or **Closed** to see one state.
Select a planned run and press <kbd>Enter</kbd> to open its cockpit.
Select a change run to see its commit, its change, and every result its gate counted, with the
same filters as a change's results. Press <kbd>Enter</kbd> to open its change.

From the command line, `mainworthy find --in runs` lists the same runs. Add `--origin planned` or
`--origin change` for one kind, and `--state open` or `--state closed` for one state.

## Plan a run in the web app

To plan a run, follow these steps.

1. Press <kbd>g</kbd> <kbd>r</kbd> to open Runs.
2. Press <kbd>n</kbd>.
3. Enter a "Run name".
4. Choose "All active cases", "By folder", "By tag", or "By search" under "Cases".
5. If your selection needs a folder, tag, or search text, enter that value.
6. Choose which results the run accepts.
7. Choose "Plan run".

The planner counts the active cases the run selects. Shared-step fragments are excluded,
including when a folder, tag, or search matches only fragments. A run selection is limited
to 20,000 cases. Narrow a larger selection by folder, tag, or search.
The API can preview the same selection with `find` and `{"in":"cases","select":{}}`.
When `select.cases` names a case more than once, the preview and plan count it once.
Without folder, tag, or search criteria, an explicit case list keeps the order of first appearance.
If you open another screen while planning finishes, the run is recorded and you stay on that screen.
Before sending a plan, the browser keeps the request for your signed-in account and project on this device.
If the reply is lost or unreadable, the planner locks and dims your submitted choices.
Choose **Retry plan** or press <kbd>Enter</kbd> to resend the same request without creating a second run.
**Cancel** and <kbd>Esc</kbd> close the planner and keep the request while its outcome is unknown.
After closing the planner, visiting another screen or project, or reloading the page, reopen the planner
in the same project to retry. A readable success clears the request.
A session change, permission refusal, rate limit, or server error also keeps it.
If the operation refuses the request, the planner shows the reason and unlocks your choices for correction,
even after a retry. The server replays a recorded request before running the operation again.
If the project is missing or you no longer have a grant on it, the request stays available to retry.
To release a request whose outcome is unknown, choose **Discard this plan**. The plan may already have
been recorded. Discarding the saved request does not undo a run.
If another tab saved a plan while you were typing, submitting first shows that plan and a notice.
Choose **Retry plan** to send the displayed request.
Invalid or older-format saved requests are removed and do not prevent a fresh plan.
The browser must be able to save the request before it sends a plan. Clearing this site's browser data
or signing out with **Sign out and clear browser data** removes any request still kept on this device.
"Count only results recorded in this run" accepts work explicitly reported to the run.
"Accept results for a commit" also accepts qualifying results already reported for
that commit and results that arrive later. Enter the tested commit's hash.

A run planned for a commit counts one commit.
When you plan the run, Mainworthy resolves an abbreviated hash against known commits.
If the commit is not known yet, use the full hash your pipeline will report.
Mainworthy refuses an ambiguous abbreviation.

[Diagram: a planned run from plan to close](../diagrams/planned-run.html)

## Understand what each slot requests

When you plan the run, each selected case gets a slot pinned to its current version.
Editing, moving, or archiving the case later does not change that slot's version.
To exercise the selected version, read the pinned document in the run.

By default, a run asks for a person or an automated test, with one passing actor.
It accepts exact or assumed evidence under `loose` and `standard`.
Under `strict`, the default requires exact evidence.
A run can ask for other methods or two distinct passing actors through the CLI or API.

A person's result counts when the pinned case admits people.
An automated test counts when its link or annotation identifies the case and the
result meets the run's version rule.
An agent counts only when the run asks for agents and the pinned case admits them.
An agent's review is not a runtime pass. See [agents](./agents.md).

The web planner uses these policy defaults. It does not yet offer controls for
custom method requirements, required jobs, or actor assignments.
Use [the CLI](./cli.md) or [the API](./api.md) for those settings.

## Record results by hand

To record a result, follow these steps.

1. Select an unfilled slot.
2. Exercise the pinned case's steps.
3. Press the key for the outcome.

<kbd>p</kbd> records "Pass". <kbd>b</kbd> records "Blocked".
<kbd>s</kbd> records "Skip". These keys move you to the next missing slot.
To record a failure, follow these steps.

1. Press <kbd>f</kbd> to focus "Result note".
2. Enter the failure details.
3. Press <kbd>Enter</kbd> to record "Fail" and move on.

While the note has the focus, the outcome keys type letters and <kbd>Enter</kbd> records
"Fail". To record another outcome with a note, follow these steps.

1. Type the note.
2. Press <kbd>Esc</kbd> to leave the field.
3. Press the outcome key.

Type a step number before <kbd>f</kbd> to mark the failed step.
Use <kbd>j</kbd> and <kbd>k</kbd> to move between slots.
If browser storage is available, the run keeps unfinished notes on this device until the server records the result.
If a report's reply is lost, unreadable, interrupted by an internal server error, or arrives after
you sign in again, the page keeps its outcome unknown and checks the original command.
A command that has begun but not finished is sent again under the same ID.
If the check fails, keep the page open and press a result key on that slot to check again.
The original result and note are recovered before another result can be recorded.
Before recording the result, paste a screenshot into **Result note** or choose **Attach a file**.
Pending files stay with their slot while you move between slots.
Closing or reloading the page discards pending files. A saved result shows its images and file
downloads. Each file may be at most 4 MiB, and a result may hold 20 files and 16 MiB.
See [attachments](./report-results.md#attach-screenshots-and-small-files) for report
uploads, access, and retention.

See [the keyboard guide](./keyboard.md) for all run keys.

Blocked and skipped results record that the case was not proven. They do not satisfy
a slot, and a run with missing proof stays `pending`.
A failure opens a question. Answer it in [Queue](./decide.md).

Press <kbd>u</kbd> to correct the last result while the run remains open.
Undo waits for pending reports and restores the previous recorded outcome, note, failed step,
and attachments. A refused report cannot become the outcome restored by undo.
If there was no previous recorded result, the correction is a skip. Both results stay recorded.
Undo targets only the result recorded by this page. If another tab has replaced it, the page
reports that it changed and leaves the newer result in place.
The web app requires you to reopen a closed run before recording or correcting results.
The reporting operation also accepts late results for closed runs that accept a commit.

## Let CI fill the run

A run that accepts a commit can use linked test results for that same commit.
Evidence already recorded fills qualifying slots when you plan the run.
Later reports fill qualifying slots even after a commit run closes.
The result must meet the slot's pinned version, method, and basis requirements.

An assumed result cannot fill a slot that requires an exact basis.
A pass on another case version does not count just because the title is unchanged.
See [report results](./report-results.md#read-the-results-basis).

The web app leaves slots filled by another producer for that producer's evidence, unless the
slot is still missing a required person. Another admitted person can then record their result.
The result controls and <kbd>j</kbd>/<kbd>k</kbd> navigation include those slots.

## Require CI jobs

Add named jobs when the run must receive reports from all parts of a pipeline.
Each required job needs an applied pipeline report that ran something.
A report containing only skipped or blocked results does not meet the requirement.
Only results that their producer has not corrected count toward a required job.
Correcting its last decisive automated result to skipped or blocked makes the job missing again,
including in runs planned after the correction. A closed run reopens and reconsiders its sign-off.
An agent's report under the same job name does not meet it either.
A `nothingRequired` declaration never satisfies a required job or a case slot.
That restriction applies even when the project's policy allows an empty commit gate to pass.
A run that counts only its own results cannot require CI jobs.

Use this CLI form for one case, one commit, and a required `tests` job:

```sh
$ mainworthy plan --json '{"name":"Checkout CI","select":{"cases":["C-1"]},"accepts":{"commit":"1111111111111111111111111111111111111111"},"require":[{"id":"exercise","kind":"exercise","methods":["human","auto"],"minActors":1,"basis":"exact"},{"id":"jobs","kind":"jobs","jobs":["tests"]}]}'
```

Match the job name to the report's detected job or explicit `--job` value.
A required job is separate from the evidence each case slot needs.

## Resolve a disputed slot

A counted pass and a counted fail from different producers make a slot disputed.
A later write from another producer does not silently replace the disagreement.
To settle the dispute, open the slot's separate "Disputed" question in Queue.
Choose the appropriate failure answer.
Each slot, cause, and scope has its own question. An earlier answer about the cause
continues to apply elsewhere, but does not settle this slot. The order of that
answer and the contradictory result makes no difference.

A settlement applies to the named failures in this slot. Another run that counts
the same results needs its own settlement. A later effective result from a person
or pipeline renews the question. An agent's report never renews or ends a person's
settlement, even if its attempt or outcome changes. While the scope and evidence from people and pipelines stay the same, the classification covers later agent failures of that cause in this slot.
A different cause needs its own settlement. Withdrawing or expiring an answer leaves
this slot disputed again.
Neither action withdraws the cause's answer or changes an unrelated commit gate.

"The failure was a mistake" judges the named results themselves. They stop counting
in their commit gate and every open run that admitted them. This answer therefore
has effects beyond the selected slot. A new failure reported later needs a new answer.

Under `standard` and `strict`, a person who produced the disputed evidence cannot
settle that dispute. See [policy](./policy.md).
The same retry rules used by commit gates apply to results within each producer's
job and target. See [report results](./report-results.md#preserve-attempts-and-retries).

## Close and reopen a run

When a planned run passes, Mainworthy raises a sign-off question.
Under `loose` and `standard`, a recorded rule normally approves and closes it.
Under `strict`, an authorized person approves with a reason in Queue.
Rejecting sign-off leaves the run open. You cannot approve a run that no longer passes.

A run that accepts a commit keeps receiving qualifying results after it closes,
including reports that name the run. While a report waits for the server to apply it, the run's gate
is `pending`. Once the server applies all accepted reports, Mainworthy asks for sign-off
again if a report added or corrected qualifying results in the run.
Reports that change neither qualifying slot results nor required-job evidence leave the run's approval in place.
That includes reports for repositories or environments the run excludes.
The ledger keeps the replaced approval and records that it no longer holds.
A passing run can close again under its policy.
A run with missing proof or unexplained failures stays open and cannot be approved.

A run that counts only results recorded in it takes no more results after closing.
To reopen the run, follow these steps.

1. Find the run's sign-off in Queue's "Settled" view.
2. Withdraw that approval.

Newer decisions and the current policy still control who may withdraw it.

## Plan a run from the command line

```sh
$ mainworthy plan --json '{"name":"Checkout smoke","select":{"tags":["checkout"]}}'
```

The reply names the run, its slot count, and how many slots evidence already filled.
Use `mainworthy gate --run R-2` to read its verdict.
See [the CLI guide](./cli.md) for selection, methods, assignments, and other plan inputs.

## Plan a release run

Plan a release run after a successful deployment.

1. From the deploy step, announce the build label, artifact digest, and source commit. Use a pipeline token or a human admin's token.
2. Plan a run that accepts the build.

For example, use these commands:

```sh
$ mainworthy announce --deploy 1.4-rc3 --env staging --digest sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --repo acme/web --commit 1111111111111111111111111111111111111111 --cmd deploy-staging-rc3-1
$ mainworthy plan --json '{"name":"Release smoke","select":{"tags":["smoke"]},"accepts":{"build":"1.4-rc3","env":"staging"}}'
```

The plan reply gives a run ref. To record and check the release evidence, follow these steps.

1. Report against the artifact.
2. Check the release gate with the returned run ref.

For example, use these commands:

```sh
$ mainworthy report smoke.xml --build 1.4-rc3 --env staging
$ mainworthy gate --run R-2
```

Use the artifact's actual SHA-256 digest and the full source commit. For an artifact
built from several repositories, send `code` as an array of `{repo, commit}` through
`announce --json`. Mainworthy records who attests the source and when. It trusts
that caller's statement and does not validate an external provenance signature.

Once bound, a build label cannot name a different digest. To announce another
deployment of that build, supply `--deploy`, `--env`, and a new `--cmd`. Retrying an
unchanged request with the same `cmd` records nothing twice. Use
`mainworthy find --in deployments` to read deployment history and the attestation.
The newest announcements come first, with a cursor for the next page.

When a report target or plan names an environment, announce that build label there
first. Otherwise Mainworthy returns `invalid` and lists the environments where that label was deployed. A deployment under another label does not qualify that label.

A release run counts the exact artifact digest and its selected environment.
Omit `env` from the plan to accept that artifact in any environment. Two labels
bound to the same digest name the same artifact. Existing qualifying results fill
slots at planning time, and reports arriving while the run is open fill them too.
If you deploy the selected label to another environment later, results already
recorded there for the same digest can fill a new run. Those results can come from reports under
another deployed label. Results need not postdate the deployment announcement.
A refused report stores no results. After announcing its deployment, send it again.
Results from an attested source commit do not count as artifact execution.

Open the run in the web app to record manual results against its pinned cases.
Recording by run alone uses that run's build and environment.
MCP's report schema omits the build target. To report through MCP, supply a planned run in `run`.
A gate with missing evidence stays pending. Failures and sign-off use the same rules as other
planned runs. The web and iPhone planners do not yet offer a build picker.
