Current task: {{focus}}

Turn units (JSON; groupId is the identifier, mark is the current state):
{{listing}}

You are reviewing the turn units of the past conversation. Your job is to deselect all irrelevant and outdated entries that are not helpful for the task any more.
These could be calls for read that were performed multiple times or write calls after the whole file has been written. Especially a late read of a file casts all preceding read, peek, write or edit calls for that file irrelevant.

Call context-unselect ONCE with the groupIds of the units that are irrelevant or outdated for the current task.

