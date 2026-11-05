# Desktop smoke-test launcher - runs OUTSIDE the DSH process tree via Task Scheduler.
$ErrorActionPreference = 'Continue'
$env:ELECTRON_RUN_AS_NODE = $null
$env:DOTMD_DESKTOP_SMOKE = '1'
Set-Location 'D:\Codes\AI Agents\Deepseek Harness\dotMDpritter'
$log = 'C:\Users\refat\AppData\Local\Temp\dmd-smoke.log'
Set-Content 'C:\Users\refat\AppData\Local\Temp\dmd-smoke-started.txt' "started $(Get-Date -Format o)"
Remove-Item $log -ErrorAction SilentlyContinue
& 'D:\Codes\AI Agents\Deepseek Harness\dotMDpritter\node_modules\electron\dist\electron.exe' . 2>&1 | Out-File -FilePath $log -Encoding utf8
"EXITCODE: $LASTEXITCODE" | Out-File -FilePath $log -Append -Encoding utf8
