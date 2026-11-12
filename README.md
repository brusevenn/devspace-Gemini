# DevSpace — Gemini CLI fork

[简体中文](#简体中文) | [English](#english)

A Gemini CLI-ready fork of [DevSpace](https://github.com/Waishnav/devspace), the local coding-workspace MCP server. It lets Gemini CLI securely access selected folders on your computer through a remote Streamable HTTP MCP endpoint, and lets the host use DevSpace's workspace tools.

> **Scope:** This fork targets **Gemini CLI** and its MCP integration. It is not an integration for the consumer Gemini web or mobile app. The Gemini CLI uses a loopback OAuth callback and a browser on the same machine where the CLI is running.

**Upstream:** [Waishnav/devspace](https://github.com/Waishnav/devspace) · **License:** MIT

---

## English

### 1. Requirements

- Node.js **22.19 or newer, but below 27**
- Git and a Bash-compatible shell
- pnpm **11.25.0**
- [Gemini CLI](https://geminicli.com/docs/)

On Windows, install Git for Windows and use Git Bash or WSL. PowerShell alone is not a supported DevSpace shell.

### 2. Build and install this fork

The Gemini host-detection changes in this repository are not part of the upstream npm release. Build this fork locally:

```bash
git clone https://github.com/brusevenn/devspace-Gemini.git
cd devspace-Gemini

npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm build

# Register the built CLI globally.
npm link

devspace --help
```

Run these commands in Git Bash or WSL on Windows. Do not install the upstream npm package if you specifically need this fork's Gemini detection changes.

### 3. Start a public HTTPS tunnel

DevSpace listens locally on **127.0.0.1:7676** by default. Gemini CLI connects to the public HTTPS URL of a tunnel that forwards to that local port.

Choose one tunnel provider and keep it running in a separate terminal:

```bash
# Cloudflare Quick Tunnel (temporary hostname)
cloudflared tunnel --url http://127.0.0.1:7676

# Or ngrok
ngrok http 7676

# Or Tailscale Funnel
tailscale funnel --bg 7676
```

Copy the HTTPS origin returned by the provider. Do not append /mcp when setting the public origin.

### 4. Initialize and start DevSpace

Replace the example hostname and workspace path with your own values:

```bash
devspace init --yes \
  --public-url https://YOUR-TUNNEL-HOST \
  --roots "$HOME/work"

# If DevSpace was initialized already, update its public origin instead:
devspace config set publicBaseUrl https://YOUR-TUNNEL-HOST

devspace serve
```

Keep DevSpace and the tunnel running. The reverse proxy must forward the whole server origin, not only the /mcp path, because OAuth discovery and authorization endpoints also live outside /mcp.

### 5. Add DevSpace to Gemini CLI

Run this in another terminal:

```bash
gemini mcp add --transport http --scope user devspace https://YOUR-TUNNEL-HOST/mcp
gemini mcp list
```

Alternatively, add the following server entry to your Gemini CLI settings file (usually **~/.gemini/settings.json**):

```json
{
  "mcpServers": {
    "devspace": {
      "httpUrl": "https://YOUR-TUNNEL-HOST/mcp",
      "timeout": 600000
    }
  }
}
```

Gemini CLI supports remote HTTP MCP servers, OAuth discovery, and dynamic client registration. On first connection, it should open a browser for authorization. In the Gemini CLI session, you can also run:

```text
/mcp auth devspace
```

On the DevSpace approval page, verify that the client is Gemini CLI and enter the DevSpace Owner password. The password is stored locally in **~/.devspace/auth.json**. Never paste it into chat or commit it to Git.

**OAuth callback note:** Gemini CLI normally redirects the browser to **http://localhost:<random-port>/oauth/callback**. DevSpace's default OAuth redirect allowlist already includes localhost and 127.0.0.1, so no Google-specific callback domain needs to be added. If you replace the default allowlist in your config, retain localhost and 127.0.0.1.

Gemini CLI needs a local browser and must be able to receive that loopback callback. Headless sessions and remote SSH sessions without browser forwarding are not suitable for this OAuth flow.

### 6. Verify the connection and use a workspace

In Gemini CLI, run:

```text
/mcp
```

Or from your shell:

```bash
gemini mcp list
```

Ask Gemini CLI to open a project inside one of the roots you allowed during initialization. DevSpace will provide a workspace ID; Gemini should reuse it for subsequent file and shell operations. The host can read, write, and edit files, run commands, and call **show_changes** to review the resulting diff.

This fork recognizes Gemini CLI OAuth client names and User-Agent strings. Gemini CLI is mapped to DevSpace's general MCP tool surface (**write**, **edit**, **bash**), rather than the Codex-specific **apply_patch** and **exec_command** surface.

### 7. Security and troubleshooting

- Only expose folders you intentionally trust. Set a narrow **--roots** list; an empty list falls back to the current working directory.
- Treat an authorized MCP client as a local coding partner: the shell tool runs with the operating-system permissions of the DevSpace process.
- Keep the Owner password, **auth.json**, OAuth database, and tunnel credentials private. They are local runtime state and must not be committed.
- If the connection fails, check that the tunnel forwards to port 7676, that **publicBaseUrl** is the HTTPS origin without **/mcp**, and that the server is running.
- If OAuth says the redirect URI is not allowed, check that **localhost** and **127.0.0.1** remain in **oauth.allowedRedirectHosts**.
- If Gemini CLI cannot complete OAuth, update Gemini CLI, start it in a local interactive terminal with browser access, and run **/mcp auth devspace** again.
- To remove the server from Gemini CLI, run **gemini mcp remove devspace**.

### 8. Development checks

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

For the full upstream architecture, configuration reference, and security model, see the [DevSpace documentation](https://devspace.run/docs). For Gemini CLI's MCP configuration and OAuth behavior, see the [official Gemini CLI MCP guide](https://geminicli.com/docs/tools/mcp-server/).

---

## 简体中文

### 1. 环境要求

- Node.js **22.19 或更高版本，且低于 27**
- Git 与 Bash 兼容终端
- pnpm **11.25.0**
- [Gemini CLI](https://geminicli.com/docs/)

Windows 用户请安装 Git for Windows，并使用 Git Bash 或 WSL。仅使用 PowerShell 不属于 DevSpace 当前支持的 Shell 环境。

### 2. 从本仓库构建并安装

本仓库中的 Gemini 客户端识别修改尚未包含在上游 npm 发布包中。请从本 Fork 本地构建：

```bash
git clone https://github.com/brusevenn/devspace-Gemini.git
cd devspace-Gemini

npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm build

# 将构建后的 CLI 注册为全局命令
npm link

devspace --help
```

Windows 请在 Git Bash 或 WSL 中执行。如果需要本 Fork 的 Gemini 识别逻辑，不要直接安装上游 npm 包。

### 3. 建立 HTTPS 公网隧道

DevSpace 默认监听本机 **127.0.0.1:7676**。Gemini CLI 通过 HTTPS 隧道访问该本地服务。

选择一种隧道服务，并在独立终端中保持运行：

```bash
# Cloudflare 临时隧道
cloudflared tunnel --url http://127.0.0.1:7676

# 或 ngrok
ngrok http 7676

# 或 Tailscale Funnel
tailscale funnel --bg 7676
```

复制服务提供的 HTTPS 域名。配置公网地址时不要在末尾添加 /mcp。

### 4. 初始化并启动 DevSpace

将示例域名和工作目录替换成你自己的值：

```bash
devspace init --yes \
  --public-url https://YOUR-TUNNEL-HOST \
  --roots "$HOME/work"

# 如果已经初始化过，只需更新公网地址：
devspace config set publicBaseUrl https://YOUR-TUNNEL-HOST

devspace serve
```

保持 DevSpace 和隧道进程运行。反向代理必须转发整个服务域名下的请求，不能只转发 /mcp，因为 OAuth 发现、授权等端点也位于 /mcp 之外。

### 5. 在 Gemini CLI 中添加 DevSpace

在另一个终端执行：

```bash
gemini mcp add --transport http --scope user devspace https://YOUR-TUNNEL-HOST/mcp
gemini mcp list
```

也可以手动编辑 Gemini CLI 配置文件（通常为 **~/.gemini/settings.json**），加入以下内容：

```json
{
  "mcpServers": {
    "devspace": {
      "httpUrl": "https://YOUR-TUNNEL-HOST/mcp",
      "timeout": 600000
    }
  }
}
```

Gemini CLI 支持远程 HTTP MCP、OAuth 自动发现和动态客户端注册。首次连接时，CLI 应打开浏览器完成授权。也可以在 Gemini CLI 会话中执行：

```text
/mcp auth devspace
```

在 DevSpace 授权页面确认客户端是 Gemini CLI，然后输入 DevSpace Owner password。密码保存在本机 **~/.devspace/auth.json** 中。不要将密码粘贴到聊天中，也不要提交到 Git。

**OAuth 回调说明：** Gemini CLI 通常会将浏览器重定向到 **http://localhost:<random-port>/oauth/callback**。DevSpace 默认允许 localhost 和 127.0.0.1，因此无需额外添加 Google 专属回调域名。如果你手动覆盖了 OAuth 回调白名单，请保留 localhost 和 127.0.0.1。

Gemini CLI 必须能够在本机打开浏览器，并接收发往本机回环地址的 OAuth 回调。无浏览器的 Headless 环境，以及没有浏览器转发能力的远程 SSH 会话，不适合此 OAuth 流程。

### 6. 验证连接并使用工作区

在 Gemini CLI 中执行：

```text
/mcp
```

也可以在 Shell 中查看：

```bash
gemini mcp list
```

让 Gemini CLI 打开初始化时允许访问目录中的某个项目。DevSpace 会返回 workspace ID；后续文件读写和命令执行应继续复用该 ID。Gemini 可以读取、创建和编辑文件，运行命令，并通过 **show_changes** 查看最终变更。

本 Fork 会识别 Gemini CLI 的 OAuth 客户端名称和 User-Agent，并将其映射到 DevSpace 的通用 MCP 工具面（**write**、**edit**、**bash**），而不是 Codex 专用的 **apply_patch** 和 **exec_command** 工具面。

### 7. 安全与故障排查

- 只开放你明确允许访问的目录。使用范围尽可能小的 **--roots**；如果目录列表为空，DevSpace 会回退到当前工作目录。
- 获得授权的 MCP 客户端相当于本机代码协作者：Shell 工具以 DevSpace 进程的操作系统权限执行命令。
- Owner password、**auth.json**、OAuth 数据库和隧道凭据均属于本地运行时私密数据，禁止提交到 Git。
- 如果连接失败，检查隧道是否转发到 7676 端口、**publicBaseUrl** 是否为不带 **/mcp** 的 HTTPS 根地址，以及 DevSpace 服务是否正在运行。
- 如果提示 OAuth redirect URI 不允许，检查 **oauth.allowedRedirectHosts** 是否仍包含 **localhost** 和 **127.0.0.1**。
- 如果 Gemini CLI 无法完成 OAuth，请升级 Gemini CLI，在可打开浏览器的本机交互终端中启动，再执行 **/mcp auth devspace**。
- 如需移除 Gemini CLI 中的服务配置，执行 **gemini mcp remove devspace**。

### 8. 开发与测试

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

DevSpace 的完整架构、配置和安全说明请参阅[上游文档](https://devspace.run/docs)。Gemini CLI 的 MCP 配置与 OAuth 行为请参阅 [Gemini CLI 官方 MCP 指南](https://geminicli.com/docs/tools/mcp-server/)。

---

This repository is a fork of [Waishnav/devspace](https://github.com/Waishnav/devspace). Original project copyright and MIT license terms remain applicable.
