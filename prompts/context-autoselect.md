Current task: {{focus}}

Turn units (JSON; groupId is the identifier, mark is the current state):
{{listing}}

You are reviewing the turn units of the past conversation. The model's context memory is limited, so the goal is to free up context space for what matters now: unselect every entry that is not crucial for the current task, and keep only the most important parts of the context.

Entries worth unselecting include: repeated read calls on the same file, earlier read/peek/write/edit calls on a file that was read again later (the late read makes the earlier ones irrelevant), explorations of dead ends, and anything superseded by a later unit.

Call context-unselect ONCE with the groupIds of the units to unselect. If nothing should be unselected, call context-unselect with an empty groupIds array.
