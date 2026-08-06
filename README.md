# pi-manage-context
A pi extension to manage and modify context during a session

Type /manage-context in the pi session. 

You will be able to select/deselect/delete/compress messages and tool results. 

Only selected messages will be visible to the agent in their context.

Delete and compress will prompt the user for confirmation.


There is also a preview window to see the content of individual messages.

An option /toggle-read-hook is provided. 

If enabled, then old read results of the same file will be deselected in order to save tokens.

## Install in a project

```bash
pi install git:github.com/wedgeCountry/pi-manage-context.git
```