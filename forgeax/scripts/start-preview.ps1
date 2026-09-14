param(
 [ValidateRange(1024,65535)][int]$Port=8766,
 [switch]$Rebuild,
 [switch]$NoBrowser
)
$ErrorActionPreference='Stop'
$nativeRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest=Join-Path $nativeRoot 'forge.json'
if (!(Test-Path -LiteralPath $manifest)) { throw 'ForgeaX project manifest is missing.' }
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$toolPath=Join-Path $PSScriptRoot 'forgeax-tool.mjs'
$logRoot=Join-Path $nativeRoot 'artifacts\preview'
[IO.Directory]::CreateDirectory($logRoot) | Out-Null
$distPath=Join-Path $nativeRoot 'dist\forgeax-dist.json'
if ($Rebuild -or !(Test-Path -LiteralPath $distPath)) {
 Push-Location $nativeRoot
 try { & $nodePath $toolPath project build --json *> (Join-Path $logRoot 'build.log'); if ($LASTEXITCODE -ne 0) { throw "Native build failed. Read $logRoot\build.log" } }
 finally { Pop-Location }
}
$previewUrl="http://localhost:$Port/"
function Test-NativeResponse {
 try { $reply=Invoke-RestMethod -Uri ($previewUrl+'forgeax-dist.json') -TimeoutSec 3; return $reply.project.id -eq 'voxel-frontline' }
 catch { return $false }
}
if (!(Test-NativeResponse)) {
 $listener=Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
 if ($listener) { throw "Port $Port belongs to another server. It has not been stopped." }
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
 $stdout=Join-Path $logRoot "$stamp.out.log"
 $stderr=Join-Path $logRoot "$stamp.err.log"
 $arguments=@(('"'+$toolPath+'"'),'project','preview','--port',"$Port",'--json')
 $previewProcess=Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $nativeRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
 $deadline=[DateTime]::UtcNow.AddSeconds(45)
 do {
  $previewProcess.Refresh()
  if ($previewProcess.HasExited) { throw "Native preview stopped. Read $stderr" }
  if (Test-NativeResponse) {
   [ordered]@{pid=$previewProcess.Id;port=$Port;root=$nativeRoot;url=$previewUrl;stdout=$stdout;stderr=$stderr} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logRoot 'state.json') -Encoding utf8
   break
  }
  Start-Sleep -Milliseconds 250
 } while ([DateTime]::UtcNow -lt $deadline)
 if (!(Test-NativeResponse)) { throw "Native preview did not become ready. Read $stderr" }
}
Write-Output "ForgeaX migration preview is ready: $previewUrl"
Write-Output 'This preview has not passed complete replacement acceptance.'
if (!$NoBrowser) { Start-Process $previewUrl }
