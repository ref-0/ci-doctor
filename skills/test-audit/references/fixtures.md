<!--
What: the rule for fixtures that stand in for input another component produces.
Where: read by an agent writing a fixture for sealed or relayed input.
Configure: nothing.
Reference implementation from a production monorepo; adapt to your repo.
-->

# Producer-faithful fixtures

Read when constructing fixtures for sealed or relayed input.

A fixture seals only what the real producer seals, from the same source. A
field only the fixture supplies lets the code under test pass on input it never
gets.

For example, in the source repo a worker's test fixture sealed each hook's
event, which the real relay never sealed, so every test passed and a release
shipped broken. The fix had the fixture's sealing helper read its fields from
the harness's identity, the same source the relay reads, so a field the relay
can't supply is a field the test can't supply either.

To check a fixture: list each field it supplies, and find the line in the real
producer that supplies the same field from the same source. A field with no
such line is the bug, in the fixture or in the producer.
