## Seamless Menu Population — Auto-Restart Wrapper
## Chrome crashes every ~300 restaurants from memory. This restarts the script
## with --resume so it picks up where it left off.
##
## Usage: powershell -ExecutionPolicy Bypass -File scripts\run-seamless-populate.ps1
## Run from: C:\Users\ozend\dev\project-kortana\server

$maxRestarts = 100
$cooldownSeconds = 90
$restartCount = 0

Write-Host "=== Seamless Populate Auto-Restart Wrapper ===" -ForegroundColor Cyan
Write-Host "Max restarts: $maxRestarts | Cooldown: ${cooldownSeconds}s"
Write-Host ""

while ($restartCount -lt $maxRestarts) {
    $restartCount++
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] Starting run #$restartCount..." -ForegroundColor Green

    # Kill any stale Chrome on CDP port 9223
    $chromePort = netstat -ano | Select-String ":9223" | Select-String "LISTENING"
    if ($chromePort) {
        $chromePid = ($chromePort -split '\s+')[-1]
        Write-Host "Killing stale Chrome on port 9223 (PID $chromePid)"
        Stop-Process -Id $chromePid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }

    npx tsx src/scripts/populate-seamless-menus.ts --concurrency 4 --resume --sustained --skip-match

    $exitCode = $LASTEXITCODE
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] Script exited with code $exitCode" -ForegroundColor Yellow

    if ($exitCode -eq 0) {
        Write-Host "Script completed successfully. All restaurants processed." -ForegroundColor Green
        break
    }

    if ($restartCount -lt $maxRestarts) {
        Write-Host "Cooling down ${cooldownSeconds}s before restart..." -ForegroundColor Yellow
        Start-Sleep -Seconds $cooldownSeconds
    }
}

Write-Host ""
Write-Host "=== Done. Total runs: $restartCount ===" -ForegroundColor Cyan
