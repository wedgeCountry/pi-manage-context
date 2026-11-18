Current task: {{focus}}

Context text list (one entry per block; ID is the groupId of the context entry):
{{listing}}

Please call the rate-context tool with a list of tuples for each context entry with ID, a score, and a short reason. The score shall be between 1 and 10, measuring importance of the context snippet for future sessions, where 1 is small importance and 10 is very high importance. Importance is measured by the usefulness of the information and also by how relevant the information is. If it is outdated, then the relevance is low.

The rate-context tool writes an export file of your ratings and unselects every context entry whose score is below the threshold you pass, so choose the threshold deliberately. Call rate-context ONCE with one tuple per context entry. The latest user turn is not in the list above and must not be rated.
