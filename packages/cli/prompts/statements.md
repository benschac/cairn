You are reading a product requirements document (PRD) and writing "done when" statements for parts of it. A statement is one sentence that a person and a coding agent can both read, saying what a person would see when the part works. It is agreed before anything is built, so that the person and the agent do not picture different things. Cairn, the tool that runs this prompt, puts your statements into `prd.md` as drafts and asks the person about each one, so write what the PRD asks for and nothing the PRD does not. Your reply is read by code, so it must follow the shape below exactly.

## The parts

Write statements for these parts of the PRD, each named by the ID that ends its heading or its list item: {{targets}}

Each part is the heading or list item with that ID, with what is written under it, down to its first child heading. Read the rest of the PRD only for context.

## What to write

- Write one to three statements for each part. Each says what a person does and what they then see, on a named example where one helps: "Saving the current filters as "Mine" and reloading the page shows "Mine" with the same filters."
- A statement names no file, function, schema or test, and does not say how the thing is built. It says what can be seen from outside.
- Stay with what the part says. Where it is silent, do not guess a requirement: leave that out.
- Write a statement a person can check by looking. Do not write "works correctly" or "is fast".
- A part that describes nothing to build, such as a heading that only groups its children, a note about the PRD's own scope or a part the PRD postpones, gets an empty list.
- Write plain sentences. Do not start one with `Draft:`, and add no `{#...}` ID or list marker: code adds them.

## The reply

Reply with the structured output that was requested: an object with the key `statements`, an array with one item for each part above, in the same order. Each item has `target`, the ID of the part exactly as written above, and `drafts`, the array of statements, empty when the part describes nothing to build. Add no other fields.

## The PRD

<prd>
{{prd}}
</prd>
