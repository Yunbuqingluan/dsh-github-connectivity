param(
  [ValidateSet('apply', 'revert')][string]$Mode = 'apply',
  [string]$Ips = '',
  [Parameter(Mandatory = $true)][string]$HostsFile,
  [Parameter(Mandatory = $true)][string]$WorkDir
)

# Written by dsh-github-connectivity. Runs elevated, only ever touches the
# github.com lines it marks, and backs up the file before changing it.
#
# Several IPs are written on purpose: Windows hands every one of them to the
# browser, which then falls through to the next when one stops answering.
# A single pinned IP dies within minutes on a throttled route.
$ErrorActionPreference = 'Stop'
$marker = '# dsh-github-connectivity'
$nl = [Environment]::NewLine

if (-not (Test-Path -LiteralPath $WorkDir)) {
  New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
}

$lines = @(Get-Content -LiteralPath $HostsFile)
$githubLine = '(?i)^\s*[0-9a-f.:]+\s+github\.com(\s|$)'

if ($Mode -eq 'apply') {
  $list = @($Ips -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' } | Select-Object -Unique)
  if ($list.Count -eq 0) { throw 'apply requires -Ips with at least one IPv4 address' }

  # One backup, taken before the FIRST change only: reverting means "go back to
  # what this file looked like before the plugin touched it", never "undo my
  # last click". Repeated applies must not bury the original.
  $backup = Join-Path $WorkDir 'hosts.bak-original'
  if (-not (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $HostsFile -Destination $backup -Force
  }

  $kept = @($lines | Where-Object { $_ -notmatch $githubLine })
  foreach ($ip in $list) {
    $kept += ($ip + ' github.com' + [char]9 + $marker)
  }

  [System.IO.File]::WriteAllText($HostsFile, (($kept -join $nl) + $nl), [System.Text.Encoding]::ASCII)
  Write-Output ('ok apply count=' + $list.Count + ' backup=' + $backup)
}
else {
  $backup = Join-Path $WorkDir 'hosts.bak-original'

  if (Test-Path -LiteralPath $backup) {
    Copy-Item -LiteralPath $backup -Destination $HostsFile -Force
    Remove-Item -LiteralPath $backup -Force
    Write-Output 'ok revert restored=hosts.bak-original'
  }
  else {
    $kept = @($lines | Where-Object { $_ -notmatch [regex]::Escape($marker) })
    [System.IO.File]::WriteAllText($HostsFile, (($kept -join $nl) + $nl), [System.Text.Encoding]::ASCII)
    Write-Output 'ok revert removed-marker'
  }
}

try { ipconfig /flushdns *> $null } catch { Write-Output 'warn dns-flush-failed' }
