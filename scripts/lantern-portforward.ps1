# Keeps bot.lanternscs.org reachable.
# The Cloudflare Tunnel routes the public domain -> http://localhost:3001.
# This forwards localhost:3001 -> the k8s reachout-bot service, and
# auto-restarts the forward if it drops (pod restart, rollout, etc.).
# Uses kubectl's full path + explicit kubeconfig so it works even when launched
# at logon (where PATH may not include kubectl).

$kubectl = "C:\Program Files\Docker\Docker\resources\bin\kubectl.exe"
$env:KUBECONFIG = "$env:USERPROFILE\.kube\config"

while ($true) {
    $up = $false
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri 'http://localhost:3001/health'
        if ($r.StatusCode -eq 200) { $up = $true }
    } catch { $up = $false }

    if (-not $up) {
        Write-Output ("[" + (Get-Date -Format o) + "] :3001 down - starting port-forward")
        # Blocks until the forward dies, then the loop re-checks and restarts it.
        & $kubectl port-forward -n reachout svc/reachout-bot-service 3001:80 2>$null
    }
    Start-Sleep -Seconds 3
}
