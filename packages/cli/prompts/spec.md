You are writing the technical spec for a software project. The spec turns a product requirements document (PRD) into something that engineers and coding agents can build from, one small piece at a time. Cairn, the tool that runs this prompt, reads your spec with code, not with a person: it lints the headings and the keys, builds the stack of branches from them, and shows the sections in a viewer. So the format below is part of the job, and a spec that breaks it cannot be used even if the prose is good.

## What to write

Write the spec as one markdown document. Reply with the markdown and nothing else: no preface, no closing remark, and do not wrap the document in a code fence.

Start with a single level-1 heading that titles the spec. Then write level-2 sections for the major areas of the work, and level-3 sections inside them where an area has parts that can be built and reviewed on their own. A section should describe one piece of the build: what it is, the interfaces and data it defines, the behaviour that matters, what it leaves out, and how it is tested. Be concrete. Name the files, functions, schemas, commands and libraries the section uses, and say why when a choice is not obvious. The reader of a section is a capable agent who has not read the rest of the spec, so a section should stand on its own once its keys point to the sections it needs.

Stay with what the PRD asks for. Where the PRD is silent, choose the simplest option that works and say that you chose it. Do not add features, and do not leave a requirement without a section that builds it, defers it or says it needs no code.

## The format

Every heading carries a stable ID in a trailing attribute, and every section starts with a list of keys, before any prose:

```markdown
## Models {#spec.models}

- Implements: `prd.implementation-in-effect`, `prd.judging-the-plan`
- Files: `packages/cli/src/models.ts`
- Depends on: `spec.contract.config`

Prose starts here.
```

The ID of a heading is `spec.` followed by the heading text in lowercase kebab-case: letters and digits joined by single hyphens, for example `## Planner service` becomes `{#spec.planner-service}`. A section under a level-2 or level-3 heading takes its parent's ID as a namespace, so the level-3 heading `### Planner service` under `## Planning {#spec.planning}` is `{#spec.planning.planner-service}`. The level-1 title heading is the one exception: it never namespaces its children, so a level-2 heading is `spec.<slug>`, not `spec.<title>.<slug>`. IDs are unique in the document. Every ID is lowercase, with `.` between levels and `-` inside a level.

The keys, each on its own line of the list, in this form:

| Key          | Value                                              | Used for                                                      |
| ------------ | -------------------------------------------------- | ------------------------------------------------------------- |
| `Implements` | PRD section IDs                                    | Coverage and progress: which PRD sections this section builds |
| `Files`      | Paths it will touch; a trailing `/` is a directory | Plan-time gate detection, and the files a task may change     |
| `Depends on` | Spec section IDs                                   | The order of the stack: what must land first                  |
| `Defers`     | PRD section IDs left for later                     | Coverage; the viewer shows them as deferred                   |
| `Context`    | PRD section IDs that need no code                  | Coverage; the viewer shows no badge                           |

Write IDs in backticks, separated by commas. Use only IDs that exist: PRD IDs come from the PRD below, and every `Depends on` ID must be the ID of a heading in your own spec. A key applies to its section and to every section below it, so a level-2 section can state `Defers` once for its children. A section that builds something has `Implements` and `Files`. A section that only explains, such as an overview, may have `Context` or no keys.

Coverage matters. A PRD section is covered when it, or a section under it, appears in some `Implements`, `Defers` or `Context` key, and a `Defers` or `Context` key also covers the sections under the one it names. Here "under" means in the heading tree, not by ID prefix. Check each PRD section against this before you finish: a section the build does not need goes in `Context`, and one the PRD itself postpones goes in `Defers`.

A list item in the PRD can carry an ID too, as in `- Share a saved view by link. {#prd.saved-views.share}`, and then it is covered on its own. When a PRD section's items have IDs, name the items in `Implements`, not the section that holds them: an `Implements` that names the section does not cover its items. A `Defers` or `Context` that names the section, or an item, covers the items under it.

`Depends on` must not form a cycle, and a section should depend only on the sections whose code it needs to exist. Fewer dependencies make a stack that is easier to build and to review.

Write `Files` with real paths in the layout you describe, and include the tests that go with the code. Two sections may touch the same file when they must, but each file should have one section that owns it. Prefer a section small enough that its files fit in a single reviewable diff, and split it into sibling sections when they do not.

## Tests and done-when statements

The PRD states what a person sees when a section works in lists that follow a `Done when:` line. Each statement ends with an ID, such as `{#prd.saved-views#v1}`. A statement that begins `Draft:` is a draft: Cairn wrote it and no person has confirmed it. It is passed to you as it is, marked `Draft:`, so write its test as you would for any other, and do not treat it as agreed.

A section writes a test for every statement of the PRD sections and items it implements, except a statement tagged `<!-- human -->`, which a person checks. Each test a section names ends with `(proves <statement IDs>)`, with the IDs of the statements it proves separated by commas, for example `- Saving a view lists it under its name. (proves prd.saved-views#v1)`. Use only statement IDs the PRD gives, written as it gives them. A test that proves no statement has no such ending.

## Diagrams

Draw a Mermaid diagram in a section when it says more than the prose around it, and only then. Put it in a fenced block tagged `mermaid`, inside the section it explains, with a sentence before it that says what it shows.

- A machine's states and events: a `stateDiagram-v2`, with the event on each transition.
- Messages between two processes: a `sequenceDiagram`, with the message on each arrow.
- Data that passes through three or more steps: a `flowchart`, with each step a node and the data on the edge.

Do not draw one for anything a list already says: a list of files, of keys, of options, or steps that run in one line. Do not draw the stack of tasks: code draws it from the manifest. Cairn renders every block, so a block must be valid Mermaid and small enough to read; a block that does not draw is sent back to you once and then left out.

## A worked example

The spec below is the spec of Cairn itself, written by hand in this format. Use it for the shape: how sections are cut, how keys are filled in, how much detail a section carries and how the tests are described. Do not copy its content or its names; your spec is for the PRD that follows it.

<worked-example>
{{example}}
</worked-example>

## The PRD to write the spec for

<prd>
{{prd}}
</prd>

Write the spec now, as markdown only.
