# Native Remote SSH for Gemini Web and ChatGPT / Gemini 网页版与 ChatGPT 原生 SSH

[English](#english) | [简体中文](#简体中文)

## English

This optional extension runs SSH commands **on the computer hosting DevSpace**. It uses the SSH alias and keys that already work on that machine. It does not mount the remote filesystem, copy the checkout, store a remote password, or require SSHFS.

### Prerequisites

- DevSpace Fork built and installed locally, with a working HTTPS MCP connector.
- OpenSSH client installed and working on the same computer as DevSpace.
- Passwordless key authentication verified with `ssh -o BatchMode=yes your-existing-ssh-alias true`.
- Python 3 and Bash available on the remote Linux machine.
- An existing project checkout on the remote host. Use a dedicated non-root SSH account.

### Configuration

Create a **local** file `~/.devspace/remote-ssh.json`, using [this safe example](../examples/remote-ssh.example.json):

```json
{
  "projects": [
    {
      "name": "example-project",
      "host": "your-existing-ssh-alias",
      "root": "/home/your-user/your-project"
    }
  ]
}
```

The `host` value is an SSH **alias** from your existing `~/.ssh/config`, not a password. Project names must be unique. Project roots must be absolute POSIX directories. This file is private runtime configuration and **must never be committed** with real hosts or internal project paths. Restart DevSpace to register the remote tools. Absence of this file leaves the remote tool surface disabled; existing local ChatGPT tools are unchanged.

### Gemini Web

Open Gemini Web → Settings → Connected Apps → Add a custom MCP app, or Developer Mode. Connect to your existing `https://YOUR-TUNNEL-HOST/mcp` using OAuth dynamic client registration. This Fork adds Google redirect hostnames to defaults; if your `config.jsonc` overrides `oauth.allowedRedirectHosts`, merge the Google hostnames into the existing list without removing ChatGPT entries.

On first connection, authorize DevSpace through its Owner-password screen. Do not put your password into the AI chat or the MCP client secret field.

Ask Gemini to call:

```text
@DevSpace
Use remote_ssh_open with name "example-project".
Read the returned workspace_id, call remote_ssh_status, then
remote_ssh_read on README.md. Read only; do not make changes.
Do not open my local home directory or use SSHFS.
```

### Tool behavior

- `remote_ssh_open`: one SSH connection; validates the configured project and returns a short-lived `rss_...` workspace ID.
- `remote_ssh_read`: UTF-8 text with line offset/limit and full-file SHA-256 for concurrent-edit safety.
- `remote_ssh_edit`: exact-text replacements after checking `expected_sha256`; refuses stale edits and writes atomically.
- `remote_ssh_write`: creates a new file or replaces an existing file when its SHA-256 matches. Paths are relative to the approved remote root.
- `remote_ssh_exec`: executes Bash on the remote host in the project directory, with the remote account's permissions. **Shell commands are not confined to that directory**.
- `remote_ssh_status`: a read-only remote Git status in one SSH connection.

The read/write/edit tools reject path traversal and symlinks that escape the configured project. They refuse direct `.git` file edits and restrict individual files to 1 MiB. An SSH command may access anything the remote Unix user can access, so use a least-privilege account and explicitly confirm destructive operations.

The workspace ID is kept in memory and must be reopened after the DevSpace server restarts. This extension intentionally does not change the persistence model of existing local workspaces.

### Performance and troubleshooting

The remote tools avoid expensive recursive scanning of the local home directory. Native SSH startup still adds network latency. On one Windows-to-Linux test, remote open took 699 ms and Git status 343 ms; results vary by network and machine. Gemini model latency and the HTTPS tunnel are **additional** and are not covered by these measurements.

If you see `MCP request timed out`, first ask which exact tool was called. Never retry `open_workspace("~")` for a remote project; it can recursively scan the full local home directory. Use `remote_ssh_open` instead. If the remote tool is missing, confirm the config file is in the DevSpace owner's home directory, the new Fork is actually running, and DevSpace has been restarted. If SSH fails, run the batch-mode check locally and verify host key trust. The code uses noninteractive SSH and does not ask for a password.

Keep ChatGPT's existing `/mcp` URL, OAuth database, and local workspace roots unchanged during migration. Build and test the Fork in an isolated checkout before switching the installed service.

## 简体中文

该功能直接使用**运行 DevSpace 的本机 SSH 客户端**和已有公钥，连接远程 Linux 项目；**无需 SSHFS、目录挂载或本地代码镜像**。

### 使用前提

- 本机已安装、构建这个 DevSpace Fork，且 HTTPS MCP 连接可用。
- 在 DevSpace 运行的同一台电脑上，可以执行 `ssh -o BatchMode=yes your-existing-ssh-alias true`，无需密码。
- 远程 Linux 已有 Python 3、Bash 和项目目录。
- 建议使用权限受限的普通用户，不要使用 root。

### 本地配置

在运行 DevSpace 的电脑创建 `~/.devspace/remote-ssh.json`：

```json
{
  "projects": [
    {
      "name": "example-project",
      "host": "your-existing-ssh-alias",
      "root": "/home/your-user/your-project"
    }
  ]
}
```

`host` 使用本机 SSH 配置里的别名，`root` 是远程 Linux 上实际存在的**绝对项目目录**。配置不保存密码或私钥。请勿将包含真实服务器信息的本地文件提交到 GitHub。修改后需要重启 DevSpace；不配置该文件则隐藏新增的远程工具，原有 ChatGPT 本地工具不变。

### Gemini 网页版

打开 Gemini 网页版的「设置 → 已连接的应用 → 添加自定义 MCP 服务」或开发者模式，输入原有 `https://YOUR-TUNNEL-HOST/mcp`，选择 OAuth 动态客户端注册，并在 DevSpace 授权页面完成 Owner password 授权。客户端 ID 和密钥通常可以留空；此处不要输入 SSH 密码。

在对话中输入：

```text
@DevSpace 请使用 remote_ssh_open(name="example-project")。
使用其返回的 workspace_id 执行 remote_ssh_status，
然后 remote_ssh_read(path="README.md")。本次只读。
不要用本地 open_workspace("~")，不要使用 SSHFS。
```

### 工具及安全

`remote_ssh_open` 验证远程项目并建立短期工作区 ID；`remote_ssh_read` 读取 UTF-8 文件并返回 SHA-256；`remote_ssh_edit` 和 `remote_ssh_write` 在更新前验证文件哈希并进行原子替换；`remote_ssh_exec` 远程执行 Bash；`remote_ssh_status` 获取 Git 状态。

文件工具限制在配置的远程项目目录内，拒绝 `..` 路径穿越以及逃出目录的软链接，拒绝直接修改 `.git`。单文件上限为 1 MiB。**但远程命令以 SSH 用户权限运行，不属于目录沙箱**，因此必须严格控制用户权限并确认破坏性命令。

DevSpace 重启后需要再次调用 `remote_ssh_open` 获取工作区 ID。该功能不改变原有本地工作区 ID 和 ChatGPT 授权数据库。

### 延迟与故障排查

专用远程工具避免递归扫描本地用户主目录。一次 Windows→Linux 只读实测：打开远程项目 699 ms、远程 Git 状态 343 ms；公网 HTTPS 往返和 Gemini 模型生成时间另计。

遇到 `DEADLINE_EXCEEDED` 时先确认具体调用了哪个工具。不要用 `open_workspace("~")` 访问远程项目。若 Gemini 没看到新增工具，请确认实际运行的是本 Fork、配置位于 DevSpace 运行用户的主目录、服务已重启。若 SSH 失败，请先在本机验证 BatchMode、公钥与主机密钥信任。

上线前请保留 ChatGPT 的原有 `/mcp` 地址、OAuth 数据库及 allowedRoots，先在隔离端口验证新构建版本。
