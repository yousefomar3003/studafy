$base = 'C:\Users\User\Desktop\Studafy\studafy'
$pkgs = bunx -c $base turbo run lint --filter=@studafy/announcements --continue=false 2>&1 | Out-String
Write-Output ($pkgs.Trim().Split([char]10) | Select-Object -Last 20)
