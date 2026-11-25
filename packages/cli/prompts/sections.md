You are adding to a technical spec that already exists. The product requirements document (PRD) has sections that the spec does not cover yet, or that changed after their spec section was written. Cairn, the tool that runs this prompt, reads your reply with code: it parses the headings and the keys, puts each new section into the spec, and builds the stack of branches from them. So the format below is part of the job.

## What to write

Write spec sections for these PRD sections: {{sections}}

Write these spec sections again, because the PRD section they implement changed: {{rewrite}}

Every section you write implements at least one of the PRD sections above. Stay with what the PRD asks for. Where it is silent, choose the simplest option that works and say that you chose it. Do not add features, and do not write a section for a PRD section that is not listed.

The spec below is the spec that exists. Write your sections to sit in it: reuse its names, its files and its way of cutting sections, and look at the sections around the place where yours go. Do not copy a section that is already there, and do not repeat what one of them says. Where a new section needs code that an existing section writes, name that section in `Depends on`.

## The format

Reply with markdown and nothing else: no preface, no closing remark, and do not wrap the reply in a code fence. The reply is one or more spec sections. Each is a heading with a stable ID in a trailing attribute, then a list of keys before any prose, in the same form as the spec:

```markdown
### Deep links {#spec.viewer.deep-links}

- Under: `spec.viewer`
- Implements: `prd.viewer.deep-links`
- Files: `apps/viewer/src/deep-links.ts`, `apps/viewer/test/deep-links.test.ts`
- Depends on: `spec.viewer.panes`

Prose starts here.
```

- `Under`: the ID of the existing section the new one goes under, which becomes its parent. Give it on every section you write that is not itself under another section of your reply. A section you write again has no `Under`: it keeps its place.
- The heading level is one more than the level of the section it goes under, so `###` under a `##` section. A section of your reply under another section of your reply has a level one more than that one and no `Under`.
- The ID is the ID of its parent section, then `.`, then the heading text in lowercase kebab-case: letters and digits joined by single hyphens. IDs are unique. A section you write again keeps its ID, as it is, and its heading text.
- `Implements`: the PRD section IDs it builds, from the list above. `Files`: the paths it touches, tests included; a trailing `/` is a directory. `Depends on`: spec section IDs that must land first. `Defers` and `Context`: PRD section IDs that need no code here. Write IDs in backticks, separated by commas, and use only IDs that exist in the PRD or the spec, or that your reply gives.
- A PRD section the build does not need goes in `Context` of one of your sections, and one the PRD itself postpones goes in `Defers`. Every PRD section listed above must be covered by a section of your reply.
- Each section's prose says what it builds, the interfaces and data it defines, the behaviour that matters, what it leaves out and how it is tested. Be concrete: name the files, functions, schemas and commands.

## Diagrams

Draw a Mermaid diagram in a section when it says more than the prose around it, and only then. Put it in a fenced block tagged `mermaid`, inside the section it explains, with a sentence before it that says what it shows: a `stateDiagram-v2` for a machine's states and events, a `sequenceDiagram` for messages between two processes, a `flowchart` for data that passes through three or more steps. Do not draw one for anything a list already says, and do not draw the stack of tasks: code draws it. A block that does not draw is sent back to you once and then left out.

## The PRD

<prd>
{{prd}}
</prd>

## The spec that exists

<spec>
{{spec}}
</spec>

Write the sections now, as markdown only.
