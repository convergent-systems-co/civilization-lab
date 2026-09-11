# Pilot 0 apparatus UI handoff

Scope: BUILD and NONEMPIRICAL conformance only. No human session, model loading,
inference, calibration or empirical execution was performed. No commits or pushes.

## Routes and authorization

- `/`: participant shell. `/api/state` returns the canonical projection envelope
  plus only that principal's execution/phase controls.
- `/api/action-meta`: authenticated, fixed public mechanics metadata. Includes
  unit/facility/technology/assignment and terrain rules, movement, detection and
  food demand constants. Excludes starts, generation, roster, model conditions
  and live world state. AI adapters must have access to equivalent rule metadata.
- `/api/action`: a typed action or `{actions, turn, projection_id}` batch. The
  server creates identity lineage. Reserved actor/run/session identifiers are
  denied. Rejected actions consume their opportunity; no corrective UI retry.
- `/observer`: distinct research shell and script. Research bearer credentials
  never authorize participant routes, and participant credentials never authorize
  `/api/observer`, `/export`, `/replay`, or `/analysis` beneath that route.
- Research replay reconstructs completed canonical snapshots; historical polity
  view uses the projection at that time. No fork or continuation mutation route.
  Redaction tombstones block content with `REPLAY_INCOMPLETE_REDACTED`.
- Research analysis accepts an operator-supplied `analysisManifest` option to
  `createApplication`. `/api/observer/analysis` calls the canonical `deriveEndpoint`
  API, and the view renders A fulfillment, B reciprocity, C repair and D late–early
  change, preserving missingness, denominators, source links and vector structure.
  No manifest or no coded evidence means no invented estimates.

## Durable service interface

`createApplication({runService, allowSyntheticExecution: true})` uses
`runService.world`, `participantState(principalId)` and
`submitParticipantActions({principalId, actions, turn, projectionId})`.
Both service and HTTP execution switches must permit synthetic execution.
Every request rereads the service world because durable transactions replace it.
The trusted worker owns commit/resolve, deadlines, memory and interview phases.
The default application has execution disabled.

Projection fields match `contracts.js`: `own.polity_state`,
`public.discovered_world_state`, `own.knowledge`, `public.known_map`,
`public.known_territories`, `own.intelligence`, `authorized.messages`,
`authorized.channels`, `own.available_actions`; optional `own.memory` and
`public_safe.validation_results` remain supported. Aged observation facts are
read from `own.intelligence.facts`. Unrecognized projection fields fail closed.

## Validation

- `node --test test/server-apparatus.test.js test/http-security.test.js`: 11 pass.
- `node --test test/ui-apparatus.test.js`: 6 pass in real Chromium. On this Mac,
  the test process needs sandbox escalation for Chromium's MachPort registration.
- Browser tests cover all 38 action forms, keyboard map navigation, known-only
  movement/detection overlays, inert participant text, narrow layouts, capability
  panels, cross-domain denials, stale response isolation, DOM/accessibility/storage
  canaries, Observer filters and raw payload links.
- `playwright` is the added development dependency; `package-lock.json` records it.
- Review screenshots are in `/private/tmp/civilization-player-desktop.png`,
  `/private/tmp/civilization-player-mobile.png`, and
  `/private/tmp/civilization-observer-desktop.png` (synthetic fixtures only).

## Backend boundary to resolve

If every active actor is rejected, `commitTurn()` currently refuses an empty
validated set. RunService correctly accounts for rejections but reaches the same
guard. The fallback HTTP path leaves that turn pending. Supporting a canonical
zero-accepted-action turn belongs to the commitment/replay implementation; the
UI does not synthesize accepted waits or restore lost action opportunities.
