$base = 'C:\Users\User\Desktop\Studafy\studafy'
$localPre = git -C $base rev-parse --short HEAD
$remotePre = git -C $base rev-parse --short origin/$((git -C $base branch --show-current))
Write-Output ('pre local=' + $localPre + ' remote=' + $remotePre)
$pu = git -C $base push 2>&1 | Out-String
$local = git -C $base rev-parse --short HEAD
$remote = git -C $base rev-parse --short origin/$((git -C $base branch --show-current))
Write-Output ('post local=' + $local + ' remote=' + $remote + ' remote-caught-up=' + ($local -eq $remote))
if ($local -ne $remote) {
  ($pu.Trim() -split [char]10) | Select-String -Pattern 'set up|->|rejected|error|fatal' | Select-Object -First 3 | ForEach-Object { Write-Output ('  ' + $_.Line.Trim()) }
}
