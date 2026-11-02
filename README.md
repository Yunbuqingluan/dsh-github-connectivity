# dsh-github-connectivity

给 DeepSeek Harness 用的 **GitHub 连接诊断**插件：逐层探测 DNS → TCP → TLS，判定“打不开”究竟卡在哪一层，然后给出**可直接复制的修复命令**。

A GitHub connectivity doctor for DeepSeek Harness: probes DNS → TCP → TLS for every GitHub host, names the blocking layer, and prints copy-ready fixes.

## 它做什么

- 探测 5 个端点：`github.com`、`api.github.com`、`codeload.github.com`、`raw.githubusercontent.com`、`objects.githubusercontent.com`
- 备用 IP 探测：优先复用本次**已验证可达**的其他 GitHub 边缘 IP，再用 `github.com` 的 SNI 去握手，确认“换个 IP 是否就好了”
- 读取本机现状：git 代理、代理环境变量、本机代理端口（7890/7897/10808…）、`~/.ssh/config` 是否已走 443
- 给出结论（下方判定表）与针对性命令：hosts 指定 IP、git 走代理、SSH 改走 443、镜像克隆，每条都带**验证**与**撤销**
- **一键应用 / 撤销**：面板上每项修复都有按钮。git 代理与 SSH 443 直接生效；hosts 会走一次 UAC 提权，改前自动备份原文件，撤销可完整还原

## 它不做什么

- **不提供任何翻墙通道**，也不代管浏览器。网页登录打不开时，只有系统级代理或 hosts 指定 IP 能解决
- **不改你没同意的东西**：每项改动都要你点「应用」→「确认」；hosts 提权由系统 UAC 弹窗把关，取消即不写入
- 不探测私有仓库，不上传任何数据；所有请求从本机直发 GitHub

## 判定表

| 结论 | 含义 | 典型处置 |
|---|---|---|
| `healthy` | 主站 TLS 正常 | 无需处理 |
| `ip-blocked` | 解析到的 IP 被丢包，但别的边缘 IP 可用 | hosts 指定可用 IP |
| `tls-reset` | TCP 通、TLS 握手被重置 | 可用 IP 或代理 |
| `main-unreachable` | 主站 IP 无响应，备用 IP 也没通 | 代理 / 镜像 / 稍后重试 |
| `proxy-available` | 全断，但本机有代理在跑 | 让 git 走该代理 |
| `partial` | 只有部分域名可用 | 按提示逐项修 |

## 三个入口

| 入口 | 位置 |
|---|---|
| 设置页 | 设置 → GitHub 连接 |
| 斜杠命令 | 输入框输入 `/github` |
| 智能体工具 | `github_connectivity`，说“GitHub 打不开”时会自动调用 |

## 安装

四种方式，任选一种。仓库根就是插件包，没有构建步骤，装完刷新页面即可。

### 1. 在图形界面里用地址添加（推荐）

DSH Desktop 或 `dsh web` 的 **设置 → 插件** 里找到安装入口，把下面任意一个地址粘进去即可（不需要命令行）：

```
https://github.com/Yunbuqingluan/dsh-github-connectivity
```

也接受 `github:` 简写：

```
github:Yunbuqingluan/dsh-github-connectivity
```

### 2. 命令行：GitHub 简写

```sh
dsh plugin --profile desktop add github:Yunbuqingluan/dsh-github-connectivity
```

把 `desktop` 换成你实际用的 profile（`dsh web` 默认是 `web`）。

### 3. 命令行：完整地址

```sh
# HTTPS git 地址，也可带 .git 后缀
dsh plugin --profile desktop add https://github.com/Yunbuqingluan/dsh-github-connectivity

# 锁定到某个提交，避免上游改动影响你（PowerShell 里必须加引号，否则 # 之后被当注释）
dsh plugin --profile desktop add "github:Yunbuqingluan/dsh-github-connectivity#a1b2c3d"
```

### 4. 本地目录（改代码 / 离线安装）

```powershell
git clone https://github.com/Yunbuqingluan/dsh-github-connectivity
dsh plugin --profile desktop add "link:D:\path\to\dsh-github-connectivity"
```

`link:` 是软链语义——改完源码重启即生效，适合自己调试；`file:` 也接受，由 pnpm 按本地包处理。直接给绝对路径同样可行（会被记成 `link:`）。

> 用 git 地址安装时，首次拉取会走 GitHub 本身。如果此时你正连不上 GitHub，先按下面的「一次性的手工恢复」把 `hosts` 里的 IP 写进去，再安装。

## 一次性的手工恢复（装不上插件时用）

插件本身解决的是「装不了插件」的场景，鸡生蛋问题得先手动破一次。管理员 PowerShell：

```powershell
$h = "$env:SystemRoot\System32\drivers\etc\hosts"
(Get-Content $h) | Where-Object { $_ -notmatch '^\s*[0-9a-f.:]+\s+github\.com(\s|$)' } | Set-Content $h -Encoding ascii
'140.82.112.3','140.82.112.4','140.82.113.3' | ForEach-Object { Add-Content $h -Value "$_ github.com" -Encoding ascii }
ipconfig /flushdns
```

写多个 IP 是为了失效切换：一个被掐，浏览器和 git 会试下一个。装好插件后，这些都可以交给面板上的按钮，点「撤销」即可还原。

## 配置

无需配置。探测会限流（并发上限 + 60 秒缓存），因为连续猛探本身就会把连接打到超时；设置页的「重新检测」会绕过缓存。

## License

MIT
