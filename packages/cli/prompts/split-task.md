You are splitting one task of a build plan into smaller tasks. Each task becomes one git branch and one pull request, built by one coding agent in one session and then read by a human reviewer. A reviewer judged that the task below is too big or too mixed, and said why. Cairn, the tool that runs this prompt, turns your tasks into a stack of branches. Your reply is read by code, so it must follow the shape below exactly.

## Why the task is being split

{{reason}}

Cut the task along the line that judgment names. Every new task is one reviewable diff: something a person can read in one sitting and say yes or no to. Put a task's tests in the same task as the code they test.

## The task

<task>
{{draft}}
</task>

Its fields are the same as those of the tasks you write:

- `title`: a short imperative title. Titles are unique among your tasks.
- `prdSections`: the IDs of the PRD sections the task helps to build. At least one.
- `specSections`: the IDs of the spec sections the task builds, as they appear in the spec below. At least one.
- `files`: the files the task creates or changes, tests included.
- `dependsOn`: the exact titles of the other tasks in your reply that must land before this one, copied character for character. Leave it empty when the task needs no other task of your reply. A task never depends on itself, and the dependencies never form a cycle. A task that needs code another new task writes depends on it.
- `category`: the kind of work the task is, named as in the list of categories below.
- `model`: which model should build the task, named as in the table below.
- `reasoning`: how hard that model should think about it: `low`, `medium`, `high`, `xhigh` or `max`.

## What the new tasks must cover

Reply with two or more tasks. Together they build every spec section of the task above and change every file it changes: each spec section appears in the `specSections` of some new task, each file in the `files` of some new task, and each PRD section of the task above in the `prdSections` of some new task. Add nothing the task above did not do. The new tasks that build the same spec section split its files between them, and a file belongs to one task.

The task above may list titles in its `dependsOn`: they are tasks outside your reply, and the first of your tasks to need what they build keeps them. Another task may depend on the task above by its title: it will depend on the last of your tasks, so order them so that the last one is the one that finishes the work.

## Categories

Give every new task exactly one category, copied character for character. A reply with any other category is refused. The categories and what each is for:

{{categories}}

## Models and reasoning

Pick the cheapest model that will do the task well. The models and when to use each:

{{models}}

`low` reasoning suits a mechanical change that follows an example already in the code. `medium` suits a small feature with clear instructions. `high` suits most tasks that write a service or a feature with its tests across several files. `xhigh` and `max` are for logic where a subtle mistake is costly and hard to see in review. Choose what you believe is right and do not hedge.

## What you do not decide

You do not choose task IDs, branch names, parent branches, the order of the stack, which tasks need a human reviewer, or which tasks are blocked. Cairn derives all of these from the fields above. Do not put IDs, branch names or gate information into any field.

## The reply

Reply with the structured output that was requested: an object with one key, `drafts`, whose value is the array of two or more tasks. Add no other fields to the object or to a task.

## The spec

<spec>
{{spec}}
</spec>
