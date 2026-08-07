# ADR 0024: Make connection checks explicit and keep Project Hub read-only

## Status

Accepted

## Context

The Connections page previously showed configuration and persisted provider
observations, but users had no explicit action to refresh that knowledge. The
Project Hub projection also existed as a pure aggregator while the HTTP route
always rebuilt a single current-project source.

## Decision

- `POST /api/connections/:provider/probe` is an explicit, CSRF-bound,
  configuration-revision-bound action.
- The default probe is local-only: it checks provider coordinates, credential
  presence, and the newest persisted observation. It never sends a network
  request or persists an observation. A future provider adapter may be injected
  through `ConnectionProbePort` and must honor the five-second abort signal.
- Probe responses contain only safe status, timestamps, and fixed summaries;
  secrets and credential values never cross the browser boundary.
- `PersistentTaskSealServerOptions.projectHub` is a read-only query seam. When
  supplied, `/api/project-hub` delegates to that aggregate; otherwise the
  current project remains the only source. A failed project stays unavailable
  without hiding other projects.
- Demo mode exposes safe, disabled connection placeholders so navigation does
  not degrade into a 404. Settings clearly explains that editing requires a
  persistent runtime.

## Consequences

Users can deliberately ask “what do we know now?” without confusing a page
poll with provider connectivity. External network probing and multi-project
runtime discovery remain separate follow-up capabilities with bounded seams,
instead of being hidden in a dashboard request.
