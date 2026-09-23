$base = 'C:\Users\User\Desktop\Studafy\studafy'
$files = @(
  $base + '\apps\api\tests\tz-locale\attendance-correction-deadline.test.ts',
  $base + '\apps\api\tests\tz-locale\digest-label-date.test.ts',
  $base + '\apps\api\tests\tz-locale\locale-rtl.test.ts',
  $base + '\apps\api\tests\tz-locale\scheduled-announcements-dst.test.ts',
  $base + '\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts'
)
$ok = $true
foreach ($f in $files) {
  $n = (Select-String -LiteralPath $f -Pattern 'eslint-disable' | Measure-Object).Count
  Write-Output ('disable-comments=' + $n + ' ' + $f.Replace($base + '\', ''))
}
Write-Output '== run api tz-locale =='
$o1 = & bun test ($base + '\apps\api\tests\tz-locale') 2>&1 | Out-String
$e1 = $LASTEXITCODE
Write-Output ('api-exit=' + $e1)
Write-Output '== run worker dunning dst suite =='
$w = $base + '\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts'
$o2 = & bun test $w 2>&1 | Out-String
$e2 = $LASTEXITCODE
Write-Output ('worker-exit=' + $e2)
if ($e1 -eq 0 -and $e2 -eq 0) {
  Write-Output '== GREEN -> commit config revert + matrix, then push =='
  $before = git -C $base rev-parse --short HEAD
  git -C $base add -A 2>&1 | Out-Null
  $co = (& git -C $base commit -m 'test(api): normalize tz/locale DST+RTL matrix; drop shared core-modules config override (ST-290)' 2>&1 | Out-String)
  $after = git -C $base rev-parse --short HEAD
  Write-Output ('head before=' + $before + ' after=' + $after + ' advanced=' + ($before -ne $after))
  if ($before -ne $after) {
    $pu = (git -C $base push 2>&1 | Out-String)
    $branch = git -C $base branch --show-current
    $remote = git -C $base rev-parse --short ('origin/' + $branch)
    Write-Output ('remote-tip=' + $remote + ' local-head=' + $after + ' caught-up=' + ($remote -eq $after))
    if ($remote -ne $after) {
      Write-Output '== push still blocked; hook tail =='
      ($pu -split [char]10) | Select-String -Pattern 'error|failed|exited|format' | Select-Object -First 4 | ForEach-Object { '  ' + $_.Line.Trim() }
    }
  } else {
    Write-Output '== hook rejected commit; tail =='
    ($co -split [char]10) | Select-String -Pattern 'error|fail|Unable|✖' | Select-Object -First 4 | ForEach-Object { '  ' + $_.Line.Trim() }
  }
} else {
  Write-Output '== RED - committing nothing =='
}
