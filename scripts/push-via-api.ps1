# 通过 GitHub REST API 把当前提交推到远端仓库。
#
# 为什么需要它：部分网络对 github.com 的 git-over-HTTPS 传输会中途重置连接
# （api.github.com 却是通的），表现为 `git push` 报 "Failed to connect / Connection reset"。
# 这个脚本改用 API 建 blob/tree/commit 再更新分支，等价于一次 push。
#
# 依赖：GitHub CLI 已登录（gh auth login），且本地已 git add + commit。
# 用法：pwsh -File scripts\push-via-api.ps1 -Repo <owner>/<name> [-Branch main]
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
# 中文路径/提交信息要按 UTF-8 处理，否则 PowerShell 5.1 会按 GBK 解出问号
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$api = "https://api.github.com/repos/$Repo"
$token = (& gh auth token).Trim()
$headers = @{
  Authorization = "Bearer $token"
  'User-Agent'  = 'codex'
  Accept        = 'application/vnd.github+json'
}

function Invoke-Api([string]$uri, [string]$method, $body) {
  if ($null -eq $body) { return Invoke-RestMethod -Uri $uri -Method $method -Headers $headers }
  # 必须带 charset，否则 PowerShell 会把中文按 Latin1 发出去变成 ?
  $json = $body | ConvertTo-Json -Depth 8 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Uri $uri -Method $method -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes
}

$files = @(& git ls-files)
if ($files.Count -eq 0) { throw '没有已跟踪的文件，先 git add 再跑' }
Write-Host "待推送文件数: $($files.Count)"

# 空仓库先用 Contents API 落一个文件，Git Data API 才能在它基础上工作
try {
  Invoke-Api "$api/git/ref/heads/$Branch" 'Get' $null | Out-Null
} catch {
  Write-Host '仓库还没有提交，先创建初始提交…'
  $readme = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes('README.md'))
  Invoke-Api "$api/contents/README.md" 'Put' @{
    message = 'chore: 初始化仓库'
    content = $readme
    branch  = $Branch
  } | Out-Null
}

$head = Invoke-Api "$api/git/ref/heads/$Branch" 'Get' $null
$baseCommit = Invoke-Api "$api/git/commits/$($head.object.sha)" 'Get' $null

# 逐个文件上传成 blob
$tree = New-Object System.Collections.ArrayList
$index = 0
foreach ($file in $files) {
  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $file))
  $blob = Invoke-Api "$api/git/blobs" 'Post' @{
    content  = [Convert]::ToBase64String($bytes)
    encoding = 'base64'
  }
  [void]$tree.Add(@{ path = ($file -replace '\\', '/'); mode = '100644'; type = 'blob'; sha = $blob.sha })
  $index++
  if ($index % 20 -eq 0) { Write-Host "  已上传 $index / $($files.Count)" }
}

$newTree = Invoke-Api "$api/git/trees" 'Post' @{ base_tree = $baseCommit.tree.sha; tree = $tree }
$message = (& git log -1 --pretty=%B) -join "`n"
$commit = Invoke-Api "$api/git/commits" 'Post' @{
  message = $message
  tree    = $newTree.sha
  parents = @($head.object.sha)
}
Invoke-Api "$api/git/refs/heads/$Branch" 'Patch' @{ sha = $commit.sha; force = $true } | Out-Null

Write-Host "已推送: https://github.com/$Repo/commit/$($commit.sha)"
