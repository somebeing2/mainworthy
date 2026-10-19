# 0111: Inherited replacements can overrule interim rules

Date: 2026-10-18. Fixes [issue #628](https://github.com/endqwerty/mainworthy/issues/628) and
[issue #629](https://github.com/endqwerty/mainworthy/issues/629). Clarifies decision 0098.

Withdrawing an inherited answer immediately refolds its runs. A custom policy can answer the ordinary cause
by rule during that fold. A direct replacement therefore finds either the open cause question or a decided
cause whose holds cover that target. It answers through the same policy checks, effects and holds as any
ordinary cause answer. The handoff records the caller's answer even when it matches the interim answer,
so the replacement has manual attribution and holds. Ordinary repeated answers keep returning `already`.

Deferring the fold would require another path for raising the cause without running its rules. Reusing the
existing fold and answering its question keeps rule handling and manual holds in their current owners.
Fix Root Causes and Laziness Protocol shaped that choice.

Withdrawal and replacement remain in one savepoint. If the ordinary answer is only advice, the handoff
returns `forbidden` with the ordinary question's requirement and restores inherited standing. It records
no advice. Returning `advised` would claim that a rolled-back answer had been kept. This preserves the
existing rule that advice does not withdraw inherited standing, without moving advice onto evidence the
agent was not answering.

HTTP, CLI and MCP share the registry path. The web queue withdraws before offering a replacement, and the
iPhone refuses replacements through `ifOpen`. Neither needs a contract change. Archives preserve the same
question and decision records, so rebuilding and migrations do not change. The demo adopts standard before
reporting failures, so it has no automatic inherited answers to replace and needs no additional scenario.
