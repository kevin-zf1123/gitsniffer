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
code --install-extension git-sniffer-0.1.1.vsix
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

Commit mode initially compares HEAD's first parent with HEAD. For a root commit the base is the empty tree. Before the first commit, use a working comparison; its HEAD side is the empty tree. Click BASE or TARGET for a searchable branch, tag and recent-commit picker, or enter a revision such as `main`, `origin/main`, `HEAD~3` or a hash. **Empty tree** is also available as the commit base. Picking a commit switches back to Commits mode. The swap button reverses a commit comparison.

Branch and tag selections resolve to fixed commits. Refresh keeps those commits fixed; pick the branch again to follow its new tip. Refresh rereads the index and working files for working comparisons. Ignored untracked files are excluded. The extension reads repository state without staging, checking out or committing.

Working file content is captured for each refresh. File changes during capture cause a retry, then a visible error if state stays unstable. A file opened afterward shows the captured content. Staged and committed content comes from immutable Git objects.

## Navigate the canvas

The initial view expands root-level folders by one level. Click a folder to toggle its children; the arrow in its corner focuses that folder. A folder too small to expand in place focuses when clicked. Breadcrumbs return to its ancestors. **Collapse**, **One level** and **Expand all** control the current view.

Click a file to open its two snapshots in VS Code's native diff editor beside the canvas. Added and deleted files have an empty side; renamed files use their respective old and new paths. **Files** opens a searchable list of every changed file in the current folder, including files too small to draw; its folder arrows focus their parent directories.

Area is measured in changed lines, as reported by Git:

| Area mode | Rectangle weight | Color |
| --- | --- | --- |
| diff+ | Added lines | Green |
| diff− | Deleted lines | Red |
| diff+ + diff− | Added + deleted lines | Green above red, with heights proportional to the two counts |

Folder counts sum their descendants. A file with zero weight in the selected mode has no rectangle. Binary files, pure renames and mode-only changes remain available through **Files** and **without area**. Binary content is passed to the native editor, which decides whether it can display it. Line totals include all changed text files, including documentation and generated files.

## External graph integration

Keep your preferred Git graph next to the canvas:

- **Git Graph+ 0.7.3**: right-click a local branch, current branch, remote branch or tag in its Source Control trees and select **Git Sniffer: Use as Base / Target**. When multiple repositories are open, choose the source repository because Git Graph+ tree arguments contain no repository path.
- **VS Code Source Control Graph**: on versions that expose commit dragging, drag a commit, hold Shift while entering the canvas, and drop on BASE or TARGET. Dropping on the canvas asks which side to set. The adapter recognizes the native `scm-history-item` URI and validates its commit and open repository. This internal format was checked against VS Code 1.130; older supported VS Code versions may not offer the drag gesture.
- **Git Graph+ graph**: its local branch and HEAD badges expose branch names as text and can be dropped on a comparison slot. Plain branch text is resolved in Git Sniffer's selected repository. Its commit rows do not expose an external drag or menu hook; use **Copy SHA** and the revision picker for those commits.
- **Source Control repository menu**: **Git Sniffer: Open** and **Choose Base / Target Revision** open the canvas or picker for that repository.

Native history-item context menus currently require a proposed VS Code API, so this extension uses stable repository menus and the optional drag adapter. It has no dependency on Git Graph+ and does not copy its implementation.

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
