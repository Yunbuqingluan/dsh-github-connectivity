/**
 * GitHub 连接诊断 · Host 半侧
 *
 * 逐层探测（DNS → TCP → TLS）本机到 GitHub 各服务的连通性，判定卡在哪一层，
 * 并给出可直接复制的修复命令。所有探测都在本机发起，不经过任何第三方中转，
 * 也不修改系统配置：修复命令由用户自己执行。
 */
import dns from 'node:dns/promises'
import https from 'node:https'
import net from 'node:net'
import fs from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const ROUTE_PATH = '/plugin/github-connectivity'
const TIMEOUT_MS = 6000
const PROXY_PORTS = [7890, 7891, 7897, 10808, 10809, 1080, 8889, 8080]

const ENDPOINTS = [
  { id: 'github', host: 'github.com', path: '/', label: 'github.com（网页 / 登录）' },
  { id: 'api', host: 'api.github.com', path: '/', label: 'api.github.com（REST API）' },
  { id: 'codeload', host: 'codeload.github.com', path: '/', label: 'codeload.github.com（克隆 / zip）' },
  { id: 'raw', host: 'raw.githubusercontent.com', path: '/', label: 'raw.githubusercontent.com（原始文件）' },
  { id: 'objects', host: 'objects.githubusercontent.com', path: '/', label: 'objects.githubusercontent.com（Release 附件）' },
]

/**
 * 备用 IP 的种子。实测更可靠的做法是优先复用“本次已经验证可达的 GitHub 边缘 IP”
 * （api / codeload / objects 与主站共用同一套前置），这里只作为补充。
 */
// 140.82.112.0/24 与 140.82.113.0/24 是 GitHub 真正的网页边缘；
// 20.27.177.x / 20.205.243.x 多为 api 边缘，会对 Host: github.com 回 400。
const CANDIDATE_IPS = [
  '140.82.112.3',
  '140.82.112.4',
  '140.82.113.3',
  '20.27.177.113',
  '20.27.177.114',
]

const CACHE_MS = 60_000
let cachedReport = null
let cachedAt = 0

/** 限流并发：一次性向同一出口发太多请求，本身就会把连接打到超时。 */
async function runLimited(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function tcpProbe(host, port, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const socket = net.connect({ host, port })
    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ms: Date.now() - started, ...result })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish({ ok: true }))
    socket.once('timeout', () => finish({ ok: false, error: 'ETIMEDOUT' }))
    socket.once('error', (err) => finish({ ok: false, error: err?.code ?? String(err?.message ?? err) }))
  })
}

function httpsProbe({ host, servername, reqPath = '/', timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve({ ms: Date.now() - started, ...result })
    }
    const request = https.request({
      host,
      port: 443,
      servername: servername ?? host,
      path: reqPath,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        host: servername ?? host,
        'user-agent': 'dsh-github-connectivity-doctor/1.0',
        accept: '*/*',
        connection: 'close',
      },
    }, (response) => {
      const peer = response.socket?.getPeerCertificate?.()
      const status = response.statusCode ?? 0
      const certCN = peer?.subject?.CN ?? null
      response.resume()
      finish({ ok: true, status, certCN })
    })
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    request.on('error', (err) => finish({ ok: false, error: err?.code ?? String(err?.message ?? err) }))
    request.end()
  })
}

async function probeEndpoint(endpoint, timeoutMs) {
  let addresses = []
  let dnsError = null
  try {
    addresses = await dns.lookup(endpoint.host, { all: true })
  } catch (err) {
    dnsError = err?.code ?? String(err?.message ?? err)
  }
  const ips = addresses.map((entry) => entry.address)
  const ip = ips[0] ?? null
  const tcp = ip ? await tcpProbe(ip, 443, timeoutMs) : { ok: false, error: 'DNS_FAILED' }
  const tls = tcp.ok
    ? await httpsProbe({ host: ip, servername: endpoint.host, reqPath: endpoint.path, timeoutMs })
    : { ok: false, error: 'SKIPPED' }
  return { id: endpoint.id, host: endpoint.host, label: endpoint.label, ip, ips, dnsError, tcp, tls }
}

function parseIni(text) {
  const entries = []
  let section = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[(.*)\]$/.exec(line)
    if (header) {
      section = header[1].trim()
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    entries.push({
      section,
      key: line.slice(0, eq).trim().toLowerCase(),
      value: line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1'),
    })
  }
  return entries
}

async function readGitConfig() {
  const home = os.homedir()
  const files = [path.join(home, '.gitconfig'), path.join(home, '.config', 'git', 'config')]
  const result = { files: [], proxy: null, insteadOf: [] }
  for (const file of files) {
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    result.files.push(file)
    for (const entry of parseIni(text)) {
      const section = entry.section.toLowerCase()
      if ((section === 'http' || section === 'https') && entry.key === 'proxy' && !result.proxy) {
        result.proxy = entry.value
      }
      if (/^url\s+"/i.test(section) && entry.key === 'insteadof') {
        result.insteadOf.push({ base: entry.section.slice(5, -1), target: entry.value })
      }
    }
  }
  return result
}

async function readSshConfig() {
  const file = path.join(os.homedir(), '.ssh', 'config')
  try {
    const text = (await fs.readFile(file, 'utf8')).replace(/\r/g, '')
    const block = /(^|\n)\s*host\s+github\.com\b([\s\S]*?)(?=\n\s*host\s|\s*$)/i.exec(text)?.[2] ?? ''
    const hostName = /hostname\s+(\S+)/i.exec(block)?.[1] ?? ''
    const port = /port\s+(\d+)/i.exec(block)?.[1] ?? ''
    return { file, present: true, hostName, port, over443: port === '443' || /ssh\.github\.com/i.test(text) }
  } catch {
    return { file, present: false, hostName: '', port: '', over443: false }
  }
}

async function readLocalProxies() {
  const open = []
  await Promise.all(PROXY_PORTS.map(async (port) => {
    const probe = await tcpProbe('127.0.0.1', port, 400)
    if (probe.ok) open.push(port)
  }))
  open.sort((a, b) => a - b)
  return open
}

function readProxyEnv() {
  const env = {}
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

// TLS 握手成功不等于能用：api/codeload 的边缘 IP 会对 Host: github.com
// 回 400（页面上就是 "Whoa there! You have sent an invalid request."）。
// 所以“可用”必须同时满足握手成功且 HTTP 层真的返回了内容。
function isUsable(probe) {
  const status = Number(probe?.tls?.status)
  return Boolean(probe?.tls?.ok) && status >= 200 && status < 400
}

// 面板给的手动命令必须和当前系统一致：macOS / Linux 上贴 PowerShell 是无效指引。
const IS_WINDOWS = process.platform === 'win32'

// 证书类 TLS 错误：连接建立成功，但校验失败。和“被重置”要分开处理。
const CERT_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

function diagnose({ endpoints, candidates, proxies, proxyEnv }) {
  const main = endpoints.find((entry) => entry.id === 'github')
  const workingIps = candidates.filter((entry) => isUsable(entry)).map((entry) => entry.ip)
  const alive = endpoints.filter((entry) => isUsable(entry))

  if (main?.tls?.ok && !isUsable(main)) {
    return {
      code: 'http-rejected',
      severity: 'warn',
      title: `TLS 通了，但 GitHub 拒绝了请求（HTTP ${main.tls.status}）`,
      detail: '握手到了 GitHub 的边缘节点，但该节点不服务 github.com（常见于把域名指到了 api/codeload 的 IP，页面会显示 “Whoa there! You have sent an invalid request.”）。换成真正服务 github.com 的 IP，或先撤销 hosts 固定。',
    }
  }
  if (isUsable(main)) {
    return {
      code: 'healthy',
      severity: 'ok',
      title: 'GitHub 主站直连正常',
      detail: `github.com 的 TLS 握手完成（HTTP ${main.tls.status}），当前网络可直接打开网页并登录。`,
    }
  }
  // 证书类失败和“握手被切断”是两件事：前者连接其实通了，是校验没过
  // （公司代理 / 杀毒软件做 HTTPS 扫描、系统根证书被改）。固定 IP 对这种
  // 情况完全无效，必须单独判出来，否则会一直推荐一个不可能生效的修复。
  const certError = String(main?.tls?.error ?? '')
  if (main?.tcp?.ok && !main?.tls?.ok && CERT_ERRORS.has(certError)) {
    return {
      code: 'tls-cert',
      severity: 'warn',
      title: 'TLS 握手被本机证书链挡下（不是被墙）',
      detail: `握手报 ${certError}：网络其实通到了 GitHub，是证书校验没通过——常见于公司代理或安全软件开启 HTTPS 扫描，或系统根证书被改过。固定 IP 治不了这个，需要安装对方提供的根证书、关掉 HTTPS 扫描，或改走代理。`,
    }
  }
  if (main?.tcp?.ok && !main?.tls?.ok) {
    return {
      code: 'tls-reset',
      severity: 'warn',
      title: 'TCP 连得上，但 TLS 握手被重置',
      detail: '典型的针对性阻断：能建立到 443 的连接，握手阶段连接被切断。换用可用 IP 或用代理都能解决。',
    }
  }
  if (workingIps.length > 0) {
    return {
      code: 'ip-blocked',
      severity: 'warn',
      title: `主站解析到的 IP 被丢包，但 ${workingIps[0]} 可用`,
      detail: `github.com 当前解析到 ${main?.ip ?? '未知 IP'}（连接超时），而 ${workingIps.slice(0, 3).join('、')} 能完成 TLS 握手并返回 200。把域名指到可用 IP 即可恢复网页访问。`,
    }
  }
  if (main && !main.tcp?.ok) {
    return {
      code: 'main-unreachable',
      severity: 'error',
      title: `github.com 无响应（解析到 ${main.ip ?? '未知 IP'}）`,
      detail: `到 ${main.ip ?? '该 IP'} 的 443 端口连接 ${main.tcp?.error ?? '失败'}，本次备用 IP 也没有握手成功。通常是出口对该 IP 段做了封锁，或当前网络抖动；可以稍后重试、换用代理，或改用镜像拉取公开仓库。`,
    }
  }
  if (proxies.length > 0 || Object.keys(proxyEnv).length > 0) {
    return {
      code: 'proxy-available',
      severity: 'warn',
      title: '直连全部失败，但本机已有代理',
      detail: proxies.length > 0
        ? `检测到本机代理端口 ${proxies.join('、')} 在监听。让 git 走这个代理即可，浏览器请自行在代理软件里开启系统代理。`
        : '检测到代理环境变量，但 Github 直连仍然失败；请确认代理软件正在运行并允许局域网/本机连接。',
    }
  }
  if (alive.length > 0) {
    return {
      code: 'partial',
      severity: 'warn',
      title: '只有部分 GitHub 域名可用',
      detail: `可用的有 ${alive.map((entry) => entry.host).join('、')}；其余域名不通，克隆或下载会随机失败。`,
    }
  }
  return {
    code: 'blocked',
    severity: 'error',
    title: 'GitHub 相关域名全部不通',
    detail: 'DNS 解析到的 IP 都无法完成 TLS 握手。需要一条可用的出网通道（代理或指定的可用 IP），插件本身不提供这类通道。',
  }
}

function buildFixes(context) {
  const { diagnosis, candidates, proxies, proxyEnv, main, git, ssh } = context
  const fixes = []
  const workingIps = candidates.filter((entry) => isUsable(entry)).map((entry) => entry.ip)
  const proxyPort = proxies[0] ?? null
  const proxyUrl = proxyEnv.HTTPS_PROXY ?? proxyEnv.https_proxy ?? proxyEnv.ALL_PROXY ?? proxyEnv.all_proxy
    ?? (proxyPort ? `http://127.0.0.1:${proxyPort}` : null)

  if (workingIps.length > 0 && diagnosis.code !== 'healthy') {
    const pinList = workingIps.slice(0, 4)
    const pinArgs = pinList.map((ip) => `'${ip}'`).join(',')
    fixes.push({
      id: 'hosts-pin',
      title: `把 github.com 指到 ${pinList.length} 个可用 IP（${pinList[0]} 等）`,
      why: 'DNS 返回的 IP 被丢包时，hosts 里指定实测可用的 GitHub 边缘 IP 就能恢复网页与登录；证书仍按 github.com 校验，不需要关闭任何安全检查。写多个 IP 是为了失效切换：一个被掐，浏览器试下一个。',
      elevated: true,
      applicable: IS_WINDOWS,
      commands: IS_WINDOWS
        ? [
          `$h = "$env:SystemRoot\\System32\\drivers\\etc\\hosts"; (Get-Content $h) | Where-Object { $_ -notmatch '^\\s*[0-9a-f.:]+\\s+github\\.com(\\s|$)' } | Set-Content $h -Encoding ascii; ${pinArgs} | ForEach-Object { Add-Content $h -Value "$_ github.com" -Encoding ascii }`,
          'ipconfig /flushdns',
        ]
        : [
          'sudo cp /etc/hosts "/etc/hosts.bak-$(date +%s)"',
          `sudo sed -i'' -E '/[[:space:]]github\\.com$/d' /etc/hosts`,
          ...pinList.map((ip) => `echo "${ip} github.com" | sudo tee -a /etc/hosts > /dev/null`),
          'sudo dscacheutil -flushcache 2>/dev/null; sudo killall -HUP mDNSResponder 2>/dev/null; sudo resolvectl flush-caches 2>/dev/null; true',
        ],
      verify: IS_WINDOWS
        ? ['Resolve-DnsName github.com -Type A | Select-Object -First 4', 'Invoke-WebRequest https://github.com -Method Head -UseBasicParsing | Select-Object StatusCode']
        : ['getent hosts github.com 2>/dev/null || dscacheutil -q host -a name github.com', 'curl -sI https://github.com | head -1'],
      revert: IS_WINDOWS
        ? [
          '$h = "$env:SystemRoot\\System32\\drivers\\etc\\hosts"',
          '(Get-Content $h) | Where-Object { $_ -notmatch "^\\s*\\S+\\s+github\\.com\\s*$" } | Set-Content $h -Encoding ascii',
          'ipconfig /flushdns',
        ]
        : [
          'sudo sed -i\'\' -E \'/[[:space:]]github\\.com$/d\' /etc/hosts',
          'sudo dscacheutil -flushcache 2>/dev/null; sudo killall -HUP mDNSResponder 2>/dev/null; sudo resolvectl flush-caches 2>/dev/null; true',
        ],
      note: IS_WINDOWS
        ? '一行版本先删掉已有的 github.com 行再逐条追加，重复执行不会堆积。需要管理员身份的 PowerShell；面板上的按钮会自己走 UAC。'
        : '先备份 /etc/hosts 再逐条追加，重复执行不会堆积。需要 sudo；这些命令请手动执行，面板上的一键按钮只支持 Windows。',
    })
  }

  if (proxyUrl && !git.proxy) {
    fixes.push({
      id: 'git-proxy',
      title: '让 git 走本机代理',
      why: `检测到可用代理 ${proxyUrl}，但 git 没有配置代理，所以克隆和推送会直连并卡住。`,
      elevated: false,
      commands: [
        `git config --global http.proxy ${proxyUrl}`,
        `git config --global https.proxy ${proxyUrl}`,
        'git ls-remote https://github.com/git/git.git HEAD',
      ],
      verify: ['git config --global --get http.proxy'],
      revert: ['git config --global --unset http.proxy', 'git config --global --unset https.proxy'],
      note: '代理软件重启后端口可能变化；换端口后用同样的命令覆盖即可。',
    })
  }

  if (!ssh.over443) {
    fixes.push({
      id: 'ssh-443',
      title: 'SSH 走 443 端口',
      why: '部分网络对 github.com:22 做了限制，改用 ssh.github.com:443 可以绕开端口封锁，且无需代理。',
      elevated: false,
      commands: IS_WINDOWS
        ? [
          '$sshDir = "$env:USERPROFILE\\.ssh"',
          'New-Item -ItemType Directory -Force -Path $sshDir | Out-Null',
          'Add-Content -Path "$sshDir\\config" -Value "Host github.com`n  HostName ssh.github.com`n  Port 443`n  User git" -Encoding ascii',
          'ssh -T git@github.com',
        ]
        : [
          'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
          `printf 'Host github.com\\n  HostName ssh.github.com\\n  Port 443\\n  User git\\n' >> ~/.ssh/config`,
          'chmod 600 ~/.ssh/config',
          'ssh -T git@github.com',
        ],
      verify: IS_WINDOWS ? ['Get-Content "$env:USERPROFILE\\.ssh\\config"'] : ['tail -5 ~/.ssh/config'],
      revert: IS_WINDOWS ? ['notepad "$env:USERPROFILE\\.ssh\\config"'] : ['${EDITOR:-vi} ~/.ssh/config'],
      note: IS_WINDOWS
        ? '追加到已有的 ~/.ssh/config 末尾即可；若文件里已有 Host github.com 段，请手动合并成一段。'
        : '追加到已有的 ~/.ssh/config 末尾即可；若文件里已有 Host github.com 段，请手动合并成一段（面板上的一键按钮只支持 Windows）。',
    })
  }

  if (diagnosis.code !== 'healthy') {
    fixes.push({
      id: 'mirror-clone',
      title: '用镜像加速克隆公开仓库',
      why: '拉取公开代码不必登录 GitHub；镜像站只代理下载请求，适合 `git clone` 和 Release 附件。',
      elevated: false,
      commands: [
        'git clone https://ghproxy.net/https://github.com/OWNER/REPO.git',
        '# 或让 git 自动改写所有 github.com 克隆地址：',
        'git config --global url."https://ghproxy.net/https://github.com/".insteadOf "https://github.com/"',
      ],
      verify: ['git config --global --get-regexp url'],
      revert: ['git config --global --remove-section url."https://ghproxy.net/https://github.com/"'],
      note: '第三方镜像的可用性和安全性由其运营方决定，只用于公开仓库；不要在其中输入账号密码，也不要代理私有仓库。',
    })
  }

  return fixes.map((fix) => ({
    ...fix,
    payload: fix.id === 'hosts-pin'
      ? { ips: workingIps.slice(0, 4) }
      : fix.id === 'git-proxy'
        ? { proxy: proxyUrl }
        : {},
  }))
}

function statusOf(probe) {
  if (isUsable(probe)) return 'ok'
  if (probe?.tls?.ok) return 'warn' // 握手成功但 HTTP 拒绝，按“半通”标记
  if (probe?.tcp?.ok) return 'warn'
  return 'fail'
}

function renderText(report) {
  const lines = []
  lines.push(`GitHub 连接诊断 · ${new Date(report.generatedAt).toLocaleString('zh-CN', { hour12: false })}`)
  lines.push(`结论：${report.diagnosis.title}`)
  lines.push(report.diagnosis.detail)
  if (report.recommendation && report.recommendation.kind !== 'none') {
    lines.push(`建议：${report.recommendation.title} — ${report.recommendation.detail}`)
  }
  lines.push('')
  lines.push('端点探测：')
  for (const endpoint of report.endpoints) {
    const status = statusOf(endpoint)
    const mark = status === 'ok' ? '✓' : status === 'warn' ? '△' : '✗'
    const tls = endpoint.tls?.ok ? `TLS ${endpoint.tls.ms}ms / HTTP ${endpoint.tls.status}` : `TLS ${endpoint.tls?.error ?? '未执行'}`
    const tcp = endpoint.tcp?.ok ? `TCP ${endpoint.tcp.ms}ms` : `TCP ${endpoint.tcp?.error ?? '未执行'}`
    lines.push(`  ${mark} ${endpoint.host} → ${endpoint.ip ?? '解析失败'} · ${tcp} · ${tls}`)
  }
  const working = report.candidates.filter((entry) => isUsable(entry))
  if (report.candidates.length > 0) {
    lines.push('')
    lines.push(`备用 IP：可用 ${working.length} 个${working.length > 0 ? `（${working.map((entry) => entry.ip).join('、')}）` : ''}`)
  }
  lines.push('')
  lines.push('本机环境：')
  lines.push(`  git 代理：${report.git.proxy ?? '未配置'}`)
  lines.push(`  代理环境变量：${Object.keys(report.proxyEnv).length > 0 ? JSON.stringify(report.proxyEnv) : '无'}`)
  lines.push(`  本机代理端口：${report.proxies.length > 0 ? report.proxies.join('、') : '未发现'}`)
  lines.push(`  SSH 走 443：${report.ssh.over443 ? '已配置' : '未配置'}`)
  if (report.fixes.length > 0) {
    lines.push('')
    lines.push('建议修复：')
    report.fixes.forEach((fix, index) => {
      lines.push(`  ${index + 1}. ${fix.title}${fix.elevated ? '（需要管理员权限）' : ''}`)
      lines.push(`     ${fix.why}`)
      for (const command of fix.commands) lines.push(`     ${command}`)
    })
  }
  return lines.join('\n')
}

/**
 * 由 Host 算好“现在该做什么”，面板只负责呈现和确认：
 * 把判定、可用 IP、hosts 现状三者合成一条推荐，避免把决策散在客户端。
 */
function recommend({ diagnosis, candidates, proxies, proxyEnv, hosts, channels }) {
  const working = candidates.filter((entry) => isUsable(entry)).map((entry) => entry.ip)
  const best = working[0] ?? null
  const pinnedIps = Array.isArray(hosts.ips) ? hosts.ips : []
  const pinned = pinnedIps[0] ?? null
  const pinnedAlive = pinnedIps.some((ip) => working.includes(ip))

  if (diagnosis.code === 'healthy') {
    return hosts.managed
      ? {
        kind: 'settled',
        ip: pinned,
        title: '连接正常',
        detail: pinnedIps.length > 1
          ? `github.com 当前固定为 ${pinnedIps.join('、')}，其中一个失联时浏览器会自动换下一个。`
          : `github.com 当前固定为 ${pinned}，仍然可用。`,
      }
      : { kind: 'none', title: '连接正常', detail: '无需处理。' }
  }

  if (diagnosis.code === 'tls-cert') {
    return proxies.length > 0 || Object.keys(proxyEnv).length > 0
      ? {
        kind: 'use-proxy',
        title: '证书校验失败，改用本机代理',
        detail: '连接本身是通的，是证书没过：先试代理（代理会重新建立 TLS），或把这台机器上做 HTTPS 扫描的软件关掉。固定 IP 在这条路上无效。',
      }
      : {
        kind: 'tls-cert-issue',
        title: '证书链问题，换 IP 没用',
        detail: '网络通到了 GitHub，是证书校验失败：检查是否有公司代理、杀毒软件或抓包工具在扫描 HTTPS，装上它的根证书或关掉扫描；也可以换一条出口（手机热点）对比。',
      }
  }

  if (hosts.managed && pinned && pinnedAlive) {
    // 主站那条路径（hosts 里第一个 IP）已经不通，但后面还有能用的：
    // 别说成“一切正常”，要说清第一个失效、浏览器会自己换下一个。
    const mainBroken = diagnosis.code !== 'healthy'
    return {
      kind: 'settled',
      ip: pinned,
      title: mainBroken ? '第一个 IP 已失效，后续仍可用' : '固定的 IP 仍可用',
      detail: mainBroken
        ? `当前固定 ${pinnedIps.join('、')}：第一个连不上，后面还有能用的，浏览器会依次尝试下一个。若页面仍打不开，先刷新 DNS 缓存并彻底退出浏览器重开；持续这样可以在面板上换一批 IP。`
        : `当前固定的 ${pinnedIps.join('、')} 里至少一个还能访问。若浏览器还是打不开，先刷新 DNS 缓存，再完全退出浏览器重开。`,
    }
  }

  if (hosts.managed && pinned && !pinnedAlive && best && IS_WINDOWS) {
    return {
      kind: 'refresh-ip',
      fixId: 'hosts-pin',
      ip: best,
      ips: working.slice(0, 4),
      title: pinnedIps.length > 1 ? `固定的 ${pinnedIps.length} 个 IP 都失效了` : `固定的 ${pinned} 已失效`,
      detail: `重新检测到 ${working.slice(0, 3).join('、')} 可用，点一下换过去（会弹一次 UAC，会一次写入多个 IP 做失败切换）。`,
      action: '换到可用 IP',
    }
  }

  if (!hosts.managed && best && IS_WINDOWS) {
    return {
      kind: 'fix-now',
      fixId: 'hosts-pin',
      ip: best,
      ips: working.slice(0, 4),
      title: `GitHub 受阻，${best} 可达`,
      detail: `点一下把 github.com 指向 ${best}：会弹一次 UAC 授权，改动前自动备份 hosts，随时可撤销。`,
      action: '立即修复',
    }
  }

  if (proxies.length > 0 || Object.keys(proxyEnv).length > 0) {
    return {
      kind: 'use-proxy',
      title: '直连不通，但本机有代理',
      detail: '把下面的「让 git 走本机代理」应用一下，浏览器请在代理软件里开启系统代理。',
    }
  }

  if (channels?.ssh443?.ok) {
    return {
      kind: 'use-ssh',
      fixId: 'ssh-443',
      title: '借不到可用 IP，但 SSH 通道是通的',
      detail: 'git 仍可通过 ssh.github.com:443 拉取和推送；只有网页登录打不开，等出现可用 IP 或代理后再处理。',
      action: '让 git 走 443',
    }
  }

  const mirror = (channels?.mirrors ?? []).find((entry) => entry.ok)
  if (mirror) {
    return {
      kind: 'use-mirror',
      title: `${mirror.host} 可用`,
      detail: '只能克隆、下载公开仓库，流量经过第三方；不要用它推送或访问私有仓库。把下面命令里的 OWNER/REPO 换成你要的仓库。',
      command: `git clone https://${mirror.host}/https://github.com/OWNER/REPO.git`,
    }
  }

  return {
    kind: 'no-ip',
    title: '暂时没有可用 IP',
    detail: '这条出口现在对 GitHub 整段不通，SSH 与镜像也都不通。换条出口（手机热点最快）或用代理后再检测。',
  }
}

const MIRRORS = [
  { id: 'ghproxy', host: 'ghproxy.net' },
  { id: 'gh-proxy', host: 'gh-proxy.com' },
]

/**
 * 主站被封、又借不到可用 IP 时的退路：SSH 走 443（git 仍能拉推）与公开镜像
 * （能克隆/下载公开仓库）。两者都独立于 github.com:443 这条路径。
 */
async function probeChannels() {
  const [ssh, mirrors] = await Promise.all([
    tcpProbe('ssh.github.com', 443, 5000),
    Promise.all(MIRRORS.map(async (mirror) => {
      const probe = await httpsProbe({ host: mirror.host, servername: mirror.host, reqPath: '/', timeoutMs: 6000 })
      return { ...mirror, ok: Boolean(probe?.ok), status: probe?.status ?? null, error: probe?.error ?? null }
    })),
  ])
  return {
    ssh443: { host: 'ssh.github.com', port: 443, ok: Boolean(ssh?.ok), error: ssh?.error ?? null },
    mirrors,
  }
}

async function buildReport(options = {}) {
  const force = options.force === true
  if (!force && cachedReport && Date.now() - cachedAt < CACHE_MS) {
    return { ...cachedReport, cached: true }
  }
  const endpoints = await runLimited(ENDPOINTS, 3, (endpoint) => probeEndpoint(endpoint, TIMEOUT_MS))
  const provenIps = endpoints
    .filter((entry) => entry.id !== 'github' && entry.tls?.ok && entry.ip)
    .map((entry) => entry.ip)
  const candidateIps = [...new Set([...provenIps, ...CANDIDATE_IPS])].slice(0, 6)
  const candidates = await runLimited(candidateIps, candidateIps.length, async (ip) => {
    const tcp = await tcpProbe(ip, 443, TIMEOUT_MS)
    const tls = tcp.ok ? await httpsProbe({ host: ip, servername: 'github.com', timeoutMs: TIMEOUT_MS }) : { ok: false, error: 'SKIPPED' }
    return { ip, tcp, tls }
  })
  const proxies = await readLocalProxies()
  const [git, ssh, hosts] = await Promise.all([readGitConfig(), readSshConfig(), readHostsInfo()])
  const proxyEnv = readProxyEnv()
  const diagnosis = diagnose({ endpoints, candidates, proxies, proxyEnv })
  const main = endpoints.find((entry) => entry.id === 'github') ?? null
  const appliedOf = (id) => (id === 'hosts-pin'
    ? Boolean(hosts.managed && hosts.line)
    : id === 'git-proxy'
      ? Boolean(git.proxy)
      : id === 'ssh-443'
        ? Boolean(ssh.over443)
        : false)
  const fixes = buildFixes({ diagnosis, candidates, proxies, proxyEnv, main, git, ssh })
    .map((fix) => ({ ...fix, applied: appliedOf(fix.id), applicable: fix.id !== 'mirror-clone' }))
  // 主站正常时不必探退路，省掉 6 秒等待。
  const channels = diagnosis.code === 'healthy' ? null : await probeChannels()
  const recommendation = recommend({ diagnosis, candidates, proxies, proxyEnv, hosts, channels })
  const report = {
    ok: diagnosis.severity !== 'error',
    generatedAt: new Date().toISOString(),
    diagnosis,
    endpoints,
    candidates,
    proxies,
    proxyEnv,
    git,
    ssh,
    hosts,
    channels,
    recommendation,
    fixes,
    limits: [
      '只探测本机命令行侧（git / gh / 下载），无法代管浏览器：网页登录打不开时，仍需要系统级代理或 hosts 指定 IP。',
      '插件不提供任何翻墙通道。点「应用」会真实修改本机配置（hosts 需要一次 UAC 授权、会先备份原文件），点「撤销」可还原。',
    ],
  }
  report.summary = renderText(report)
  cachedReport = report
  cachedAt = Date.now()
  return report
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) {
    chunks.push(chunk)
    if (chunks.reduce((total, item) => total + item.length, 0) > 16 * 1024) throw new Error('请求体过大')
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

// tools 与 webServer 都是硬依赖。webServer 必须写进来：只声明 tools 时，apply
// 会在 webServer 就绪之前执行，那时 ctx.get('webServer') 还是 undefined，路由被
// 跳过——启动后设置页就一直 404（运行时重装才正常）。声明成依赖后 Cordis 会等
// 服务就绪再 apply。commands 仍按可选处理。
export const inject = ['tools', 'webServer']

/* ---------------- 一键应用 / 撤销 ---------------- */

const MARKER = '# dsh-github-connectivity'
const WORK_DIR = path.join(os.tmpdir(), 'dsh-github-connectivity')
const HOSTS_TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'hosts-tool.ps1')

function hostsFilePath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.join(root, 'System32', 'drivers', 'etc', 'hosts')
}

async function readTextFile(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function readHostsInfo() {
  const file = hostsFilePath()
  const text = await readTextFile(file)
  if (text === null) return { file, readable: false, line: null, lines: [], ips: [], managed: false }
  const lines = text.split(/\r?\n/)
    .filter((entry) => /^\s*[0-9a-f.:]+\s+github\.com(\s|$)/i.test(entry))
    .map((entry) => entry.trim())
  const ips = lines.map((entry) => entry.split(/\s+/)[0])
  return { file, readable: true, line: lines[0] ?? null, lines, ips, managed: text.includes(MARKER) }
}

/**
 * 写 hosts 必须提权，而 Harness 进程是普通权限，所以这里走一次 UAC：
 * 把脚本复制到不含空格的 %TEMP%，再由一个 launcher 用 RunAs 拉起。
 * 用户取消 UAC 会在这里抛出，调用方按失败报告。
 */
async function runHostsTool(mode, ips) {
  await fs.mkdir(WORK_DIR, { recursive: true })
  const toolCopy = path.join(WORK_DIR, 'hosts-tool.ps1')
  await fs.copyFile(HOSTS_TOOL, toolCopy)

  const list = Array.isArray(ips) ? ips : (ips ? [ips] : [])
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
  const launcher = [
    '$ErrorActionPreference = "Stop"',
    `$hosts = ${quote(hostsFilePath())}`,
    `$work = ${quote(WORK_DIR)}`,
    `$mode = ${quote(mode)}`,
    `$ips = ${quote(list.join(','))}`,
    "if (-not (Test-Path -LiteralPath $work)) { New-Item -ItemType Directory -Path $work -Force | Out-Null }",
    "$script = Join-Path $work 'hosts-tool.ps1'",
    "[string]$line = '-NoProfile -ExecutionPolicy Bypass -File \"' + $script + '\" -Mode ' + $mode + ' -HostsFile \"' + $hosts + '\" -WorkDir \"' + $work + '\"'",
    "if ($mode -eq 'apply') { $line = $line + ' -Ips \"' + $ips + '\"' }",
    "$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $line -Wait -PassThru",
    'exit $p.ExitCode',
  ].join('\n')

  const launcherPath = path.join(WORK_DIR, 'run-elevated.ps1')
  await fs.writeFile(launcherPath, launcher, 'utf8')

  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath], { timeout: 120000 })
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error)
    if (/canceled|cancelled|1223|拒绝/i.test(detail)) {
      throw new Error('你在 UAC 弹窗里取消了授权，hosts 没有被修改')
    }
    throw new Error(`提权执行失败：${detail.trim().split('\n').slice(-2).join(' ')}`)
  }
}

const SSH_BLOCK_PATTERN = new RegExp(`${MARKER} begin[\\s\\S]*?${MARKER} end\\r?\\n?\\r?\\n?`)

async function applyFix(fixId, payload) {
  const data = payload && typeof payload === 'object' ? payload : {}

  if (fixId === 'git-proxy') {
    const proxy = typeof data.proxy === 'string' ? data.proxy.trim() : ''
    if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(proxy)) throw new Error('没有可用的代理地址，请先重新检测')
    await execFileAsync('git', ['config', '--global', 'http.proxy', proxy])
    await execFileAsync('git', ['config', '--global', 'https.proxy', proxy])
    return `git 全局代理已设为 ${proxy}`
  }

  if (fixId === 'ssh-443') {
    const file = path.join(os.homedir(), '.ssh', 'config')
    const text = (await readTextFile(file)) ?? ''
    if (SSH_BLOCK_PATTERN.test(text)) return 'SSH 443 配置已存在，未重复写入'
    await fs.mkdir(path.dirname(file), { recursive: true })
    const block = `${MARKER} begin\nHost github.com\n  HostName ssh.github.com\n  Port 443\n  User git\n${MARKER} end\n\n`
    // 放在文件开头：ssh 取第一个匹配到的值，追加到末尾会被已有的 Host github.com 段压住。
    await fs.writeFile(file, block + text, 'utf8')
    return `已写入 ${file}（置于开头，优先于原有 Host github.com 段）`
  }

  if (fixId === 'hosts-pin') {
    if (process.platform !== 'win32') {
      throw new Error(`一键改 hosts 目前只支持 Windows（当前系统 ${process.platform}）：请复制面板给出的手动命令，用 sudo 执行`)
    }
    const raw = Array.isArray(data.ips) ? data.ips : (typeof data.ip === 'string' ? [data.ip] : [])
    const ips = [...new Set(raw.map((value) => String(value).trim()).filter((value) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value)))].slice(0, 5)
    if (ips.length === 0) throw new Error('没有可用的 IP，请先重新检测')
    await runHostsTool('apply', ips)
    const info = await readHostsInfo()
    const missing = ips.filter((ip) => !info.ips.includes(ip))
    if (missing.length > 0) {
      throw new Error(`提权执行后 hosts 里缺少 ${missing.join('、')}，可能被安全软件拦截`)
    }
    return `已写入 ${ips.length} 个 IP：${ips.join('、')}（浏览器会在其中一个失联时自动换下一个）`
  }

  throw new Error(`这项修复不支持一键应用：${fixId}`)
}

async function revertFix(fixId) {
  if (fixId === 'git-proxy') {
    let cleared = 0
    for (const key of ['http.proxy', 'https.proxy']) {
      try {
        await execFileAsync('git', ['config', '--global', '--unset', key])
        cleared += 1
      } catch {
        /* 本来就没设置 */
      }
    }
    return cleared > 0 ? '已清除 git 全局代理' : 'git 全局代理本来就是空的'
  }

  if (fixId === 'ssh-443') {
    const file = path.join(os.homedir(), '.ssh', 'config')
    const text = await readTextFile(file)
    if (text === null) return '没有 ~/.ssh/config，无需撤销'
    if (!SSH_BLOCK_PATTERN.test(text)) return '没有找到本插件写入的 SSH 配置块'
    await fs.writeFile(file, text.replace(SSH_BLOCK_PATTERN, ''), 'utf8')
    return '已移除本插件写入的 SSH 配置块'
  }

  if (fixId === 'hosts-pin') {
    if (process.platform !== 'win32') {
      throw new Error(`一键还原 hosts 目前只支持 Windows（当前系统 ${process.platform}）：请手动删除文件里带 ${MARKER} 的行`)
    }
    await runHostsTool('revert')
    const info = await readHostsInfo()
    return info.managed ? '已还原，但 hosts 里仍有标记行，请检查' : 'hosts 已还原到本插件改动前的状态'
  }

  throw new Error(`这项修复不支持撤销：${fixId}`)
}

export function apply(ctx) {
  // 每项注册单独兜住异常。任何一项在别人的 Harness 版本上形状不同就抛错时，
  // 只丢这一项，不能让整行 apply 中断——否则工具、命令、路由一起消失，
  // 而客户端界面照常出现，表现就是“面板永远 404”。
  const guard = (label, register) => {
    try {
      register()
    } catch (error) {
      const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      // 写到磁盘再报日志：Host 日志在桌面版里不好找，而“哪一项注册失败”
      // 恰恰是排查设置页 404 的唯一线索。
      try {
        const dir = path.join(os.tmpdir(), 'dsh-github-connectivity')
        mkdirSync(dir, { recursive: true })
        appendFileSync(path.join(dir, 'registration-errors.log'), `[${new Date().toISOString()}] ${label}: ${detail}\n`)
      } catch {
        /* 写不了文件就算了，下面还有日志 */
      }
      try {
        ctx.logger?.('github-connectivity-doctor')?.warn?.(`${label} 注册失败，已跳过：${error instanceof Error ? error.message : String(error)}`)
      } catch {
        /* 日志服务也不可用时静默，别的入口仍然有效 */
      }
    }
  }

  guard('github_connectivity 工具', () => ctx.effect(() => ctx.tools.register({
    name: 'github_connectivity',
    description: '探测本机到 GitHub 各服务（网页、API、克隆、raw、附件）的 DNS/TCP/TLS 连通性，判定卡在哪一层，并给出可直接执行的修复命令。当用户说 GitHub 打不开、克隆超时、登录不上、下载 Release 失败时使用。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          code: { type: 'string' },
        },
        required: ['text', 'code'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    timeoutMs: 60000,
    async execute() {
      const report = await buildReport({ force: true })
      return { code: report.diagnosis.code, text: report.summary }
    },
  }), 'github-connectivity-doctor: tool'))

  guard('/github 命令', () => {
    const commands = ctx.get('commands')
    if (!commands || typeof commands.register !== 'function') return
    ctx.effect(() => commands.register({
      name: 'github',
      description: '诊断 GitHub 连接：逐层探测 DNS/TCP/TLS，给出可复制的修复命令。',
      async handler() {
        try {
          const report = await buildReport({ force: true })
          return { kind: 'success', text: report.summary }
        } catch (error) {
          return { kind: 'error', text: `GitHub 连接诊断失败：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    }), 'github-connectivity-doctor: /github')
  })

  const registerRoute = (server) => ctx.effect(() => server.register({
    kind: 'prefix',
    path: ROUTE_PATH,
    handler: async (request, response) => {
      try {
        const url = String(request?.url ?? '')
        if (request.method === 'POST') {
          const body = await readJsonBody(request)
          const action = url.includes('/revert') ? 'revert' : 'apply'
          const fixId = typeof body.fixId === 'string' ? body.fixId : ''
          if (fixId === '') throw new Error('缺少 fixId')
          const message = action === 'apply' ? await applyFix(fixId, body) : await revertFix(fixId)
          cachedReport = null
          sendJson(response, 200, { ok: true, action, fixId, message })
          return
        }
        const force = url.includes('refresh')
        const report = await buildReport({ force })
        sendJson(response, 200, report)
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'github-connectivity-doctor: report route')

  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    guard('设置页路由', () => registerRoute(webServer))
  } else {
    // inject 已经保证 webServer 就绪，走到这里说明时序仍异常。补一个短时重试，
    // 总比让设置页永久 404 好；同时在 Host 日志里留一句原因。
    try {
      ctx.logger?.('github-connectivity-doctor')?.warn?.(
        `apply 时 webServer 尚未就绪，将重试注册 ${ROUTE_PATH}。`,
      )
    } catch {
      /* 日志不可用就算了 */
    }
    let tries = 0
    const timer = setInterval(() => {
      const server = ctx.get('webServer')
      if (server && typeof server.register === 'function') {
        clearInterval(timer)
        guard('设置页路由(重试)', () => registerRoute(server))
        return
      }
      if ((tries += 1) > 40) clearInterval(timer)
    }, 1500)
    ctx.effect(() => () => clearInterval(timer))
  }
}
