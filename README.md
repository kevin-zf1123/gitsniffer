# Git Sniffer

Git Sniffer is a VS Code extension that turns a Git diff into a SpaceSniffer-style treemap. The entire editor panel is the canvas; branch and commit selection uses revision pickers or an existing Source Control / Git Graph view.

## Run and install

Requires desktop VS Code 1.96 or newer and Git in PATH. The built-in Git extension's executable is used when available. Open a local Git workspace, install the VSIX with **Extensions: Install from VSIX**, then run **Git Sniffer: Open**. Workspace trust is required.

Click **Git Sniffer** on the left of VS Code's bottom status bar to open the canvas. This shortcut appears automatically after startup in a trusted workspace.

To build the extension:

```sh
npm ci
npm run check
npm run compile
npm run package
code --install-extension git-sniffer-0.1.5.vsix
```

For development, open this directory in VS Code and press F5 using **Run Git Sniffer**. The development host can open any Git workspace.

## Compare changes

Choose the comparison kind from the toolbar:

| Kind | Base | Target |
| --- | --- | --- |
| Commits | Selected branch, tag or commit | Selected branch, tag or commit |
| Staged | HEAD | Index |
| Unstaged | Index | Working tree, including untracked files |
| Uncommitted | HEAD | Working tree, including untracked files |

Commit mode initially compares HEAD's first parent with HEAD. For a root commit the base is the empty tree. Before the first commit, use a working comparison; its HEAD side is the empty tree. Click BASE or TARGET for a searchable revision picker. The title-bar filter buttons show All, Tags, Branches (local and remote), or Commits (the latest 200). Type a Git revision such as `main`, `origin/main`, `HEAD^`, `HEAD~5`, `HEAD^2` or a hash directly into the search field, then accept **Use Git revision expression**. Expressions remain available in every category; use the ASCII `~` character. Git reports an error if the requested ancestor does not exist. **Empty tree** is also available as the commit base. Picking a commit switches back to Commits mode. The swap button reverses a commit comparison.

The **‹ / ›** buttons next to each endpoint move only that endpoint by one commit. **‹** follows its first parent; **›** follows a direct child reachable from repository refs or the selected revisions. If several children exist, a picker asks which one to follow. Navigation preserves the selected tip so a commit entered by hash can be revisited after moving to its parent. A root or tip displays a message without changing the comparison. These buttons are disabled for working comparisons, the empty tree and while loading.

Branch and tag selections resolve to fixed commits. Refresh keeps those commits fixed; pick the branch again to follow its new tip. Refresh rereads the index and working files for working comparisons. Ignored untracked files are excluded. Comparing and opening diffs read repository state; explicit staging actions update the index.

Working file content is captured for each refresh. File changes during capture cause a retry, then a visible error if state stays unstable. A file opened afterward shows the captured content. Staged and committed content comes from immutable Git objects.

## Navigate the canvas

The initial view expands root-level folders by one level. Click a folder to toggle its children; the arrow in its corner focuses that folder. A folder too small to expand in place focuses when clicked. Breadcrumbs return to its ancestors. **Collapse**, **One level** and **Expand all** control the current view.

Click a file to open its two snapshots in VS Code's native diff editor beside the canvas. Added and deleted files have an empty side; renamed files use their respective old and new paths. **Files** opens a searchable list of every changed file in the current folder, including files too small to draw; its folder arrows focus their parent directories.

Right-click a file on the canvas or in **Files** / **without area** to manage its staging state. **Stage Changes** is available in Unstaged and Uncommitted; **Unstage Changes** is available in Staged and Uncommitted. A partially staged file in Uncommitted offers both actions. Staging adds the file's current working changes, including additions and deletions. Unstaging restores its index entry to HEAD while retaining working content; a staged rename restores both index paths. Both actions also work before the first commit and refresh the comparison automatically.

In Uncommitted, fully staged files use the configured green and red; files with unstaged changes use darker shades of the same colors. Partially staged files remain dark and are labeled **Partially staged** in the tooltip and file list. A folder uses dark shades whenever any descendant has unstaged changes. File-list swatches use the same colors, and the footer shows the staging legend. Areas and line counts continue to represent the net HEAD-to-working-tree diff.

Area is measured in changed lines, as reported by Git:

| Area mode | Rectangle weight | Color |
| --- | --- | --- |
| diff+ | Added lines | Green |
| diff− | Deleted lines | Red |
| diff+ + diff− | Added + deleted lines | Green above red, with heights proportional to the two counts |
| &#124;diff+ − diff−&#124; | Absolute value of added − deleted lines per file | Green for net additions; red for net deletions |

In net mode (`gitSniffer.areaMode: "net"`), folder area sums the absolute net changes of individual files, so a file gaining 10 lines and another losing 10 occupy 20 lines of area together. Folder color follows its combined added − deleted count; a folder with zero combined net change uses a neutral theme color.

Folder counts sum their descendants. A file with zero weight in the selected mode has no rectangle, including equal additions and deletions in net mode. These files, binary files, pure renames and mode-only changes remain available through **Files** and **without area**. Binary content is passed to the native editor, which decides whether it can display it. Line totals include all changed text files, including documentation and generated files.

## External graph integration

In VS Code's **Source Control Graph**, right-click a single commit and choose **Git Sniffer: Use as Base** or **Git Sniffer: Use as Target**. The command uses that commit and its source repository, opens the canvas, and switches to Commits mode. Multi-selection is excluded. Incoming/Outgoing summary rows are not commits and are rejected. Repository refs, HEAD, the index and working files are left unchanged.

This menu uses VS Code's proposed `contribSourceControlHistoryItemMenu` API. For an installed VSIX, run **Preferences: Configure Runtime Arguments**, add the following property to `argv.json` (preserving other entries), then fully quit and restart VS Code:

```json
"enable-proposed-api": ["gitsniffer.git-sniffer"]
```

If `enable-proposed-api` already lists other extensions, append `gitsniffer.git-sniffer` to that array. An alternative is to launch VS Code with `code --enable-proposed-api gitsniffer.git-sniffer`. The development host and extension-host tests enable the proposal explicitly. This requires a VS Code version that provides the proposal; the current integration targets the desktop Source Control Graph.

Git Graph and Git Graph+ commit menus have no Git Sniffer entries. Copy a commit SHA from those extensions and enter it in the BASE / TARGET picker instead. This extension does not modify either extension. Plain branch text can still be dropped onto a comparison slot and is resolved in Git Sniffer's selected repository.

The Source Control repository menu provides **Git Sniffer: Open** and **Choose Base / Target Revision**. Native Source Control Graph commit dragging is also accepted on versions that expose it: hold Shift while entering the canvas and drop on BASE or TARGET. Dropping on the canvas asks which side to set.

Other extensions can select a revision through commands:

```ts
await vscode.commands.executeCommand('gitSniffer.setBase', {
  ref: 'main',
  repositoryPath: '/absolute/path/to/an/open/repository'
});
await vscode.commands.executeCommand('gitSniffer.setTarget', {
  ref: 'feature/parser',
  repositoryPath: '/absolute/path/to/an/open/repository'
});
```

## Appearance and limits

The interface uses VS Code's theme variables, fonts and high-contrast borders. Settings `gitSniffer.areaMode`, `gitSniffer.addedColor` and `gitSniffer.deletedColor` set the initial metric and RGB colors. A metric chosen inside the canvas takes precedence for that panel.

Working comparisons require resolved merge conflicts. Nested untracked repositories are treated as repository boundaries; their internal files are not included. UTF-8 paths and SHA-1 / SHA-256 repositories are supported. Git subprocesses have a 30-second timeout and a 32 MiB output limit. Working snapshots are limited to 32 MiB per file and 128 MiB per comparison. Snapshots are session-local. The extension is configured to run on the workspace host. Remote execution, cross-host dragging and Windows / Linux execution need platform validation.

## Development checks

```sh
npm test
npm run test:ui
npm run test:extension
```

Core tests create temporary real Git repositories. UI checks use an installed Chrome (`channel: chrome`) and real Git fixture data. Extension-host checks launch an isolated VS Code development host and exercise its real webview and native diff editor. The extension-host script defaults to the standard macOS VS Code executable; set `VSCODE_EXECUTABLE` for another installation. `npm run watch` rebuilds both bundles and the stylesheet.

The visual interaction reference is [Git Graph+](https://github.com/the0807/git-graph-plus). Integration follows its [tree item arguments](https://github.com/the0807/git-graph-plus/blob/main/src/views/branches-view.ts), the [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview), the [native diff command](https://code.visualstudio.com/api/references/commands), and Git's [raw and numstat formats](https://git-scm.com/docs/git-diff).
