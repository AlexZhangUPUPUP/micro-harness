# 支持矩阵

本文记录当前发布候选的真实支持范围。未列入的组合视为未验证，不自动承诺兼容。

| 维度 | 已验证范围 | 证据 |
| --- | --- | --- |
| macOS | Apple Silicon（本地 GUI、Server、CLI） | 本地 `bun test`、`bun run typecheck`、GUI build；Release workflow 构建 darwin-arm64 |
| Linux | x86_64（Server、CLI、SQLite、MCP/ACP） | CI Ubuntu 路径；Release workflow 构建 linux-x64 |
| Bun | 1.4.3 | `package.json` engines、CI/Release 固定版本、冻结 `bun.lock` |
| Windows | 未承诺 | shell 进程组、沙箱和发布产物尚未形成支持证据 |
| 沙箱 | Linux bubblewrap；不可用时测试显式跳过 | `.github/workflows/ci.yml` sandbox job |
| MCP | stdio、streamable HTTP；取消、Range 外部资源和显式重连已覆盖 mock 测试 | `packages/core/test/mcp.test.ts` |
| ACP | 本地协议夹具和会话状态路径 | `packages/core/test/acp.test.ts` |
| Provider | Provider 接口与能力声明 | `packages/core/test/context-provider.test.ts`、Server `/api/provider` |

CI 主测试矩阵覆盖 Ubuntu 与 macOS；Release 另外构建 darwin-arm64 和 linux-x64 单文件 CLI。

## 发布检查

发布前至少执行：

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
cd packages/gui && bun run build
```

真实模型、外部 MCP 服务和非 Linux 沙箱组合必须单独标记为实验性，并记录模型、配置、代码版本和费用口径。
