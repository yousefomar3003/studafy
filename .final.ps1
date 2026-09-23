$base='C:\Users\User\Desktop\Studafy\studafy'
$apiDir = $base + '\apps\api\tests\tz-locale'
$workerFile = $base + '\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts'
Write-Output '== 1: api tz-locale =='
$tb = & bun test $apiDir 2>&1 | Out-String
$e1 = $LASTEXITCODE
Write-Output ($tb.Trim().Split([Environment]::NewLine) | Select-Object -Last 3)
Write-Output ('exit1=' + $e1)
Write-Output '== 2: worker dunning dst =='
$tw = & bun test $workerFile 2>&1 | Out-String
$e2 = $LASTEXITCODE
Write-Output ($tw.Trim().Split([Environment]::NewLine) | Select-Object -Last 3)
Write-Output ('exit2=' + $e2)
if ($e1 -eq 0 -and $e2 -eq 0) {
  Write-Output '== GREEN -> add + commit + push =='
  $before = git -C $base rev-parse --short HEAD
  git -C $base add apps/api/tests/tz-locale apps/workers/src/queues/billing/__tests__ docs/testing/timezone-test-catalog.md 2>&1 | Out-Null
  $co = git -C $base commit -m 'test(api): pin 2026 timezone/locale DST+RTL matrix (ST-290)' 2>&1 | Out-String
  $after = git -C $base rev-parse --short HEAD
  Write-Output ('head before=' + $before + ' after=' + $after + ' advanced=' + ($before -ne $after))
  if ($before -ne $after) {
    $pu = git -C $base push 2>&1 | Out-String
    $branch = git -C $base branch --show-current
    $remote = git -C $base rev-parse --short ('origin/' + $branch)
    Write-Output ('push remote-tip=' + $remote + ' local=' + $after + ' match=' + ($remote -eq $after))
  } else {
    Write-Output '== commit did NOT advance HEAD - hook output tail =='
    ($co -split [Environment]::NewLine) | Select-String -Pattern 'error|fail|✖|Unable|no-unresolved' | Select-Object -First 4 | ForEach-Object { $_.Line.Trim() }
  }
} else {
  Write-Output 'RED - no commit'
  ($tb -split [Environment]::NewLine) | Select-String -Pattern 'Expected|Received|error' | Select-Object -First 3 | ForEach-Object { '  api: ' + $_.Line.Trim() }
  ($tw -split [Environment]::NewLine) | Select-String -Pattern 'Expected|Received|error' | Select-Object -First 3 | ForEach-Object { '  work: ' + $_.Line.Trim() }
}
