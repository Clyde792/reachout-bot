# Keeps bot.lanternscs.org reachable.
# Cloudflare Tunnel routes the public domain -> http://localhost:3001.
# This keeps localhost:3001 forwarded to the k8s reachout-bot service and
# auto-recovers after pod restarts / rollouts / reboots.
#
# Robustness:
#  - full kubectl path + explicit kubeconfig (PATH may be empty at logon)
#  - checks/binds on 127.0.0.1 (avoids localhost->::1 IPv6 mismatch)
#  - if :3001 is unhealthy, kills any stale/hung kubectl forward before retrying

$kubectl = "C:\Program Files\Docker\Docker\resources\bin\kubectl.exe"
$env:KUBECONFIG = "$env:USERPROFILE\.kube\config"

while ($true) {
    $up = $false
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri 'http://127.0.0.1:3001/health'
        if ($r.StatusCode -eq 200) { $up = $true }
    } catch { $up = $false }

    if (-not $up) {
        Get-Process kubectl -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        # Blocks while forwarding; loop re-checks when it exits.
        & $kubectl port-forward --address 127.0.0.1 -n reachout svc/reachout-bot-service 3001:80 *> $null
    }
    Start-Sleep -Seconds 3
}
