# Policy

A policy says who must answer each kind of question and what an agent's answer is worth. Its clauses determine how strict a project is.

![Settings with the policy preset, the compare table and the clause table](../ui/screenshots/settings-light.png)

## What a policy is

A policy is a table of clauses. Each clause covers one kind of question: a proposed edit, a test with no case, a failed result, a finding, or closing a run. The clause says who answers, whether they give a reason, and what an agent's answer is worth. Mainworthy reads the clauses of a kind from the top and uses the first one that matches.

[Diagram: who answers a question under a policy](../diagrams/policy-routing.html)

The `when` column holds the conditions a clause tests. `always` matches every question of its kind. Other conditions describe the question:

- `author:agent` matches an edit by an agent.
- `conflict` matches an edit that clashes with a newer version.
- `policy` matches a change to the policy itself.
- `scope:change` matches a failure on a change.
- `hint:disputed` matches two reports that disagree.
- `verdict:passed` matches a run that passed.

`answer:reject` matches only once someone picks that answer. `unlinked:track` and `unlinked:create` test the project's choice for [tests with no case](#tests-with-no-case).

"Who answers" has one of these values:

- A rule. The policy gives its answer at once and records it as a decision. If the answer does not apply to the question, a member is asked instead. A person with the `answer` capability can still overrule a rule's decision.
- A member. A person with the `answer` capability.
- An admin. A person with the `admin` capability.
- A named role, written as `role:approver`. An actor with `answer` and that role on the project, subject to the clause's rules for agents.
- The author. The person who wrote the proposal, or an admin.

A rule that answers an adoption question with `merge` must include `conflict` among its conditions. The merged body becomes a new proposal and follows the ordinary adoption rules. A rule cannot merge a proposal with no conflict. If an older stored rule asks for that, the question stays open for a member instead of creating replacement proposals.

An agent's answer either counts as a decision, is shown as advice for a person to decide, or is refused. The table also says whether a person who produced the evidence may answer, and whether the answer needs a reason.

An unexplained failure with no quarantine cover blocks the runs that count it, under all three presets. The policy decides who may explain it. The `blocks` column says only which runs list a question. A separate setting says whether an explicit CI declaration that no tests are required may pass an empty commit gate.

## Limit agent edits by folder or tag

Custom `adopt` clauses can test `folder:checkout` or `tag:critical` together with `author:agent`. Folder paths are case-insensitive and include descendants, so `folder:checkout` also matches `Checkout/Coupons`. Tags use their stored lower-case names without `#`.

Write predicates in their normalised form. Folder paths use lower case, with no leading or trailing slash, empty segments, or spaces around a segment. Spaces within a name and literal `..` folder names stay. Tags use lower case without surrounding spaces or a leading `#`. Mainworthy refuses a different spelling with `invalid`, naming the clause and its normalised form. For example, write `folder:checkout` instead of `folder:checkout/` or `folder: checkout`.

Folder paths and tags use Unicode NFC and contain no format characters, such as a zero-width space. A predicate that becomes empty after cleaning is invalid. New folder names and tags use the same cleaning. Existing NFD folder names keep their stored spelling. Folder lookup and scope matching normalise those names, so they still match an NFC predicate.

To add a scope restriction, have an instance admin follow these steps:

1. Read the policy with `mainworthy policy show --json` or HTTP `admin policy.show`.
2. Add a clause like the example below after the policy and conflict clauses, before the general adoption clause.
3. Submit the full clause list through `propose` with `op: "policy"` and the policy version you read as `base`.
4. Have an admin accept the policy change in the queue.

```json
{
	"id": "review-checkout-agents",
	"kind": "adopt",
	"when": ["author:agent", "folder:checkout"],
	"ask": { "who": "member", "agents": "none", "notProducer": false, "reason": "optional" },
	"blocks": "nothing"
}
```

This clause holds the whole proposal for a person. Other clauses still decide what happens outside that folder. Replace `folder:checkout` with `tag:critical` to require review for that tag. Keep the policy and conflict clauses before these scope clauses.

Conditions describe the whole proposal, including the current and proposed folders and tags. Moving a case out of a folder or removing its tag still matches its original scope. Folder changes include descendant paths and the tags of cases inside them. A proposal with several edits needs every matching condition somewhere in the proposal, even if different cases supply them. Pending proposals recheck the current folders and tags when shown or answered.

Folder scopes include the combined result of all edits in their given order.
Renaming `Public` to `Checkout` and `Public/Temp` to `Secure` in one proposal matches `folder:checkout/secure`.
This applies to empty folders and to cases created or moved before those renames.
Paths touched between edits also count, even when a later edit changes them again.

The presets do not add scope restrictions. Per-day limits and protection based on who wrote particular content are not available yet. Under `standard`, every agent proposal already waits for a person.

## Read the policy

Open Settings with <kbd>g</kbd> <kbd>,</kbd>, then open Policy. The page shows the preset in force, a short summary, and "Compare the policies". An instance admin also sees the clause table, its settings, and "Edit clauses".

From the command line:

```
$ mainworthy policy show
policy: loose
kind     when                      who answers  agent's answer  blocks   rule's answer
adopt    conflict & answer:reject  author       counts          nothing
adopt    policy                    admin        refused         nothing
adopt    conflict                  author       refused         nothing
adopt    always                    rule         refused         nothing  {"is":"accept"}
map      unlinked:track            rule         refused         nothing  {"is":"track"}
map      unlinked:create           rule         refused         nothing  {"is":"create"}
map      always                    member       counts          nothing
failure  hint:disputed             member       advice          all
failure  scope:change & inherited  rule         refused         change   {"is":"inherited"}
failure  scope:change              member       advice          change
failure  always                    member       advice          release
finding  answer:duplicate          member       counts          nothing
finding  always                    member       advice          nothing
signoff  verdict:passed            rule         refused         nothing  {"is":"approve"}
signoff  always                    member       refused         nothing
basis: exact-or-assumed; flaky hold: 14 days; tests with no case: track; empty reports: pending
```

The last line holds the settings. The basis is which evidence a planned run accepts for a slot by default. The `strict` preset raises the basis to `exact`. The flaky hold is how many days a "Flaky" answer carries forward. The other settings describe tests with no case and empty reports.

## Custom fields

An instance admin can define a project's fields in **Settings**, **Policy**, under **Custom fields**. To define a field, follow these steps:

1. Add a field.
2. Give the field a unique key and a label.
3. Choose **Text** or **Choice**.
4. For a choice, enter one allowed value per line. Values must be nonblank, unique, and fit on one line.
5. If the field needs a value, mark **Required**.
6. Press **Save field definitions** to propose and accept the change.

Both the proposal and the admin's decision stay in the record. Definitions belong to the project and survive a switch of preset. Saving sends the version of the policy read by the browser. A policy change during saving causes a conflict and keeps your field draft. Review the current policy before trying again. If another edit changes the definitions while you type, choose **Reload field definitions** before saving. Reloading replaces your unsaved form with the current definitions.

Field values remain strings in a case's `fields` map. A required value cannot be missing or blank. A nonblank choice value must match an allowed value exactly. An optional field can be absent or blank. Keys without definitions remain free text. Removing a definition leaves all its values in place.

New cases and restores must meet the definitions when proposed and adopted. An edit may keep unchanged values from the current case, including missing required values and choices no longer allowed. Keeping unchanged values lets you edit an older case in the web or iPhone editor without filling newly required fields. Changed field values must meet the definitions, including after a merge or while a proposal waits for acceptance. A refusal leaves the case unchanged. Changing a definition never rewrites existing versions.

Required fields cannot be combined with **Create a case for each test**. Automatic creation has no values for those fields. Choose **Ask in the queue** or **Track without a case** first. Optional definitions work with automatic creation.

The case editor does not edit field values yet. Use canonical Markdown or a `propose` body:

```
$ mainworthy propose --json '{"edits":[{"op":"edit","case":"C-1","base":1,"body":{"fields":{"risk":"high","legacy":"keep this value"}}}]}'
```

A supplied `fields` map replaces the case's map. Include every value you want to keep. Omitting `fields` preserves the base version's values. Use `mainworthy get --json '{"refs":["C-1"],"as":"md"}'` to read them. The ordinary JSON case reply omits custom field values.

To define fields through the CLI or HTTP API, start with `mainworthy policy show --json`. Keep its settings and add a `fields` map, then propose the whole settings object. Use the policy's `version` as `base` in place of `1`:

```
$ mainworthy propose --json '{"edits":[{"op":"policy","base":1,"settings":{"unlinked":"track","emptyReports":"pending","basis":"exact-or-assumed","holds":{"flakyDays":14,"infraThisTargetOnly":true},"fields":{"risk":{"kind":"choice","label":"Risk","required":true,"choices":["low","high"]},"notes":{"kind":"text","label":"Notes","required":false}}}}]}'
```

An admin who is a person accepts the resulting question in Queue or with `decide`. Sending a settings object without `fields` preserves the current definitions. Send `"fields": {}` to remove every definition explicitly. The MCP tool listing omits field definitions to keep its token limit. To change definitions, use the CLI, HTTP API, or Settings. Archives include the policy versions, values, proposals, and decisions.

## The three presets

`loose` is the default. Ordinary case edits take effect at once. A test needs no case. A rule excuses a failure already present on the base while its evidence holds. A person answers other failures and findings. A run that passed closes by itself.

`standard` holds an agent's edit for a person. A person's own edit still takes effect at once. A test needs no case. Two reports that disagree go to a person who did not produce either one.

`strict` requires a person and a reason for ordinary case edits, failures, findings and closing passed runs. It starts by asking about tests with no case too, but you can choose to track them instead. No agent gives a counted answer, except to reject its own conflicting proposal. Custom clauses can require a named role. Two-person approval, frozen evidence, gap waivers and a regulated preset are not built yet.

All three send a change to the policy to an admin, and send a conflicting edit back to its author. The presets differ most in what they ask of people. This table is built from the presets themselves and shows who answers each question.

<!-- generated:policy-presets -->

| Preset | In short |
| --- | --- |
| `loose` | Edits to cases take effect at once and a test needs no case. A failure already present on the base is excused by rule while its evidence holds. A person answers other failures and findings, and a run that passed closes by itself. |
| `standard` | An agent's edit waits for a person. A person's own edit still takes effect at once, and a test needs no case. |
| `strict` | A person, never an agent, answers every edit, test with no case, failure, finding and passed run, and gives a reason. The project can have its tests with no case tracked instead. A policy change and a conflicting edit are handled as under the other presets. Custom clauses can require a named role. Approval by two people is not built yet. |

Who answers each question:

| Question | `loose` | `standard` | `strict` |
| --- | --- | --- | --- |
| A person's edit to a case | By rule: Accept | By rule: Accept | A person, with a reason |
| An agent's edit to a case | By rule: Accept | A person | A person, with a reason |
| A test with no case | By rule: Track without a case | By rule: Track without a case | A person, with a reason |
| A failed result | A person; agents advise | A person; agents advise | A person who did not report it, with a reason |
| A test already failing on the base | By rule: Already failing on base | A person; agents advise | A person who did not report it, with a reason |
| A result that two reports disagree on | A person; agents advise | A person who did not report it | A person who did not report it, with a reason |
| A finding | A person; agents advise. Duplicate: a person or an agent | A person; agents advise | A person, with a reason |
| Closing a run that passed | By rule: Approve | By rule: Approve | A person, with a reason |
| An edit that conflicts with a newer version | Its author if a person, or an admin. Reject: its author (person or agent), or an admin | Its author if a person, or an admin. Reject: its author (person or agent), or an admin | Its author if a person, or an admin. Reject: its author (person or agent), or an admin |
| A change to the policy | An admin, not an agent | An admin, not an agent | An admin, not an agent |
| How long a `flaky` answer carries forward | 14 days | 14 days | 14 days |
| What fills a slot of a planned run | Also a result assumed to be for the current version | Also a result assumed to be for the current version | Only a result that names the pinned version |
| An empty report | `pending` | `pending` | `pending` |

<!-- /generated -->

## Tests with no case

A pipeline reports tests that no case names. What happens to them is one choice for the whole project, apart from the preset.

| Choice | What happens |
| --- | --- |
| Track without a case (`track`) | The tests are kept without cases and nobody is asked. They still gate the build. `loose` and `standard` start here. |
| Create a case for each test (`create`) | Each test gets a case named after it and is linked to that case. The case's folder is named after the directory of the test's file. Nobody is asked. |
| Ask in the queue (`ask`) | Each file with such tests is one question in the queue. It blocks nothing. `strict` starts here. |

In Settings, open Policy and choose under "Tests with no case". From the command line:

```
$ mainworthy policy tests create
tests with no case: create; proposal P-3 and decision 4 are both recorded; 12 open questions answered by the rule
```

The change is a proposal and a decision like any policy change, so it needs `produce` and `admin` on the project. It takes effect for the questions that are already open. The rule answers every open question about a file at once, and the line above says how many. A question that a person took back from the rule stays with people.

`create` makes cases the way a person's edit does, so it works where the policy adopts a pipeline's new case by rule. `strict` has a person adopt every new case, and refuses `create`:

```
invalid: under this policy a person adopts every new case, so a rule cannot create cases for tests: choose ask or track
```

A custom policy that rejects a pipeline's new cases by rule also refuses `create`. A rule must answer `accept` to create and link cases automatically. A person who answers a file's question with `create` needs the same acceptance rule for their own new cases. Otherwise the answer is refused and the question stays open, with no create decision or links recorded.

Under `create`, anyone who can report results can add cases, one for each test name they send. A report still cannot change or remove a case. Under `standard` an agent's report is the exception. An agent's new case waits for a person, so the rule makes none and the file's question stays open.

A link holds for the tests it names. When another test turns up in the same file, Mainworthy asks about or creates a case for only the new test. A "track" answer covers the file as it was. Mainworthy checks the file again when its tests with no case change. Under `track` the rule answers again and you see no question.

A custom policy reads the choice only if its clauses test `unlinked:track` or `unlinked:create`. Settings offers the choice under a preset.

## Reports with no tests

Every preset starts with `emptyReports: "pending"`. A commit without counted evidence stays pending, even when CI says no tests are required.

For a pipeline that legitimately runs no tests, such as a docs-only change, an admin can enable an explicit declaration:

```sh
$ mainworthy policy empty nothing-required
empty reports: nothing-required; proposal P-4 and decision 5 are both recorded
```

This uses the same proposal and admin decision as other policy changes. It requires `produce` and `admin` on the project. Settings has no control for this setting. To restore the default, run `mainworthy policy empty pending`. Choosing any preset also restores `pending`, and resets the same-code detector settings to their defaults.

With the setting enabled, a CI actor sends `mainworthy report --nothing-required`, with the tested commit supplied or detected. The declaration stays in the report record. A human or agent token cannot send it. An empty JUnit file alone is not a declaration.

The exception passes only a commit gate with an applied declaration and no ordinary reports for that commit and repository. A skipped, blocked, refused, or agent-only report prevents the exception, in any job or environment. An empty declaration cannot hide an existing failure. It never fills a planned run's case slot or required job. Missing reports stay pending.

The setting applies to recorded declarations too. Disabling it returns an otherwise empty gate to pending. An upload receipt remains the verdict at upload time. Use `mainworthy gate` to read the current verdict.

The API policy edit is `{"op":"policy","emptyReports":"nothing-required"}`. The report is `{"target":{"commit":"1111111111111111111111111111111111111111"},"results":[],"nothingRequired":true}`.

## Switch the policy

To switch presets in Settings, follow these steps:

1. Open Settings, then Policy.
2. Choose a preset in "Preset".

The switch "Agent edits need a person" is a shortcut. It flips between `loose` and `standard`. It is hidden while the policy is `custom`.

If another policy change wins while you choose a preset or the tests-with-no-case setting, Settings asks you to review the current policy and choose again.

From the command line:

```
$ mainworthy policy use standard
policy: standard; proposal P-1 and decision 1 are both recorded
```

To switch, you need `produce` on the project to propose the change and `admin` on the project to accept it. A switch is a proposal, and accepting it is a decision. Both stay in the record, and you can find them in Queue under "Settled". No agent can accept one, whatever its grant says.

If you cannot accept it yourself, the proposal stays open for an admin:

```
$ mainworthy policy use strict
policy proposal P-2: open Q-2 needs an admin
```

An admin finds it in Queue under "Proposals". Reading the clause table needs `admin` on every project. Switching needs `admin` only on the project being changed.

If the command attempts to accept the proposal and the server refuses, it exits 4 with the server's status and requirement.
`forbidden` means the policy does not let you accept it, `invalid` means the answer needs correcting, and `conflict` means the evidence or decision changed.
With `--json`, the recorded proposal and decision reply remain on stdout.

A policy change rewrites nothing that is recorded. Results, decisions and cases stay as they were. What changes is who may answer, whether a reason is needed, and whether an empty declaration passes. The new policy applies to future and open questions. Each open question waits for whoever the new policy names. Automatic inherited excuses are reconsidered immediately in both directions. A switch to `standard` ends them, and a switch back to `loose` restores eligible excuses without another report. The new policy's rules answer eligible open questions immediately, including sign-offs for passing planned runs, pending proposals and questions about [tests with no case](#tests-with-no-case). Under `create`, the rule also makes their cases. Questions a person withdrew or answered against the rule stay with people while that evidence holds. A cause question leaves Queue when inherited excuses remove every failure it was blocking. A cause that still blocks a run stays open.


## Change single clauses

In Settings, open Policy and choose "Edit clauses". The clause editor needs a person with instance `admin` to read the full policy, and `produce` on the project. A project admin can still use the existing preset and tests-with-no-case controls.

To edit the policy, follow these steps:

1. Edit the clause's conditions, who may answer, agent permissions, reason requirement, producer restriction, or which runs list the question. Write conditions one per line. For a rule, write its answer as JSON, for example `{"is":"accept"}`.
2. Add, remove, or move clauses with the row controls. The first matching clause wins. Each kind must end with a clause whose only condition is `always`.
3. Set the flaky hold, evidence basis, and infrastructure hold below the table. The draft keeps the current choice for tests with no case.
4. Choose "Preview recent questions" to compare the draft with the policy in force when you opened the editor. The sample contains up to 20 open questions in queue order and 20 most recently settled questions. Each question shows matching for its current facts and its applicable answer choices.
5. Give a policy change reason.
6. Choose "Apply policy". Mainworthy records the proposal and its accepting decision through the same operations as a preset switch.

Invalid conditions, duplicate clause ids, invalid rule answers, missing final `always` clauses, and holds outside 1 to 365 days prevent preview and apply. Preview reads questions without changing the policy or recording decisions. It shows clause matching, who may answer, rule answers, and which runs list the question. It does not replay decisions, check a particular person's permissions, execute rules, or predict a gate result. Existing decisions stay recorded. Hold and basis changes affect future decisions and runs.

A refused request keeps your draft in the open editor. If the policy changes while you edit, a notice marks your opened version as out of date. Apply sends that version, and the server refuses a stale proposal or acceptance. To start from the current policy, cancel and reopen the editor. A waiting proposal cannot replace a newer policy when accepted later. Cancel discards the draft. Leaving Settings or reloading also discards it.

A conflict during acceptance leaves the proposal's adoption question open in Queue. Reject that question before sending a replacement, including after a failed save in Settings. A waiting proposal made before policy versions also needs rejection and a new proposal from the current policy.

From the command line, send a policy edit to `mainworthy propose`. The edit carries the whole clause list. Start from what `mainworthy policy show --json` prints, change a clause, and send the list back. Include the policy's `version` as `base` when sending clauses or settings.

Send only one policy edit per proposal. Combine its clause and setting changes in that edit. MCP has no tool to read the policy version. Before using MCP `propose` with clauses or settings, read it through `mainworthy policy show --json` or the HTTP `admin` operation with `{"do":"policy.show","project":"<key>"}`. The read requires instance admin. If neither is available, ask an instance admin for the current policy and version. Do not guess `base`.

This example shortens the flaky hold to 7 days. Replace `[...]` with your full clause list, including the changed clause if you also want to require reasons for findings.

```
$ mainworthy propose --json '{"edits":[{"op":"policy","base":1,"preset":"standard","clauses":[...],"settings":{"unlinked":"track","emptyReports":"pending","basis":"exact-or-assumed","holds":{"flakyDays":7,"infraThisTargetOnly":true}}}]}'
{"proposal":"P-9","question":"Q-9","conflicts":[],"status":"open","needs":"an admin","cases":[]}
```

Use the version you read in place of `1`. Preset-only, `unlinked` and `emptyReports` edits may omit `base`. The proposal records the policy version current when it is made. An admin accepts it like any policy change. Mainworthy refuses a policy in which some kind of question has no last clause that matches `always`:

```
invalid: every kind must end with a clause that always matches; missing for: finding
```

It also refuses a rule clause whose answer its kind of question does not accept, such as `{"is":"approve"}` for a map question, and names the clause:

```
invalid: Clause map-track needs a valid map rule answer.
```

The same check runs when a proposal is accepted, so a waiting proposal that holds such a clause (one made before the check, or restored from an archive) is answered `invalid` with that message and the policy stays. An archive whose policy in force fails these checks is refused whole on import, naming the project and the clause; earlier policy versions in it are history and are not checked.

The settings are sent whole: `unlinked`, `emptyReports`, the basis, the holds, custom field definitions in `fields`, and `flakyDetection`.
Omitting `emptyReports` selects `pending`. Omitting `fields` keeps the current definitions. Send `"fields": {}` to remove them. Omitting `flakyDetection` selects its defaults.
The flaky hold takes 1 to 365 days. `infraThisTargetOnly` is true when an "Infrastructure" answer covers only the build it was given for.

## Same-code detector settings

Settings, Policy shows the detector's current values below the clause table.
`mainworthy policy show --json` includes them in `settings.flakyDetection`.
Every preset starts with detection enabled, a 14-day window, and a threshold of
two outcome changes per test and failure signature. A file-split signature has its
own count, separate from the original cause.

To change the detector settings, follow these steps:

1. Read the current policy with `mainworthy policy show --json`.
2. Change the detector values and keep the other settings as they are.
3. Use the `version` you read as `base` in place of `1`.
4. Send the policy edit through `mainworthy propose --json`.
5. Have an admin accept the policy question.

This example uses the other defaults:

```json
{"edits":[{"op":"policy","base":1,"settings":{"unlinked":"track","emptyReports":"pending","basis":"exact-or-assumed","holds":{"flakyDays":14,"infraThisTargetOnly":true},"flakyDetection":{"enabled":true,"windowDays":7,"minFlips":3}}}]}
```

`windowDays` accepts 1 to 365 days, and `minFlips` accepts 1 to 100.
`enabled: false` hides current detector suggestions without deleting observations.
Changing these values affects current test-detail reads and future failure-question
occurrences. Existing questions keep the snapshot recorded with their evidence.
Omitting `flakyDetection` from a whole-settings edit selects its defaults.

These settings control suggestions only. They do not change `holds.flakyDays`,
which controls how long a person's `flaky` answer carries forward. Infrastructure
and timeout observations have their own counts and never raise the assertion count.
See [report results](./report-results.md#preserve-attempts-and-retries) for what a flip counts.

Quarantine is separate from the flaky hold and detector thresholds. Its proposal
always asks a person with answer authority and a reason, including under `loose`.
The quarantine list appears below the detector settings. See
[quarantine an unreliable test](./report-results.md#quarantine-an-unreliable-test)
for entry and exit rules.

## What custom means

A policy is `custom` when its clauses are not exactly those of a preset. The stored policy can keep a preset's name after you edit its clauses. Mainworthy therefore compares the clauses rather than the name. Settings and `mainworthy policy show` display `custom`. Settings hides the preset summary, the compare table's marked column, and the switch between two presets. Choosing a preset in "Preset", or using `mainworthy policy use`, replaces every clause with that preset's.

## Choose a preset for a new project

Choose the first policy when you create a project. In Settings, open Projects and pick "Initial policy" under "Create a project". The initial policy defaults to `loose`. You can switch later without migrating anything. Choose a preset to match your review needs:

- Start with `loose` when one person or a small trusted team writes the cases, and ordinary edits should take effect at once.
- Use `standard` when agents propose edits and a person should read each one first.
- Use `strict` when each answer needs a person and a recorded reason, for example when someone else audits the queue.

Whether each test needs a case is a separate choice. Leave it at "Track without a case" when the cases describe what people check and the pipeline's tests stand beside them. Choose "Create a case for each test" when every test should appear in the suite. Choose "Ask in the queue" when someone links each file's tests by hand.

A policy belongs to one project. A team can run a `loose` scratch project and a `strict` release project on one instance.

## Require a named role

Give a reviewer the `approver` role as described in [People, agents and pipelines](./access.md#named-roles).
In a custom policy, set the clause's `ask` to:

```json
{
	"who": "role:approver",
	"agents": "none",
	"notProducer": true,
	"reason": "required"
}
```

Read the current version with `admin` action `policy.show`. Include that version as `base` alongside the full clause list in a `propose` policy edit.
Have an admin accept that proposal under the current policy.
A proposal and its acceptance are refused if a role clause has no eligible holder in the project.
Assign the role first to an actor with `produce` and `answer` whose kind the clause permits to answer.
Roles come from personal grants, while teams can supply the required capabilities. Team membership alone gives no named role.
A role on another project does not count. Removing the last holder after adoption can leave questions waiting until an admin assigns the role again.
While no eligible holder exists, every policy proposal that keeps the role clause is refused, including settings-only edits.
Assign an eligible holder again or remove the role clause in the proposal.
The clause editor preserves existing role selectors. Introduce a new role selector through a policy proposal in the API or CLI.
Use this `ask` on an adoption clause to require a reviewer who did not write the proposal.
The reviewer opens the question and answers with a reason. Someone without the role gets `forbidden`. A blank reason gets `invalid`.
The queue says which role is needed. The same check applies to the web UI, iPhone app, CLI, API and MCP.
An admin has no implicit role. A role does not override `notProducer` or the clause's rules for agents.
An agent can hold a role, and its answer counts with `agents: "answer"` when it meets the other conditions.
Use `agents: "none"` when the sign-off must come from a person.

This is one-person role approval. Mainworthy does not yet collect two independent approvals, freeze evidence, or waive coverage gaps.
It makes no certification claim.

## See also

- [People, agents and pipelines](./access.md) for who holds `answer` and `admin`.
- [Let an agent in](./agents.md#what-agent-work-is-worth) for what an agent's work is worth under each preset.
- [Decide in the queue](./decide.md) for answering a question.
