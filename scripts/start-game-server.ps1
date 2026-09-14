param(
    [ValidateRange(1024,65535)][int]$Port = 8765
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$indexPath = Join-Path $projectRoot 'index.html'
if (!(Test-Path -LiteralPath $indexPath)) { throw 'Game index.html was not found.' }
$entryContent = [IO.File]::ReadAllText($indexPath)
$gameUrl = "http://127.0.0.1:$Port/"
function Test-GameResponse {
    try {
        $response = Invoke-WebRequest -Uri $gameUrl -UseBasicParsing -TimeoutSec 2
        $responseText = [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()).TrimStart([char]0xFEFF)
        return $response.StatusCode -eq 200 -and $responseText -eq $entryContent
    } catch { return $false }
}
if (Test-GameResponse) {
    Write-Output "Game server is ready: $gameUrl"
    exit 0
}
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    throw "Port $Port is occupied but does not serve this game correctly. Process ID: $($listener.OwningProcess -join ', '). Inspect it before restarting."
}
$pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
$logRoot = Join-Path $projectRoot 'tmp\game-server'
[IO.Directory]::CreateDirectory($logRoot) | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$outLog = Join-Path $logRoot "$stamp.out.log"
$errLog = Join-Path $logRoot "$stamp.err.log"
$arguments = @('-u', '-m', 'http.server', "$Port", '--bind', '127.0.0.1', '--directory', ('"' + $projectRoot + '"'))
$serverProcess = Start-Process -FilePath $pythonPath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) { throw "Server exited. Read: $errLog" }
    if (Test-GameResponse) {
        [ordered]@{ pid=$serverProcess.Id; port=$Port; url=$gameUrl; root=$projectRoot; startedAt=$serverProcess.StartTime.ToString('o'); stdout=$outLog; stderr=$errLog } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logRoot 'state.json') -Encoding UTF8
        Write-Output "Game server is ready: $gameUrl"
        Write-Output "Process ID: $($serverProcess.Id)"
        Write-Output "Request/error log: $errLog"
        exit 0
    }
    Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
throw "Server did not become ready. Inspect process $($serverProcess.Id) and log: $errLog"
