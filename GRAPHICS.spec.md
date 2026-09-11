# CivilizationLab Graphics Specification

**STATUS: DEFERRED PRODUCT/UI ENHANCEMENT**

**RESEARCH BLOCKING: NO**

**PILOT 0 BLOCKING: NO**

This authoritative product specification defines future visual and game-surface requirements for CivilizationLab. It records important post-Pilot UI work; it does not authorize implementation and is not part of the current Phase A calibration, Pilot 0, or confirmatory execution gates.

## Purpose and current problem

The validated world display is functionally adequate for research validation but is not yet visually sufficient for serious human gameplay. Resources, military presence, population, facilities, and terrain are difficult to understand directly from the world. Cells do not embody enough local state, zooming does not reveal deeper detail, strategic information is dispersed across controls, and the interface reads more like a research/control surface than a civilization game.

The future graphics system must make the world itself the primary information surface while remaining an exact, ACL-safe projection of authoritative state and canonical events.

## Design principle: semantic zoom

Zoom levels must change representation and information density rather than merely scaling the same icons.

### World / strategic view

Show major terrain regions, authorized polity territory and control, known borders, major settlements, military and resource concentrations, discovered and undiscovered regions, conflict zones, major infrastructure, and high-level population/economic indicators. This level supports strategic situational awareness.

### Regional view

Show individual cells clearly, including terrain, routes where applicable, facilities, known deposits, population density, unit groups, defenses, local ownership/control, intelligence freshness, and active construction or production. This level supports operational planning.

### Cell / local view

Selecting or zooming into a cell must expose all and only player-authorized detail: terrain, population, factories, mines, farms, power or production facilities, research facilities, military units, defenses, world-located resources, production, damage, construction, control/contestation, intelligence state, and relevant environmental conditions.

## Terrain

Terrain must be distinguishable without reading labels. The visual language may use texture, elevation cues, illustration, or equivalent techniques for plains, forests, mountains, hills, desert, tundra, coast, water, rivers, urbanized areas, and damaged/scorched areas where supported by world mechanics.

Terrain art must remain legible beneath polity, fog-of-war, military, resource, and accessibility overlays and must not obscure gameplay information.

## Resources

Resources require first-class visual representation at appropriate zoom levels: type, deposit, abundance or production, depletion, extraction facilities, world-located stockpiles, and flow/production indicators. Optional overlays should cover food, energy, industrial material, strategic material, and other world-defined classes. Undiscovered resources must never be exposed.

## Military

Render authorized unit location, class, approximate strength, path, posture, damage, engagement, ownership, and force concentration. Strategic zoom aggregates forces; local zoom exposes units at the detail supported by the world model. Icons must not obscure terrain or adjacent cells.

## Population

Population must be visually present in the world through settlement density, city size, clusters, local indicators, workforce assignment, change, and casualties/displacement where supported. It must not exist only as a number in a separate panel.

## Facilities and industry

Facilities need distinct visual forms or icons for factories, mines, farms, research, defenses, storage, infrastructure, and technology-specific buildings. Local view shows actual located facilities; higher zoom levels aggregate them into readable strategic indicators.

## Cell inspector

Selecting a cell must open a rich inspector with visual and precise numerical representations of authorized information under these sections where applicable:

- terrain;
- ownership and physical control;
- population;
- resources;
- facilities;
- military;
- production;
- technology effects;
- intelligence and information freshness;
- active events;
- recent canonical history.

Users must not have to choose between attractive graphics and exact game/research data.

## Overlays

Support optional overlays for political control, ownership, military, population, resources, economy/production, infrastructure, technology, intelligence/detection, logistics/supply, conflict, and relationships/diplomacy where appropriate. Overlays should be composable where practical and must remain legible.

## Fog of war and epistemic state

Graphics must visibly distinguish currently observed, previously observed but stale, inferred, undiscovered, ACL-hidden, and uncertain intelligence. The display must not imply certainty that the authorized projection does not establish.

## Animation and visual history

Future animation may represent movement, battle, territory changes, construction, population changes, extraction, discovery/contact, technology completion, and damage. Animation is never authoritative; it renders canonical transitions. It must be skippable and respect reduced-motion preferences.

Recent local changes—such as battles, movement, control changes, completed facilities, population changes, and depleted resources—must derive from canonical events. The client must not invent a separate visual history.

## Performance

The renderer must remain responsive at realistic world sizes through level-of-detail rendering, aggregation, culling, efficient tile/cell rendering, and appropriate asset caching. World zoom must not render every local detail.

## Accessibility

All relevant visual information needs a non-visual equivalent. Critical state must not depend only on color, animation, tiny icons, or texture. Preserve or improve keyboard navigation, screen-reader summaries, text equivalents, high contrast, scalable UI, reduced motion, and non-color state differentiation.

## ACL and research integrity

This is mandatory. Rich graphics consume the same authorized deterministic participant projections as the existing UI. They must never:

- receive authoritative hidden state and cover it visually;
- leak hidden information through rendering, tooltips, accessibility text, caches, search, or metadata;
- reveal undiscovered resources, facilities, units, population, or polity existence;
- expose Observer state to Player rendering.

Information boundaries fail closed. Graphics remain derivatives of authorized projections and canonical events; they do not redefine research or world semantics.

## Observer view

Observer/research graphics may expose richer world state only under explicit Observer authorization. The distinction from Player view must be unmistakable. Observer tools should support inspection of full world state, event activity, interactions, movement, resource flows, population, and major transitions without sharing Observer state or caches with Player rendering.

## Visual style

The target is a serious civilization/strategy game: coherent terrain, distinct polities, a readable strategic map, meaningful settlement/facility representation, legible military state, smooth semantic zoom, rich but controlled information density, and a strong world identity. The map should carry most visual meaning rather than becoming a background for floating status cards.

## Deferred implementation sequence

When separately authorized, implement incrementally:

1. semantic zoom architecture;
2. richer terrain rendering;
3. cell inspector;
4. resources;
5. population;
6. facilities;
7. military;
8. overlays;
9. fog-of-war information states;
10. animation and canonical visual history;
11. Observer enhancements;
12. final visual polish.

Graphics implementation must not redesign research semantics or world ontology.

## Future acceptance criteria

- Terrain is identifiable without opening a data panel.
- Known resources, military concentrations, populated areas, and major facilities are visually locatable.
- Cell zoom/selection communicates what exists there at the viewer's authorized detail level.
- Strategic, regional, and local views use materially different representations.
- Fog-of-war, stale information, uncertainty, and undiscovered state are visually clear.
- Every displayed datum respects participant ACLs; Observer and Player remain strictly isolated.
- Accessibility is equivalent to or better than the current validated interface.
- The interface is usable as a civilization game, not only as an experimental control surface.

## Priority and authorization boundary

Current dependency priority remains:

`AI research apparatus → Phase A calibration tooling → world calibration → Pilot 0 → confirmatory preparation`

This specification is deferred product work. Do not implement it, treat it as a calibration requirement, or add it to current Pilot 0 blockers without separate human authorization.
