## DoorDash Menu Population — Auto-Restart Wrapper
## Chrome crashes every ~300 restaurants from memory. This restarts the script
## with --resume so it picks up where it left off. Also extracts addresses
## from storepageFeed (piggybacks on menu fetch — no extra API calls).
##
## Usage: powershell -ExecutionPolicy Bypass -File scripts\run-doordash-populate.ps1
## Run from: C:\Users\ozend\dev\project-kortana\server
##
## Uses CDP port 9224. The Kortana dev server must NOT be running.

$maxRestarts = 100
$cooldownSeconds = 90
$restartCount = 0

Write-Host "=== DoorDash Populate Auto-Restart Wrapper ===" -ForegroundColor Cyan
Write-Host "Max restarts: $maxRestarts | Cooldown: ${cooldownSeconds}s"
Write-Host "CDP port: 9224 (DoorDash)"
Write-Host ""

# Warn if Kortana dev server is running
$serverPort = netstat -ano | Select-String ":3001" | Select-String "LISTENING"
if ($serverPort) {
    Write-Host "WARNING: Kortana dev server appears to be running on port 3001." -ForegroundColor Yellow
    Write-Host "         Stop it first (Ctrl+C the `npm run dev` terminal)." -ForegroundColor Yellow
    Write-Host "         The server holds CDP port 9224 and will conflict with this script." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to continue anyway, or Ctrl+C to abort"
}

while ($restartCount -lt $maxRestarts) {
    $restartCount++
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] Starting run #$restartCount..." -ForegroundColor Green

    # Kill any stale Chrome on CDP port 9224
    $chromePort = netstat -ano | Select-String ":9224" | Select-String "LISTENING"
    if ($chromePort) {
        $chromePid = ($chromePort -split '\s+')[-1]
        Write-Host "Killing stale Chrome on port 9224 (PID $chromePid)"
        Stop-Process -Id $chromePid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }

    npx tsx src/scripts/populate-doordash-menus.ts --resume --sustained --skip-match

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
