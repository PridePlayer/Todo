# Pull GRID database backups from the server to this Windows machine.
#
# Why this exists: the server's own backups live on the same disk as the
# database. If the ECS disk dies, or /www gets wiped by a reinstall, both
# copies vanish together. This script is the actual off-site copy.
#
# Usage (run from the repo root, or anywhere):
#   powershell -ExecutionPolicy Bypass -File tools\pull-backup.ps1
#   powershell -ExecutionPolicy Bypass -File tools\pull-backup.ps1 -Server 1.2.3.4 -User root
#
# First-time setup (once):
#   1. Make sure OpenSSH client is available:  ssh -V
#      (Windows 10/11 ship it; enable "OpenSSH Client" in optional features if not)
#   2. Set up key-based login so this can run unattended:
#        ssh-keygen -t ed25519
#        type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@HOST "mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"
#   3. Verify:  ssh root@HOST "echo ok"
#   4. Schedule it: Task Scheduler -> Create Basic Task -> Daily -> 21:00
#        Program:  powershell.exe
#        Arguments: -ExecutionPolicy Bypass -File "E:\11_WorkBuddyFiles\Todo\tools\pull-backup.ps1"
#
# Nothing here deletes anything on the server. It only reads.

param(
    [string]$Server = "todo.stellamp.me",
    [string]$User = "root",
    [int]$Port = 22,
    [string]$RemoteDir = "/www/backup/grid/daily",
    [string]$Dest = "$env:USERPROFILE\GridBackup",
    [int]$Fetch = 3,
    [int]$Keep = 40
)

$ErrorActionPreference = "Stop"

function Say($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] $msg"
}

Say "target: ${User}@${Server}:${RemoteDir} -> $Dest"

foreach ($tool in @("ssh", "scp")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Say "ERROR: '$tool' not found. Install the OpenSSH Client optional feature."
        exit 1
    }
}

if (-not (Test-Path -LiteralPath $Dest)) {
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    Say "created $Dest"
}

# BatchMode: never sit waiting for a password prompt. If the key is not set up,
# fail loudly instead of hanging forever in Task Scheduler where nobody sees it.
$connect = ssh -p $Port -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new `
    "${User}@${Server}" "echo ok" 2>&1
if ($LASTEXITCODE -ne 0) {
    Say "ERROR: cannot reach ${Server} over SSH."
    Say "  $connect"
    Say "  Check the SSH key setup (see the header of this file)."
    exit 1
}

# Ask the server for the newest files, then pull only those.
# Pulling everything every night would work but steadily re-download gigabytes.
$listCmd = "ls -1t $RemoteDir/grid_*.* 2>/dev/null | head -$Fetch"
$names = ssh -p $Port -o BatchMode=yes "${User}@${Server}" $listCmd
if ($LASTEXITCODE -ne 0 -or -not $names) {
    Say "ERROR: no backup files found in $RemoteDir on the server."
    Say "  Has the cron job ever run? Check: ls -lh $RemoteDir"
    exit 1
}

$fetched = 0
foreach ($name in ($names -split "`n")) {
    $name = $name.Trim()
    if (-not $name) { continue }

    $local = Join-Path $Dest (Split-Path $name -Leaf)
    if (Test-Path -LiteralPath $local) {
        Say "skip (already here): $(Split-Path $name -Leaf)"
        continue
    }

    Say "fetching $(Split-Path $name -Leaf)"
    scp -P $Port -o BatchMode=yes -q "${User}@${Server}:$name" $Dest
    if ($LASTEXITCODE -ne 0) {
        Say "ERROR: scp failed for $name"
        exit 1
    }
    $fetched++
}

# Verify the newest local file is a plausible gzip stream.
# A truncated download that "looks" successful is worse than no download:
# you would trust it until the day you need it.
$newest = Get-ChildItem -LiteralPath $Dest -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest) {
    $size = $newest.Length
    if ($size -lt 4096) {
        Say "WARNING: newest local backup is only $size bytes - suspicious."
    }
    $bytes = [System.IO.File]::ReadAllBytes($newest.FullName)
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0x1F -and $bytes[1] -eq 0x8B) {
        Say "verified gzip header: $($newest.Name) ($([math]::Round($size / 1MB, 2)) MB)"
    } else {
        Say "WARNING: $($newest.Name) is not a gzip file. Delete it and retry."
    }
}

# Rotate old copies locally. Keep enough history to survive "I nuked it last week".
$all = Get-ChildItem -LiteralPath $Dest -File | Sort-Object LastWriteTime -Descending
if ($all.Count -gt $Keep) {
    $all | Select-Object -Skip $Keep | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force
        Say "rotated out: $($_.Name)"
    }
}

Say "done. new files: $fetched, local total: $((Get-ChildItem -LiteralPath $Dest -File).Count)"

# Always print the folder, so a person running this by hand knows where to look.
Say "backups are in: $Dest"
