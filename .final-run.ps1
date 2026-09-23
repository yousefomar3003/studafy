$base='C:\Users\User\Desktop\Studafy\studafy'

$apiDir = $base + '\apps\api\tests\tz-locale'
$workerOne = $base + '\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts'

Write-Output '== run 1: api tz-locale suite =='
$o1 = & bun test $apiDir 2>&1 | Out-String
Write-Output ($o1.Trim())

Write-Output '== run 2: worker dunning-dst suite =='
$o2 = & bun test $workerOne 2>&1 | Out-String
Write-Output ($o2.Trim())

$f1 = -1
$f2 = -1
$p1 = 0
$p2 = 0
if ($o1 -match '(?m)^([0-9]+) fail') { $f1 = [int]$Matches[1] }
if ($o2 -match '(?m)^([0-9]+) fail') { $f2 = [int]$Matches[1] }
if ($o1 -match '(?m)^([0-9]+) pass') { $p1 = [int]$Matches[1] }
if ($o2 -match '(?m)^([0-9]+) pass') { $p2 = [int]$Matches[1] }
Write-Output ('api  pass=' + $p1 + ' fail=' + $f1)
Write-Output ('work pass=' + $p2 + ' fail=' + $f2)

if ($f1 -eq 0 -and $f2 -eq 0) {
  Write-Output 'GREEN -> stage only the matrix, commit, push'
  $before = (git -C $base rev-parse --short HEAD)
  git -C $base add apps/api/tests/tz-locale apps/workers/src/queues/billing/__tests__ docs/testing/timezone-test-catalog.md 2>&1 | Out-Null
  $co = git -C $base commit -m 'test(api): pin 2026 tz/locale DST+RTL matrix (ST-290)' 2>&1 | Out-String
  $after = (git -C $base rev-parse --short HEAD)
  Write-Output ('commit: before=' + $before + ' after=' + $after + ' advanced=' + ($before -ne $after))
  if ($before -ne $after) {
    $push = git -C $base push 2>&1 | Out-String
    $branch = (git -C $base branch --show-current)
    $remote = (git -C $base rev-parse --short ('origin/' + $branch))
    Write-Output ('push-remote=' + $remote + ' local-head=' + $after + ' match=' + ($remote -eq $after))
  } else {
    Write-Output 'commit did NOT advance HEAD - hook rejected; tail:'
    $coe = $co | Select-String -Pattern '✖|error|Unable|no-unresolved|exit' | Select-Object -First 8
    foreach ($e in $coe) { Write-Output ('  ' + $e.Line.Trim()) }
  }
} else {
  Write-Output 'NOT green - no commit/push'
}
