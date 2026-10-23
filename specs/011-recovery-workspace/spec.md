# 011 恢复与工作区治理

目标：进程中断或重启后恢复任务状态、执行账本、产物和 worktree，保留用户修改，禁止重复未知副作用。验收覆盖日志尾损坏、工具执行中断、审批等待中断和集成中断。

当前已交付：SQLite 事实来源、迁移/导出/恢复命令、失败工作区清理、ArtifactStore、SSE 增量恢复。剩余重点是启动恢复扫描、文件基线归属和受保护撤销。

新增只读 worktree 扫描，恢复和审查流程可识别 Git 登记的工作区是 clean、dirty、missing 或 unknown；扫描不会自动删除或覆盖用户产物。

Server 启动会把 SQLite 中遗留的 active 会话收敛为 error，并追加 `server restarted while the session was active` 事件；用户可通过 resume 重建上下文继续执行。

成功执行留下的 worktree 供人工审阅；取消、失败和服务停止中的运行在完成后自动清理。

Artifact 生命周期通过 `artifact.created`/`artifact.deleted` 事件关联到会话。
