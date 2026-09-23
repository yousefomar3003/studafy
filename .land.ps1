$base = 'C:\Users\User\Desktop\Studafy\studafy'
$apiDir = "$base\apps\api\tests\tz-locale"
$workerT = "$base\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts"
$o1 = & bun test "$apiDir" 2>&1 | Out-String
$p1 = 0; $f1 = 0
if ($o1 -match '(?m)^\s*(\d+) pass') { $p1 = [int]$Matches[1] }
if ($o1 -match '(?m)^\s*(\d+) fail') { $f1 = [int]$Matches[1] }
Write-Output "api-dir pass=$p1 fail=$f1"
$o2 = & bun test "$workerT" 2>&1 | Out-String
$p2 = 0; $f2 = 0
if ($o2 -match '(?m)^\s*(\d+) pass') { $p2 = [int]$Matches[1] }
if ($o2 -match '(?m)^\s*(\d+) fail') { $f2 = [int]$Matches[1] }
Write-Output "worker pass=$p2 fail=$f2"
$before = git -C $base rev-parse --short HEAD
if ($f1 -eq 0 -and $f2 -eq 0) {
  git -C $base add -A
  $co = git -C $base commit -m 'test(api): pin 2026 timezone/locale DST+RTL test matrix (ST-290)' 2>&1 | Out-String
  $created = $false
  if ($co -match '\[test/st-290[^\]]*\]? ?([0-9a-f]{7,})') { $created = $true }
  $after = git -C $base rev-parse --short HEAD
  Write-Output "commit-created=$created before=$before after=$after"
  if ($after -ne $before) {
    $pu = git -C $base push 2>&1 | Out-String
    $rh = git -C $base rev-parse --short "origin/$((git -C $base branch --show-current))"
    Write-Output "remote-tip=$rh local-head=$after match=$($rh -eq $after)"
  } else {
    Write-Output "commit did not advance HEAD; hook rejected"
    ($co -split "\r?\n") | Select-String -Pattern 'error|fail|✖|Running|Skipped|Unable' | Select-Object -First 8 | ForEach-Object { $_.Line.Trim() }
  }
} else {
  Write-Output "red - no commit"
}
