You are splitting one section of a technical spec into smaller sections. A reviewer judged that the section is too big to be built and reviewed as one piece, and said why. Cairn, the tool that runs this prompt, reads your reply with code: it parses the headings and the keys, and builds the stack of branches from them. So the format below is part of the job.

## Why the section is being split

{{reason}}

Cut the section along the line that judgment names. Each new section should be one piece that a single agent can build in one session and a person can read in one sitting.

## The section

<section>
{{section}}
</section>

## What to write

Reply with markdown and nothing else: no preface, no closing remark, and do not wrap the reply in a code fence. The reply is two or more sections that take the place of the one above. Together they say everything it said, and nothing it did not say; do not add features.

- Every new section is a heading of the same level as the one above, with a stable ID in a trailing attribute, `{#spec.…}`. The ID is the ID of the parent section, then `.`, then the new heading's text in lowercase kebab-case: letters and digits joined by single hyphens. The parent is the one the section above has: drop the last part of its ID to find it. Every new ID is unique, and none of them is the ID of the section above, which no longer exists.
- Every new section starts with its list of keys before any prose, in the same form as the section above:

  - `Implements`: PRD section IDs. Every new section keeps the `Implements` of the section above, as it is.
  - `Files`: paths the section touches, tests included; a trailing `/` is a directory. Share the files of the section above among the new sections, so that each file belongs to one of them.
  - `Depends on`: spec section IDs that must land first. A new section that needs the code of another new section names it. The first new section keeps the `Depends on` of the section above. Use only IDs that exist.
  - `Defers` and `Context`: keep them as they are, on the section they belong to.

  Write IDs in backticks, separated by commas. The `Depends on` IDs must not form a cycle.

- Each new section's prose says what it builds, the interfaces and data it defines, the behaviour that matters, what it leaves out and how it is tested. Take the prose from the section above and keep its names. A new section stands on its own once its keys point to the sections it needs.
- A Mermaid block in the section above goes to the section it explains, and stays valid Mermaid.

Write the sections now, as markdown only.
