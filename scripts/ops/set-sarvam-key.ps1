# Uploads the Sarvam Voice Agents API key to the klyro Worker without ever printing it.
# Usage (PowerShell, repo root):  powershell -ExecutionPolicy Bypass -File scripts\ops\set-sarvam-key.ps1
# Start the script first, THEN copy the key in Sarvam (Settings -> API Key), then press Enter,
# so copying this command cannot overwrite the key in the clipboard.
$ErrorActionPreference = "Stop"
$secretName = "SARVAM_VOICE_AGENTS_API_KEY"
$worker = "klyro"

Read-Host "Copy the Sarvam API key now (Sarvam -> Settings -> API Key -> copy), then press Enter" | Out-Null
$key = (Get-Clipboard -Raw)
if ($null -eq $key) { throw "The clipboard is empty. Copy the key and run the script again." }
$key = $key.Trim()

if ($key.Length -lt 20 -or $key -match '\s' -or $key -match '[\(\)\|\$"''`\\]') {
  throw "The clipboard does not look like an API key (length $($key.Length), or it contains spaces or command characters). Copy only the key and run the script again."
}
Write-Host "Clipboard holds a key-like value of length $($key.Length). Uploading..."

$tmp = Join-Path $env:TEMP ("sk-" + [guid]::NewGuid().ToString("N") + ".txt")
try {
  [System.IO.File]::WriteAllText($tmp, $key, (New-Object System.Text.ASCIIEncoding))
  cmd /c "npx wrangler secret put $secretName --name $worker < `"$tmp`""
  if ($LASTEXITCODE -ne 0) { throw "wrangler secret put failed (exit $LASTEXITCODE)." }
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  Set-Clipboard -Value " "
  $key = $null
}
Write-Host "Done. The temporary file was deleted and the clipboard was cleared."
