# omp-herdr-title-sync

Synchronize the OMP session title and the current Herdr pane's label in both directions. Unicode names are preserved. It does not rename the Herdr agent identifier, tab, or workspace.

## Install

```sh
omp plugin link /path/to/omp-herdr-title-sync
```

Restart OMP in Herdr to load the extension.

## Behavior

- An existing OMP session title initializes the pane label. If the session is untitled and the pane already has a label, the label becomes the session title.
- Later changes propagate in either direction, normally within one second. If both change between observations, the pane label wins.
- Switching sessions follows the new session title; an untitled session does not inherit the preceding session's label. Clearing a pane label restores the session title because OMP does not support clearing a session title.
- On normal OMP shutdown, the current pane label is cleared.
- Only the current pane's top-level OMP session is managed. Task subagents, nested OMP processes, and sessions outside Herdr are ignored.
- The extension uses the Herdr socket inherited from the pane, preserves user text as JSON, and never sends it to a shell.

## Test

```sh
bun test
```
