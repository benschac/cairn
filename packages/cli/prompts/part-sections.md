This run plans one part of the PRD, not all of it. The part is these PRD sections and list items: {{part}}

Write sections for the part only. In every section you write, `Implements`, `Defers` and `Context` may name only IDs from that list. A PRD section outside the part that you name in `Context` or `Defers` would count as covered, and a run is not made smaller by deferring work. A reply that names an ID outside the part in one of those keys is sent back to you once, and then the run fails.

When the part needs something outside it that is not planned yet, say so in the section's prose with a line that starts `Assumes:`, naming the outside PRD section in backticks, for example: ``Assumes: `prd.deep-links.targets` gives every target a link; not planned yet.`` Do not plan that section, and do not put it in a key. A later `cairn plan prd.deep-links` plans it on its own run. `Depends on` may still name any section of the spec that exists.
