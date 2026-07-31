# THEIA 版本管理规范

本文规定 THEIA 本地工作区、Git 历史和发布物的唯一组织方式。目标是让源码、个人运行数据、待验证构建和正式发布物互不混淆，并确保每个发布版本都能定位、校验和回滚。

## 1. 标准目录布局

本机的统一工作根目录为 `H:\work\THEIA`：

```text
H:\work\THEIA\
  README.md                 本机目录入口，不是应用源码 README
  source\                   唯一 Git 工作区
  releases\
    INDEX.md                自动生成的人类可读发布索引
    INDEX.json              自动生成的机器可读发布索引
    SHA256SUMS.txt          自动生成的全部 ZIP 校验清单
    v0.1.0\
      README.md             该版本说明和首选产物
      artifacts\            ZIP 与随包 SHA-256 文件
      extracted\            为便于检查而保留的解压目录
    v0.1.1\
      README.md
      artifacts\
      extracted\
  staging\                  新构建的临时验证区，不视为正式发布
```

规则：

- `source` 是唯一允许继续开发和提交 Git 的目录，不再复制第二个可编辑源码树。
- `releases` 只保存已经发布或明确标记为历史快照的只读产物。
- `staging` 只保存待检查产物。检查通过后移动到对应的 `releases\vX.Y.Z`。
- 用户任务、聊天、模型密钥、头像缓存和日志只属于运行数据，不得进入 `releases` 或 Git。
- 不在 `H:\work` 根目录直接放置新的 `THEIA-*` 文件；所有新版本必须进入统一根目录。

## 2. 版本号

THEIA 使用语义化版本 `MAJOR.MINOR.PATCH`：

- `MAJOR`：出现不兼容的数据格式、配置或工作流变化。
- `MINOR`：增加向后兼容的新功能。
- `PATCH`：修复错误、改善性能或文档，不破坏现有数据。

版本号的源码单一事实来源是 `package.json`。创建发布前，以下位置必须一致：

- `package.json` 与 `package-lock.json` 的根包版本。
- `README.md` 的当前版本说明。
- `docs/RELEASE_NOTES.md` 的最新版本标题。
- 发布目录名、ZIP 文件名和 Git 标签。

正式 Git 标签使用 `vX.Y.Z`，例如 `v0.1.1`。标签只能指向已经通过检查的发布提交，不移动、不重复使用。

## 3. 产物命名

推荐名称：

```text
THEIA-X.Y.Z-portable\
THEIA-X.Y.Z-portable.zip
THEIA-X.Y.Z-portable.zip.sha256.txt
THEIA-release-X.Y.Z\
THEIA-release-X.Y.Z.zip
THEIA-release-X.Y.Z.zip.sha256.txt
```

同一版本需要重建但内容不同，应先修正版本号。只有整理历史产物时才保留 `r2`、日期等旧名称；新的正式发布不使用含义不清的 `latest`、`new` 或未命名目录。

## 4. 标准发布流程

在 `source` 中执行：

```powershell
git status --short --branch
npm ci
npm run lint
npm run build
```

工作区必须先干净。然后把新构建写入 staging：

```powershell
node release-tools/package-release.mjs ..\staging\v0.1.2\THEIA-release-0.1.2
npm run dist:exe -- ..\staging\v0.1.2\THEIA-0.1.2-portable
```

发布前至少检查：

1. 版本号与发布说明一致。
2. 源码包不含 `.git`、`node_modules`、运行状态、聊天、API Key、日志或头像缓存。
3. 便携版能在干净目录启动，运行数据写入 `%APPDATA%\THEIA`。
4. ZIP 可以完整列出并解压。
5. ZIP 的 SHA-256 已生成并复核。
6. README 图片和相对链接正常。

检查通过后，将 ZIP、校验文件和需要保留的解压目录移动到 `releases\vX.Y.Z`，再运行：

```powershell
npm run release:index
```

最后提交并标记：

```powershell
git add package.json package-lock.json README.md docs/RELEASE_NOTES.md
git commit -m "release: THEIA X.Y.Z"
git tag -a vX.Y.Z -m "THEIA X.Y.Z"
git push origin main
git push origin vX.Y.Z
```

## 5. 发布索引与校验

`npm run release:index` 默认把 `source` 的父目录视为工作根目录。也可以显式指定：

```powershell
node release-tools/update-release-index.mjs H:\work\THEIA
```

该工具会：

- 扫描 `releases\v*\artifacts` 中的 ZIP。
- 计算每个 ZIP 的 SHA-256。
- 检查同名 `.sha256.txt` 是否与实际文件一致。
- 统计 `extracted` 下每个目录的文件数和总大小。
- 原子更新 `INDEX.md`、`INDEX.json` 和 `SHA256SUMS.txt`。

`INDEX.json` 适合后续自动更新器或发布页面读取；`INDEX.md` 适合人工检查。正式分发前，随包校验文件和中央清单都应为最新状态。

## 6. Git 分支与标签

- `main` 始终保持可构建。
- 日常修改使用 `codex/*` 或功能分支，通过检查后合并。
- 发布标签固定且不可重写。
- 不把生成的便携目录、ZIP、个人运行数据或缓存提交到 Git。
- 紧急修复从目标标签创建分支，提升 PATCH 版本后重新完整发布。

## 7. 回滚

回滚代码时，不覆盖或删除用户运行数据：

1. 先备份 `%APPDATA%\THEIA`。
2. 从对应 Git 标签检出源码，或使用 `releases` 中已校验的旧便携包。
3. 核对 `SHA256SUMS.txt`。
4. 如果新版本改变了数据结构，先阅读该版本发布说明；没有明确兼容承诺时，不直接用旧版本写入新数据。

不要删除旧标签。旧发布物是否保留由下面的保留策略决定。

## 8. 保留策略

- 每个正式版本至少保留 ZIP、随包校验文件和 Git 标签。
- 当前版本和前一个版本可保留解压目录，便于快速回归测试。
- 更旧的解压目录可以在确认 ZIP 校验有效后清理以节省空间，但 ZIP 与校验文件继续保留。
- 历史测试构建放在对应版本的 `extracted` 或说明文件中明确标记，不伪装为首选发布。
- 删除任何大体积旧目录前，先确认中央 SHA-256 清单、随包校验文件和 Git 标签均存在。

## 9. 当前迁移基线

- `v0.1.0`：首个源码发布、多个历史源码快照和 Windows 便携版。
- `v0.1.1`：当前 Windows x64 便携版。
- `v0.2.0`：多 API 通道池、会话级并发调度与私聊联合提炼的源码版本。
- 当前 Git 仓库迁移到 `H:\work\THEIA\source`，保留现有提交、未提交改动和本地运行数据。

迁移完成后，`H:\work\THEIA\README.md` 和 `releases\INDEX.md` 是本机查找版本的两个入口。
