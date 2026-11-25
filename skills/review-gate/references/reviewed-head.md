<!--
What: the commit a review session covers, and what a push after it may hold.
Where: read by an agent that pushes after a review, and before it merges a reviewed PR.
Configure: nothing; the record's format is in record.md.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The reviewed head

Part of the [`review-gate`](../SKILL.md) skill: what a push after a review may hold. Read it when a push follows a review, and before merging.

**It's fixed.** The session's first line names the commit its last round reviewed. A later push that changes reviewed code for a new reason, not a finding's fix or a CI fix, starts a new session with its own comment. A CI fix is checked against the findings it touches, not by a new session. Say in the Verification comment what changed since the reviewed head.

**The gate checks the record, not the head.** The checker checks the record's format and reviewer types, from members' comments; it doesn't check that a session covers the head CI tested. So before merging, run `git diff --stat <reviewed-sha>..<head-sha>`: it may hold only finding fixes and CI fixes, each named in the Verification comment. Anything else starts a new session.
