You are reading one section of a technical spec and writing down what it says in a structured form. Cairn, the tool that runs this prompt, keeps a structured copy of the spec in `spec.json`, so that the planner, the judge and other tools read the spec without parsing markdown. Code has already filled in the section's heading, keys and tasks. You fill in the rest, from the section's prose alone. Your reply is read by code, so it must follow the shape below exactly.

## The section

Its ID is `{{id}}`. Its title is "{{title}}".

<section>
{{body}}
</section>

## What to write

Say only what the section says. Do not add a requirement, a test or a decision it does not state or plainly imply, and do not copy its keys list into a field. A section with nothing for a field has an empty array there.

- `summary`: one or two sentences saying what the section builds, for a reader deciding whether to open it.
- `requirements`: what the section says the code must, must not, should or may do, one item for each. `level` is `must`, `must-not`, `should` or `may`, from the section's own wording: a plain statement of behaviour is `must`. `text` states the one requirement so that it makes sense alone.
- `artifacts`: what the section names that code will hold: a function, a schema, a command, a config key, a file, a route, a service, a lint rule, a state of a machine and so on. `kind` is one of the values the schema allows. `name` is the name as the section writes it. `location` is the file it lives in when the section says, and `null` when it does not. `description` says what it is in a sentence. `fields` is for a schema, type or table, with each field's name, type, whether it is optional and what it holds. `signature` is for a function, and `values` for a status or an option with a closed set of values. Leave a field out when its kind has none.
- `tests`: the tests the section asks for, one item for each. `kind` is `check`, `example`, `property`, `scene`, `integration` or `mutation`, by how the section describes the test: a property over generated inputs is `property`, a run against the real thing is `integration`, and a case with one fixed input and output is `example`.
- `decisions`: the choices the section records, one item for each: where it picks one thing over another, or says what it leaves out. `why` is the reason the section gives, and `null` when it gives none. Do not invent a reason.

## IDs

Every item has an `id`, and every ID starts with the section's ID and `#`: `{{id}}#`. Then:

- a requirement is `{{id}}#r1`, `{{id}}#r2` and so on, counting up from 1 in the order of the section;
- a test is `{{id}}#t1`, `{{id}}#t2` and so on;
- a decision is `{{id}}#d1`, `{{id}}#d2` and so on;
- an artifact is `{{id}}#` then its kind, `:` and its name in lowercase kebab-case: letters and digits joined by single hyphens, such as `{{id}}#function:stack-of`. Two artifacts of one kind with one name are one artifact.

## The reply

Reply with the structured output that was requested: an object with the keys `summary`, `requirements`, `artifacts`, `tests` and `decisions`. Add no other fields to the object or to an item.
