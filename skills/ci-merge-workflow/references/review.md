<!--
What: the review of a draft PR, where the repo adopted the review-gate skill.
Where: read by an agent before it marks a reviewed PR ready.
Configure: your repo's `.agents/repo/review.md` and its `review-record.ts` settings, as the review-gate skill says.
Reference implementation from a production monorepo; adapt to your repo.
-->

# The review while it's a draft

Part of the [`ci-merge-workflow`](../SKILL.md) skill: step 2, the review, where the repo adopted `review-gate`. Read it before marking a PR ready.

Where the repo adopted [`review-gate`](https://github.com/ref-0/ci-doctor/blob/v0.4.0/skills/review-gate/SKILL.md), follow it and the repo's `.agents/repo/review.md`: what gets reviewers and what gets behaviour checks and a `No review:` line, at most three rounds, and the session's comment in the record's format, checked with its `review-record.ts`, before marking ready.

