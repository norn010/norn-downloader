# Norn Downloader - yt-dlp helper setup, for the current Windows user (no admin needed).
#   1. installs yt-dlp, ffmpeg (merges video + audio) and Deno (yt-dlp needs it for YouTube) with winget
#   2. writes norn-host.bat and com.norn.ytdlp.json next to this script
#   3. registers the helper with Chrome under HKCU, allowed for this unpacked extension only
# Run from the extension folder:  powershell -ExecutionPolicy Bypass -File native\install.ps1
# Run it again after moving the extension folder (its id comes from the folder path).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$extensionDir = Split-Path -Parent $here

foreach ($package in 'yt-dlp.yt-dlp', 'Gyan.FFmpeg', 'DenoLand.Deno') {
  winget list --id $package --exact --accept-source-agreements *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "$package is already installed"
    continue
  }
  Write-Host "Installing $package ..."
  winget install --id $package --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget could not install $package (exit code $LASTEXITCODE)" }
}

$utf8 = New-Object System.Text.UTF8Encoding $false # Chrome rejects a manifest that starts with a BOM

# Chrome starts the helper through this .bat; point it at this machine's node.exe
$node = (Get-Command node -ErrorAction Stop).Source
$bat = Join-Path $here 'norn-host.bat'
[IO.File]::WriteAllText($bat, "@echo off`r`n`"$node`" `"%~dp0norn-host.mjs`"`r`n", $utf8)

# An unpacked extension's id: first 32 hex digits of SHA-256 over its folder path (UTF-16LE), 0-f mapped to a-p
$hash = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($extensionDir))
$id = -join ($hash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })

$manifest = Join-Path $here 'com.norn.ytdlp.json'
$json = [ordered]@{
  name = 'com.norn.ytdlp'
  description = 'Norn Downloader yt-dlp helper'
  path = $bat
  type = 'stdio'
  allowed_origins = @("chrome-extension://$id/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifest, $json, $utf8)

New-Item -Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.norn.ytdlp' -Value $manifest -Force | Out-Null

Write-Host ''
Write-Host "Done. Extension id: $id"
Write-Host 'Now reload Norn Downloader in chrome://extensions.'
