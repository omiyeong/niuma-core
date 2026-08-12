# Runtime 认证探测方式调研矩阵

> Phase 3 Task 0 产出。Task 2 的 `AuthProbeSpec` 实现以本文档为准。
> 本机实测环境：macOS（claude 2.1.161 / codex 0.130.0 / cursor-agent 2026.03.11 / hermes 0.9.0 / gemini 0.42.0 已装；kimi / opencode / antigravity(agy) 未装，相关条目标注「未实测」）。
> 通用约定：installProbe 用 `PATH` 查找二进制（等价 `which`），不跑 `--version`（部分 CLI 冷启动 >3s）；activeProbe 仅在静态层无法定论时低频执行；所有 probe 命令超时建议 10s（cursor 15s）。

## 总览

| runtime | 二进制 | 凭证文件（macOS/Linux） | API key env | activeProbe | 实测 |
|---|---|---|---|---|---|
| claude | `claude` | keychain / `~/.claude/.credentials.json` | ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN | `claude auth status --json` | ✅ |
| codex | `codex` | `~/.codex/auth.json` | OPENAI_API_KEY | `codex login status` | ✅ |
| kimi | `kimi` | `~/.kimi/config.toml` | MOONSHOT_API_KEY, KIMI_API_KEY | 无已知 auth-status | ❌ 未实测 |
| cursor | `cursor-agent` | keychain / `~/.cursor/cli-config.json` | CURSOR_API_KEY | `cursor-agent status` | ✅ |
| antigravity | `agy` | 未知 | 未知 | 未知 | ❌ 未实测 |
| gemini | `gemini` | `~/.gemini/oauth_creds.json` + `settings.json` | GEMINI_API_KEY, GOOGLE_API_KEY | 无 auth-status 子命令 | ✅ |
| opencode | `opencode` | `~/.local/share/opencode/auth.json` | 按 provider | `opencode auth list` | ❌ 未实测 |
| hermes | `hermes` | `~/.hermes/auth.json` + `config.yaml` | HERMES_CONFIG_PATH(配置) | `hermes auth list` | ✅ |

---

## claude（Claude Code）

- **installProbe**：`claude`（PATH）；验证命令 `claude --version`（实测输出 `2.1.161 (Claude Code)`，exit 0）。
- **credentialPaths**：
  - macOS：登录凭证在 Keychain（service `Claude Code-credentials`），无固定文件；`~/.claude.json` 的 `oauthAccount` 字段可作 oauth 登录痕迹（本机为 null，因走 API key）。
  - Linux：`~/.claude/.credentials.json`。
  - Windows：`%USERPROFILE%\.claude\.credentials.json`（未实测）。
  - 另：`~/.claude/settings.json` 的 `env` 可内嵌 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`（本机即此方式），静态层应一并检查。
- **apiKeyEnvVars**：`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`（配合 `ANTHROPIC_BASE_URL` 自建网关）；`CLAUDE_CONFIG_DIR` 改变配置根目录。
- **activeProbe**：`claude auth status --json`，**实测可用**。已认证时 exit 0，stdout 为 JSON：`{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}`。未登录时 `loggedIn:false`（exit code 未实测，应以 JSON 字段为准而非 exit code）。纯本地命令，无 API 调用费用。超时建议 10s。
- **authMethod 判定**：直接读 `auth status --json` 的 `authMethod` 字段（`api_key` / `oauth` 等）；静态层兜底：env 或 settings.json env 有 key → `api_key`，keychain/credentials.json 存在 → `oauth`。

## codex（Codex CLI）

- **installProbe**：`codex`（PATH）；`codex --version` 实测输出 `codex-cli 0.130.0`。
- **credentialPaths**：
  - macOS/Linux：`~/.codex/auth.json`（受 `CODEX_HOME` 改写）。本机实测结构：`{ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }`。
  - Windows：`%USERPROFILE%\.codex\auth.json`（未实测）。
- **apiKeyEnvVars**：`OPENAI_API_KEY`（配合 `OPENAI_BASE_URL`）；`CODEX_HOME` 改配置目录。
- **activeProbe**：`codex login status`，**实测可用**。已登录 exit 0，stdout `Logged in using ChatGPT`；未登录 exit 非 0（官方文档语义，本机未复测登出态）。纯本地命令，无 API 费用。超时建议 10s。
- **authMethod 判定**：读 `auth.json` 的 `auth_mode`：`chatgpt` → `oauth`；`OPENAI_API_KEY` 字段非 null 或 env 存在 → `api_key`。

## kimi（Kimi CLI）——未实测

- **installProbe**：`kimi`（PATH，daemon kimi-adapter spawn 同名命令）；验证 `kimi --version`。
- **credentialPaths**：`~/.kimi/config.toml`（model-detector 已读此文件，受 `KIMI_CONFIG_PATH` 改写）。API key 通常写在 config.toml provider 配置内；是否有独立 credentials 文件未实测。Windows：`%USERPROFILE%\.kimi\config.toml`（未实测）。
- **apiKeyEnvVars**：`MOONSHOT_API_KEY`、`KIMI_API_KEY`（runtime-env-allowlist 已收录）。
- **activeProbe**：未发现 auth-status 类子命令（本机未装无法跑 `--help`）。建议首版不做 activeProbe，静态判定为主；待装机后跑 `kimi --help` 补充。
- **authMethod 判定**：env 或 config.toml 含 api key → `api_key`；其余 → `unknown`。

## cursor（Cursor Agent CLI）

- **installProbe**：`cursor-agent`（PATH）；`cursor-agent --version` 实测输出 `2026.03.11-6dfa30c`。注意二进制名是 `cursor-agent` 不是 `cursor`（后者是 IDE 启动器）。
- **credentialPaths**：
  - macOS：Keychain（service `cursor-access-token` / `cursor-refresh-token`，本机实测存在）；`~/.cursor/cli-config.json` 的 `authInfo`（email/userId/teamId）可作登录痕迹但不含 token。
  - Linux：`~/.config/cursor/`（未实测，无 keychain 时 token 落文件）。
  - Windows：凭证管理器或 `%USERPROFILE%\.cursor\`（未实测）。
- **apiKeyEnvVars**：`CURSOR_API_KEY`。
- **activeProbe**：`cursor-agent status`（别名 `whoami`），**实测可用但有坑**：会主动刷新登录（输出 `Starting login process... Logged in`），带 TUI 转义序列且可能发起网络请求，本机耗时 >15s。建议超时 15s，按 stdout 含 `Logged in` 判定，不依赖 exit code；频率严格限制（启动 + 显式触发）。
- **authMethod 判定**：`CURSOR_API_KEY` env → `api_key`；keychain token / `cli-config.json` authInfo 存在 → `oauth`。

## antigravity（Antigravity CLI）——未实测

- **installProbe**：`agy`（PATH，daemon antigravity-cli-adapter 与 model-detector spawn 的命令名均为 `agy`）；验证 `agy --version`（未实测）。
- **credentialPaths**：未知（本机未装，公开资料少）。待装机后用 `agy --help` 与目录扫描补充。
- **apiKeyEnvVars**：未知（runtime-env-allowlist 中无 antigravity 专属条目）。
- **activeProbe**：未知。现有 model-detector 跑 `agy models`（15s 超时）可作弱信号：能列出模型大概率已认证。
- **authMethod 判定**：首版统一报 `authStatus: "unknown"`，不阻塞整体（计划风险提示已预留此路径）。

## gemini（Gemini CLI）

- **installProbe**：`gemini`（PATH）；`gemini --version` 实测输出 `0.42.0`。注意：gemini 当前**不在** shared `RuntimeId` 中，本节为后续接入预研。
- **credentialPaths**：
  - oauth 登录：`~/.gemini/oauth_creds.json`（本机不存在，因走 API key）；`~/.gemini/google_accounts.json`（`{active, old}`，本机 active 为 null）。
  - 认证方式记录：`~/.gemini/settings.json` 的 `security.auth.selectedType`（本机实测 `"gemini-api-key"`）。
  - macOS 另见 Keychain service `gemini-cli-api-key`（本机实测存在）。
  - Windows：`%USERPROFILE%\.gemini\`（未实测）。
- **apiKeyEnvVars**：`GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_APPLICATION_CREDENTIALS`（Vertex）。
- **activeProbe**：`gemini --help` 实测只有 `mcp` / `extensions` / `skills` / `hooks` 子命令，**无 auth-status 类命令**。静态判定为主；不建议跑会话类命令验证（有真实 API 费用）。
- **authMethod 判定**：读 `settings.json` `security.auth.selectedType`：`oauth-personal` → `oauth`；`gemini-api-key` / `vertex-ai` → `api_key`；oauth_creds.json 存在亦可判 `oauth`。

## opencode（OpenCode CLI）——未实测

- **installProbe**：`opencode`（PATH，daemon opencode-acp-adapter spawn 同名命令）；验证 `opencode --version`。
- **credentialPaths**：`~/.local/share/opencode/auth.json`（官方文档约定，遵循 XDG，受 `XDG_DATA_HOME` 改写；本机无此目录）。`~/.config/opencode/opencode.json` 是行为配置不是凭证（本机实测仅含 `mcp` 键）。Windows：`%USERPROFILE%\.local\share\opencode\auth.json` 或 XDG 等价（未实测）。
- **apiKeyEnvVars**：按 provider 透传（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等），无 opencode 专属 key var；`OPENCODE_CONFIG` 与 XDG 四件套已在 allowlist。
- **activeProbe**：`opencode auth list`（官方文档命令，列出已登录 provider，未实测）。装机后验证 exit code 语义再启用。
- **authMethod 判定**：`auth.json` 内按 provider 记录 `type`（oauth/api key）；静态层 env 有 provider key → `api_key`，auth.json 存在 → 需 activeProbe 细分，否则 `unknown`。

## hermes（Hermes Agent）

- **installProbe**：`hermes`（PATH）；`hermes --version` 实测输出 `Hermes Agent v0.9.0 (2026.4.13)`（Python CLI，冷启动约 2-4s）。
- **credentialPaths**：
  - `~/.hermes/auth.json`（本机实测结构：`{ version, providers, active_provider, updated_at, credential_pool }`；本机 providers 为空、凭证全在 credential_pool）。
  - `~/.hermes/config.yaml` 的 `custom_providers[].api_key`（model-detector 已解析此结构，受 `HERMES_CONFIG_PATH` 改写）。
  - Windows：`%USERPROFILE%\.hermes\`（未实测）。
- **apiKeyEnvVars**：`HERMES_CONFIG_PATH`（配置路径）；凭证池可引用任意 env（本机实测引用了 `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY`），无单一专属 key var。
- **activeProbe**：`hermes auth list`，**实测可用**，exit 0，按 provider 列出凭证及类型列（`api_key` / `oauth`）。纯本地命令。Python 启动慢，超时建议 15s 内、频率同低频档。
- **authMethod 判定**：取 `hermes auth list` 中 active（`←` 标记）凭证的类型列；静态层兜底：config.yaml 有 api_key → `api_key`，auth.json 有内容 → `unknown` 待 activeProbe。
