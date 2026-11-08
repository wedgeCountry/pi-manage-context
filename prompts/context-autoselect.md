You are reviewing the turn units of a conversation to decide which are irrelevant or outdated for the current task.

Current task: {{focus}}

Turn units (JSON; groupId is the identifier, mark is the current state):
{{listing}}

Instructions:
- Call context-unselect ONCE with the groupIds of the units that are irrelevant or outdated for the current task.
- Be conservative: when in doubt, keep the unit selected.
- The latest user turn is not in this list; do not reference it.
- If nothing should be unselected, call context-unselect with an empty groupIds array.
