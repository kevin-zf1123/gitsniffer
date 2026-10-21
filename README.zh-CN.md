# Git Sniffer

Git Sniffer 是一个 VS Code 插件，把 Git diff 显示成类似 SpaceSniffer 的矩形树图。整个编辑器面板作为画布，分支与 commit 通过选择器或已有的 Source Control / Git Graph 视图选入。

## 运行与安装

需要桌面版 VS Code 1.96 或更新版本，以及 PATH 中的 Git。可用时使用内置 Git 扩展配置的可执行文件。打开本地 Git 工作区，通过 **Extensions: Install from VSIX** 安装插件，再运行 **Git Sniffer: Open**。工作区需要受信任。

点击 VS Code 底部状态栏左侧的 **Git Sniffer**，即可打开画布。该快捷入口会在受信任工作区启动后自动显示。

构建插件：

```sh
npm ci
npm run check
npm run compile
npm run package
code --install-extension git-sniffer-0.1.2.vsix
```

开发时在 VS Code 打开此目录，选择 **Run Git Sniffer** 并按 F5。开发宿主可以打开任意 Git 工作区。

## 比较变更

通过工具栏选择比较类型：

| 类型 | 基准 | 目标 |
| --- | --- | --- |
| Commits | 选定分支、标签或 commit | 选定分支、标签或 commit |
| Staged | HEAD | 暂存区 |
| Unstaged | 暂存区 | 工作区，包括未跟踪文件 |
| Uncommitted | HEAD | 工作区，包括未跟踪文件 |

Commits 默认比较 HEAD 的第一父提交与 HEAD；根提交的基准为空树。尚无首个 commit 时可使用工作区比较，此时 HEAD 一侧为空树。点击 BASE 或 TARGET，打开可搜索的 revision 选择器。标题栏的筛选按钮可切换 All、Tags、Branches（本地与远程）和 Commits（最近 200 条）。可以直接在搜索框输入 `main`、`origin/main`、`HEAD^`、`HEAD~5`、`HEAD^2` 或 hash，并确认 **Use Git revision expression**。所有分类都允许直接输入表达式；其中 `~` 使用 ASCII 半角字符。如果指定的祖先提交不存在，会显示 Git 错误。commit 基准还可选择 **Empty tree**。选入 commit 会切回 Commits 模式；交换按钮用于反转 commit 比较方向。

每个比较端点旁的 **‹ / ›** 按钮只移动该端点一个 commit。**‹** 走第一父提交；**›** 走仓库引用或所选 revision 可达的直接子提交。存在多个子提交时，由选择器询问要跟随哪一条分支。导航会保留所选的历史顶端，因此通过 hash 选入的 commit 在退到父提交后仍可前进返回。到达根提交或历史顶端时显示提示，保持比较不变。工作区比较、空树和加载期间禁用这些按钮。

分支和标签会解析为固定 commit。Refresh 保持这些 commit 不变；要跟随分支的新位置，需要重新选择分支。工作区模式的 Refresh 会重新读取暂存区和工作文件。忽略规则排除的未跟踪文件不会计入。插件读取仓库状态，不执行暂存、检出或提交。

每次刷新会捕获工作文件内容。捕获过程中发生变化时重试一次，仍不稳定则显示错误。之后打开的文件 diff 使用本次捕获内容。已暂存和已提交的内容从不可变 Git 对象读取。

## 浏览画布

初始视图展开根目录下的一层文件夹。点击文件夹切换子项展开状态，角落箭头将视图聚焦到该目录。面积不足以原地展开的目录在点击后直接聚焦。面包屑返回上级目录；**Collapse**、**One level** 和 **Expand all** 控制当前视图的展开层级。

点击文件，在画布旁边打开 VS Code 原生双侧 diff。新增或删除文件的一侧为空，重命名文件使用各自的新旧路径。**Files** 提供当前目录下所有变更文件的搜索列表，包括面积小到无法绘制的文件；列表中的目录箭头可聚焦到父目录。

面积按 Git 报告的变更行数计算：

| 面积模式 | 矩形权重 | 颜色 |
| --- | --- | --- |
| diff+ | 新增行数 | 绿色 |
| diff− | 删除行数 | 红色 |
| diff+ + diff− | 新增行数 + 删除行数 | 上绿下红，高度按两者比例划分 |

目录统计汇总所有子孙文件。当前模式中权重为零的文件没有矩形。二进制文件、纯重命名和仅权限变化仍可通过 **Files** 与 **without area** 打开。二进制内容交给原生编辑器，由编辑器决定能否显示。行数统计包含所有变更的文本文件，包括文档和生成文件。

## 外部 graph 接入

可以把已有 Git graph 放在画布旁边：

- **Git Graph+ 0.7.3**：在 Source Control 的本地分支、当前分支、远程分支或标签树中右键，选择 **Git Sniffer: Use as Base / Target**。同时打开多个仓库时需要选择来源仓库，因为 Git Graph+ 的树节点参数不含仓库路径。
- **VS Code Source Control Graph**：支持 commit 拖拽的版本中，拖起 commit，在进入画布时按住 Shift，放到 BASE 或 TARGET。直接放到画布会询问放入哪一侧。适配器识别原生 `scm-history-item` URI，并核验 commit 与已打开仓库。该内部格式已按 VS Code 1.130 核验；较旧的受支持版本可能没有此拖拽手势。
- **Git Graph+ 图**：其本地分支和 HEAD 标签提供分支名称文本，可拖到比较槽；普通分支文本在 Git Sniffer 当前仓库内解析。该图的 commit 行未提供外部拖拽或菜单扩展接口，可使用 **Copy SHA** 后通过选择器输入。
- **Source Control 仓库菜单**：**Git Sniffer: Open** 和 **Choose Base / Target Revision** 为对应仓库打开画布或选择器。

原生历史项的右键菜单仍需要 proposed VS Code API，因此插件使用稳定的仓库菜单和可选拖拽适配器。插件不依赖 Git Graph+，也没有复制其实现。

其他扩展可以通过命令选入 revision：

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

## 外观与限制

界面采用 VS Code 的主题变量、字体和高对比边框。`gitSniffer.areaMode`、`gitSniffer.addedColor` 和 `gitSniffer.deletedColor` 设置初始面积模式及 RGB 颜色。在画布内选择的面积模式优先用于该面板。

工作区比较要求先解决合并冲突。嵌套的未跟踪仓库作为仓库边界，其内部文件不纳入统计。支持 UTF-8 路径及 SHA-1 / SHA-256 仓库。Git 子进程超时为 30 秒，输出上限 32 MiB。工作快照每文件上限 32 MiB，每次比较上限 128 MiB。快照仅在当前会话有效。扩展配置为在 workspace 侧运行。远程执行、跨宿主拖拽及 Windows / Linux 执行仍需对应平台验证。

## 开发检查

```sh
npm test
npm run test:ui
npm run test:extension
```

核心测试使用临时真实 Git 仓库。UI 检查使用已安装的 Chrome（`channel: chrome`）与真实 Git 测试数据。扩展宿主检查启动隔离的 VS Code 开发宿主，操作实际 Webview 和原生 diff 编辑器。宿主脚本默认使用 macOS 标准安装位置；其他位置可通过 `VSCODE_EXECUTABLE` 指定。`npm run watch` 持续构建两份 bundle 与样式表。

视觉交互参考 [Git Graph+](https://github.com/the0807/git-graph-plus)。集成依据包括其[树节点参数](https://github.com/the0807/git-graph-plus/blob/main/src/views/branches-view.ts)、[VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)、[原生 diff 命令](https://code.visualstudio.com/api/references/commands)和 Git 的 [raw / numstat 格式](https://git-scm.com/docs/git-diff)。
