# Contributing

Use the pinned runtime versions and Bun lockfile. Keep changes focused and run the relevant tests, type checks and lint.

Do not add real customer documents, personal contact details, production identifiers, API keys, populated environment files, or links that make other installations depend on the official service. Use fictional fixtures and reserved example domains.

Preserve server-side authorization, company ownership, scoped guest access and audit logs. Never enable development authentication bypasses in a hosted environment. Treat a failing access-control test as a defect to investigate, not an assertion to weaken.

Document newly required configuration. Optional integrations should remain inactive until an operator configures them. Run secret scanning before proposing a release.
