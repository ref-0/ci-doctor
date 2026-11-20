<!--
What: which services a test fakes, which it keeps real, and how a fake avoids making tests wait.
Where: read by an agent when a test talks to a service or a fake makes tests wait.
Configure: name your fakes in `.agents/repo/speed-up-tests.md`.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Fakes and real services

Part of the [`speed-up-tests`](../SKILL.md) skill. Read it when a test talks to a service, or a fake makes tests wait. [guide section 8](https://ci-doctor.ref0.dev/guide/docs/pages/08-a-cheaper-test-harness.md) covers the harness around them.

## What to fake, what to keep real

- **Fake a service the repo doesn't own that limits, costs or varies,** such as a source host, an error tracker, mail or a model provider. Answer the code's own outgoing requests from the fakes, while the code runs as in production. The repo's `.agents/repo/speed-up-tests.md` names its fakes.
- **Keep real what the test proves, or what judges it,** such as the runtime the code runs on, its database, a pinned oracle and the containers a test is about. [Workers](workers.md) says what that meant on Cloudflare Workers.
- **Prove the real service on staging,** in a few scheduled checks, not in every pull request's tests.

## A fake answers at once

- **Faults are opt-in.** A delay, a 429, a hang or a propagation window happens only in the tests that ask for it. A fake that always waits, as one fake source host's token propagation did on every token, charges every test for what a few prove.
- **A fake is never slowed to match production.** If the code paces itself or waits a deadline, that's the code's period: make it a setting, as [the fixes](fixes.md#a-production-period-or-retry-the-test-inherits) say.
- **Holds beat delays.** A fake that holds a call until the test releases it orders a race with no clock. Hold the exact call: a one-shot fault let the client's own second try reach a hold keyed more broadly, which then waited out a 30 s deadline.
- **Pick a fault's status for what the test proves.** A 500 took a retry's wait before the refusal the test was about; a 404 takes none.
- **Make a request's promise in that request.** A fake that handed one promise to later requests failed once the runtime (workerd) began rejecting an await on a promise whose request had ended.

## Nothing reaches the network by accident

Each fake passes a request it doesn't answer to the next, so check that the chain ends in a refusal: a request to any host but localhost fails its test, naming the host. Without one, a test that calls a host nobody faked reaches the real service, and is slow, limited and flaky for it.

Remove a fake only after the runtime that calls it closes. Vitest runs `afterAll` hooks in reverse, so a file's own hook removed a fake before the shared harness closed, and work a test left running hit the guard.

## Keep a fake true

A fake drifts from its service. Recorded answers kept beside the contracts keep the shapes honest. To check the behaviour, run the same checks against the fake in CI and against the real service on staging on a schedule; a new scheduled job costs money, so it needs a person's yes.
