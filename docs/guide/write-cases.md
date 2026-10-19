# Write cases

Write cases as outlines, keep their versions, and resolve edits that overlap.
Use folders, tags, and search to find the cases you need.

Search applies the active or archived state, folder and tags before limiting matches.
Archived matches cannot hide an active case. A search with at most 2,000 matching
cases reports the full count for those filters, independent of the page size.

Suite keeps loading the rest of the list while new results and edits arrive,
and shows live changes without a reload. A tag or move still being sent stays visible
when live updates arrive. If the write fails, only that pending change disappears.
A confirmed later move replaces an earlier pending move of the same case.

![Suite with cases, folders, tags, and the selected case](../ui/screenshots/suite-light.png)

## Capture a case

Create a case in Suite with the outline editor.

1. Open Suite with <kbd>g</kbd> <kbd>s</kbd>.
2. Press <kbd>c</kbd>.
3. Type the title.
4. Press <kbd>Enter</kbd> to start the first step.
5. Type an action and its expected result, separated by ` > `.
6. Press <kbd>Enter</kbd> for the next step.
7. Press <kbd>Escape</kbd> to record the case and leave the editor.

Use <kbd>Tab</kbd> to move to the expected result field.
Fields grow and shrink to fit their text, including when the case pane changes width.
Press <kbd>Shift</kbd> <kbd>Enter</kbd> to record this case and start another.
The [keyboard guide](./keyboard.md) lists the remaining editor keys.

## Use the outline grammar

Put tags in the title with `#tag`. A space separates the tag from the title text.
Mainworthy removes recognized tags from the title and keeps them as tags.

```text
Checkout applies a percentage coupon #checkout #regression
  Open the cart with one $100.00 item
  Apply coupon SAVE10 > Total shows $90.00
  Reload the page > Coupon is still applied
```

When you paste a whole outline, indent the steps or start each with a list marker.
An unmarked first line is a title only when every following line is indented or marked.
A Markdown heading such as `# Coupon checkout` makes the title explicit.

You can paste numbered lists, bullet lists, or checkbox lists. Mainworthy removes
recognized list markers and splits each action from its expected result.
A more deeply indented line continues the previous step's expected result.
A separate line beginning with `>` or `Expected:` also continues the previous step's expected result.

You can paste two columns from a spreadsheet, with an action and an expected result.
Markdown tables work too. Mainworthy omits a header followed by a separator row.
A numeric first column can supply step numbers without becoming action text.

## Know what is saved

While you type, the editor keeps a private draft on this device.
A new draft shows "Private, no version yet". For an existing case, others still see
the recorded version named beside your draft. The timeline names the version your draft is based on,
which can be older if someone else records a version while you type.

The editor submits a changed draft when you leave or pause for 30 seconds.
To submit sooner, press <kbd>Cmd</kbd> <kbd>Enter</kbd> on macOS or <kbd>Ctrl</kbd> <kbd>Enter</kbd> elsewhere.
The policy then decides whether the proposal becomes current or waits for review.
If you open another screen while a save finishes, its reply leaves you on the screen you chose.
Returning to Suite shows the recorded case without its old draft row.
Changing the filter while a new case saves keeps the filter and gives the case its address when the save finishes.
A delayed save reply keeps any newer version the page has already received.
There is no save button. Moving the caret or selecting text while a save finishes
does not submit the text again. Text waiting for review stays in its proposal.
When a new case proposal is accepted, its draft follows the case and version that acceptance recorded.
Continuing the draft edits that case. Text typed while the proposal waits stays in your draft.
Submitting while the question is open sends nothing new. After acceptance, leave the editor again to submit that text.
If reading the waiting question fails, the draft keeps its link to the proposal and tries that read again on the next submission.
If the case updates before you edit, your next edit starts from the newer version.
While you edit, the folder and tags follow changes made elsewhere. Tags you add in
the editor appear alongside those live tags. Saving changes only the tags you added
or removed, and keeps unrelated tag changes.
Your typed text stays on the version you started from.

The editor records a step once the step has an action.
A step with an expected result but no action stays in your draft on this device, including after a reload.
The recorded version excludes that step.
To record the step, type its action and leave the editor again.
To discard the step, remove it and leave the editor again.
A new draft is discarded on leave only when all its text, tags, and requirement links are empty.
An expected result or precondition keeps the draft even when its title and actions are blank.
Leaving a new draft that holds only an expected result records an untitled case with no steps, subject to the policy.
The expected result stays in your draft until you add an action.

Emptying the action of a recorded step removes the step from the next version.
Its expected result, if it has one, stays in your draft in the same way.
If someone else records that step again while yours still has no action, their step replaces the step in your draft.
If your expected result differs from theirs, your expected result stays in your draft as a new step.

If a reload, a closed tab, a lost connection, an internal server error, or signing in again
interrupts a save's reply, the page keeps that save's command. Submitting again or reopening
the draft asks the server about the same save. If the save made a version, the status line
says "Your last save is recorded as version N". The page does not send that save again.
If the server has not recorded it yet, the save may still be on its way. The page sends the same
save again, and the server records it once, however many copies arrive.
In either case, the editor sends any text you typed after that save when you leave the editor.
After a reload or reopening a closed tab, you can select text while the server replies.
Later text stays on the version that save made.
A tab closed before the reply arrives sends nothing more. The draft stays on this device.
When you open the draft again, the page asks the server about the save.

The draft status says "Draft, saved on this device" when device storage works.
If storage is unavailable, it says "Draft, kept in this tab". Keep that tab open
until a version is recorded. Drafts do not sync between devices.

[Diagram: the life of a case](../diagrams/case-lifecycle.html)

## Edit in one window at a time

A draft belongs to the window that is editing it. Another window that opens the same draft shows it
read-only, with "This case is being edited in another window" and "Take over here".
To move the draft to your current window, choose "Take over here".
The draft opens with its text and any conflict card. The first window becomes read-only.
If its last save has not been confirmed, the new window asks the server what became of it.
A save still on its way is retried unchanged and recorded once. Later text becomes the next version
when you leave the editor. If the answer is lost, the draft keeps that save and asks again when you leave.

If two windows start typing at the same time, one can win ownership after the other has accepted text.
The losing text stays in a separate copy on this device. **Preserved text** shows the copy below the ownership
message, including its tags, requirement links, and any typed merge.
After taking over, copy the text you need into the editor. The copy survives a reload or closing the window.
Mainworthy keeps the copy until one of these events occurs.

- You choose **Discard preserved copy**.
- Another window's draft matches the copy exactly.
- A later recorded version contains all the text in the copy.

Ordinary takeovers carry the shared text forward and leave no preserved copy. If device
storage is full, keep the window open until you have copied the text.

Moving from one case to another never takes over its draft. Opening the app directly on a case,
through a link or a reload, continues a draft whose window has closed.
A window that is open keeps its draft, however busy it is. If the window holding a draft has closed or
crashed, another window showing the draft says "This draft is held by a window that is not answering, or
has closed". Press <kbd>e</kbd> or choose "Take over here" to continue the draft in the window you are in.

## Read versions and restore earlier content

Select a case to read its version, author, proof, and timeline.
A result names the case version it exercised. Editing the case does not rewrite that result.

![Case with proof and a proposed edit in its timeline](../ui/screenshots/case-light.png)

To read a version diff, follow these steps.

1. Press <kbd>v</kbd> to compare the current version with the one before it.
2. To compare another version with its preceding version, select that version in the timeline.
3. Choose "Close" to dismiss the diff.

The first version of a case has nothing before it. Asking for its diff opens nothing.
The status line at the bottom of the window says that there is no earlier version.
Diff rows wrap long words and tokens so their full text can be read.

In Suite, <kbd>u</kbd> first undoes the latest placement action when one is available.
Otherwise, on a recorded case with more than one version, it restores the preceding
version as a new version. With a timeline version focused, it restores that version's
predecessor. The API can request a specific version to restore.
When the policy asks a person first, the status line says the restore is proposed and names its question.
The case stays at its current version until that question is answered.
See [the API guide](./api.md) for that operation.

Restoring creates history. It never deletes or rewrites the earlier versions.
The web diff compares adjacent versions, rather than offering two arbitrary version selectors.

## Organize the suite

To create a folder, follow these steps.

1. Press <kbd>n</kbd> <kbd>f</kbd> to create a folder.
2. Type its name.
3. Press <kbd>Enter</kbd>.

Creating a folder while inside another folder places it below that folder.
Select a folder in the sidebar to see its cases.

Creating, renaming, or moving a folder cannot introduce a duplicate path.
Existing duplicate paths do not block unrelated edits or a rename to a free path.
Path comparisons ignore letter case and use the Unicode cleaning described in [scope clauses](./policy.md#limit-agent-edits-by-folder-or-tag).
Creating or moving a case to an existing path uses that folder.
The server checks the final paths of a whole proposal again when accepting it.
Folder edits apply in order. A path that temporarily names two folders cannot be used to create a child folder during that batch.
Reorder the edits so that the path is unique first.
You can combine folder creations, renames, moves, and case placement in one proposal.

Press <kbd>x</kbd> on each case you want to select for a bulk action.
With no selection, the action uses the current case.
Press <kbd>m</kbd> to choose a destination folder.
To add a tag, press <kbd>t</kbd>. Enter the tag name.
Press <kbd>#</kbd> to archive the selected cases.
Press <kbd>u</kbd> to record the inverse of the latest placement action.

Moves, tag changes, and archiving appear in history without creating a new body version.
Archived cases leave the active suite. Their recorded history remains available.
Use [the API](./api.md) to return an archived case to active state.

While the server saves or accepts a large bulk change, you can keep reading the suite.
Each read sees the complete state before or after the change. The proposal's changes become current together.
A save queued behind that change still waits for it to finish.
The same behavior applies to confirmed CSV imports and a person's answers that create cases for unlinked tests or apply accepted findings.
When the policy uses `unlinked: create`, the server creates cases during report ingestion without pausing for reads.

To filter the current list, press <kbd>/</kbd> to focus "Filter cases". Type the words to match.
Use the sidebar's tags to narrow the suite by tag.

The header counts every case that matches the words, the folder and the tags, and the list loads all of them, best match first.
Words that match more than 2,000 cases are too broad to rank. The list then shows one page of the newest matches,
those with the words in their title first, and the header says `N+ cases`. Add a word, a folder or a tag to reach the rest.
Planning a run from such a search says "Too many matching cases to count".

## Resolve simultaneous edits

Edits to different fields can merge without a conflict. If two edits change the
same field differently, Mainworthy keeps both sides and shows "Both edits are kept".
The current version stays current while you resolve the conflict.

To resolve the conflict, follow these steps.

1. Read "Your draft" and "Current version" in the conflict card.
2. Choose a side for each field, or type the merged text.
3. If both sides reordered steps, choose the draft or current order. A kept step that your draft removed
   returns beside its surviving neighbours. An order you explicitly choose takes precedence.
   Steps absent from that order follow at the end.
4. Choose "Resolve conflict".

A choice for a deleted step restores that step from the chosen side, including a pinned fragment version.
Step choices and step-order choices are separate, even when a step's id is `order`.

"Use all my changes" and "Keep current version" fill the merged body from one side.
Resolving submits a new proposal. It still follows the policy for ordinary edits.
If someone changes the case again meanwhile, the new edit merges or opens another conflict.

The conflict card stays until the page reads your recorded merge or a later case version from the server.
The same rule applies in a second tab. A merge waiting for approval under a stricter policy has not changed the case yet.
If the read fails, the card stays and the page says so. Choose "Resolve conflict" again, or "Read the case again" in a second tab.
If you leave the case in that second tab before the read finishes, pressing <kbd>e</kbd> reads the case first when you return.
Clicking a field or changing a property also triggers that read.
The page discards a property change made before the read finishes.
Once the page shows the recorded case, change the property again.
Until the read finishes, the tab shows the case as it last read it.

## Review under a stricter policy

Under `loose`, ordinary case proposals take effect at once.
Under `standard`, an agent's edit waits for a person. A person's ordinary edit still takes effect at once.
Under `strict`, ordinary edits wait for a person with a reason, including edits by people.

The case timeline shows the proposal with every edit in it, the edits of other cases included,
since accepting it accepts all of them. An authorized person can use
<kbd>a</kbd> to accept it or <kbd>r</kbd> to reject it.
A key, or the Accept or Reject button, brings the proposal into view and shows its first unread part in the same press.
Later presses page through unread edits even when the card is taller than its pane.
It answers only once the last edit is showing.
When the policy requires a reason, the case pane opens a field labeled with Accept or Reject.
The answer buttons and keys stay disabled while this field is open.
If someone settles the question meanwhile, the field closes when the page receives that decision.
If your answer fails, the pane keeps newer timeline updates and reads the case again.
Type the reason and press <kbd>Enter</kbd> to record the answer, or <kbd>Escape</kbd> to cancel.
Conflicts and policy changes have separate rules. See [policy](./policy.md).

## Write cases from the command line

```sh
$ mainworthy new coupon.txt
$ mainworthy get C-1 --md > coupon.md
$ mainworthy fmt coupon.md
```

`new` reads an outline or canonical case Markdown. It also accepts standard input.
`get --md` prints the stored case as canonical Markdown.
`fmt` parses canonical Markdown and prints its standard form without changing the server.
It needs no running instance. Parse errors name the source line.
See [the CLI guide](./cli.md) for command forms and flags.

## Custom field values

Canonical Markdown can carry a `fields` map in its header. Values are strings and survive Markdown round trips.
When editing an existing case, omitting the `fields` header keeps the values from the edit's base version.
Concurrent field changes merge under the ordinary edit rules.
A proposal that supplies the map replaces all its values, so include keys you want to keep.
Unless a required field prevents it, an explicit empty header clears the values.
The empty header can be either `fields:` with no entries or `fields: {}`.
The web and iPhone case editors preserve these values but do not edit them.

A project can define text or choice fields and require values.
See [Custom fields](./policy.md#custom-fields) for the procedure.
New cases, restores, and changed field values must meet the definitions in force when proposed and adopted.
An edit can keep unchanged values from the current case, including missing required values or choices no longer allowed.
The web and iPhone editors can therefore edit older cases without filling new required fields.
Older versions remain readable as recorded.

## Reuse pinned fragments

A fragment is a versioned set of shared steps. To create a fragment in Suite, follow these steps.

1. Start a new case.
2. Choose **Fragment** in **Kind**.
3. Write the shared steps.

A recorded document's kind stays fixed. Fragments cannot include other fragments. A reference inserts
only the steps, not the fragment's preconditions or custom fields.

While editing a case, insert shared steps with these controls.

1. Open **Insert fragment**.
2. Enter the fragment ref, such as `C-12`.
3. Leave **Version** empty to pin the current version, or enter an older version.
4. Choose **Insert pinned fragment**.

The editor shows the shared steps and their source.
To remove the reference from the case, choose **Remove fragment**.
To change shared instructions, edit the fragment itself.

An archived fragment keeps its versions and existing pins. The insertion picker
excludes archived fragments, including their historical versions. You can edit
other content in cases that reference the fragment. Restore the fragment before inserting another
reference or moving a pin to a different version.

Reading a case or running it shows the fragment steps inline, marked with the
fragment ref and pinned version. Publishing another fragment version leaves
existing cases unchanged. Old case versions and runs keep their original pins.
Fragments themselves are omitted from run selections.

Search and run selections by text include the actions and expected results of
pinned steps at their pinned version. A newer fragment version changes those
matches only after you update the case's pin.

Open a fragment to see **Fragment users** and the versions each case uses.
To update cases pinned to an older fragment version, follow these steps.

1. Choose the older fragment version.
2. Select the cases to update.
3. Choose **Update selected to vN**.

One proposal records the selected updates and who requested them. The
project's policy may require acceptance. Unselected cases stay pinned. If any
selected case changes before the update is accepted, refresh and propose the
batch again. No selected case moves from that refused batch.
Large batches let reads answer while checking and applying the selected updates.
Until the batch commits, readers see every case at its previous version.
Moving a pin makes earlier results no longer current proof of the updated case,
even when the two fragment versions have the same instructions.

Markdown preserves a reference with its own step id:

```markdown
- !use C-12@v3 ^ab
```

A fragment's header uses `kind: fragment`. A literal action beginning with `!`
is escaped as `\!` in canonical Markdown. Instance and project archives preserve
fragment history and pins. Use the web editor to edit a fragment or a case with pinned fragments.
The iPhone app reads these documents but cannot save edits to them.
Fragment authoring and batch updates use the web,
HTTP `propose`, or CLI JSON. MCP discovery omits these inputs.
When a creation supplies both `kind` and Markdown, their kinds must agree.
A missing Markdown `kind:` line means `case`, so `kind: "fragment"` also requires
`kind: fragment` in the Markdown header.
