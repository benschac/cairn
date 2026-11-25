This run drafts tasks for one part of the PRD, not all of it. The part is these PRD sections and list items: {{part}}

Every ID in a task's `prdSections` must be one of them, and every ID in its `specSections` must be one of the spec sections above. A task may still depend, in `dependsOn`, on any task that is already planned, in the part or outside it. A reply that breaks either rule is sent back to you once, and then the run fails.
