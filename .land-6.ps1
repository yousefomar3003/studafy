$base = 'C:\Users\User\Desktop\Studafy\studafy'
$q = [string][char]34
$cmt = '// eslint-disable-next-line import-x/no-unresolved -- ' + $q + 'bun:test' + $q + ' is a virtual Bun runtime builtin with no filesystem path'
$files = @(
  $base + '\apps\api\tests\tz-locale\attendance-correction-deadline.test.ts',
  $base + '\apps\api\tests\tz-locale\digest-label-date.test.ts',
  $base + '\apps\api\tests\tz-locale\locale-rtl.test.ts',
  $base + '\apps\api\tests\tz-locale\scheduled-announcements-dst.test.ts',
  $base + '\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts'
)
foreach ($f in $files) {
  $ls = @(Get-Content -LiteralPath $f)
  $remove = New-Object System.Collections.Generic.HashSet[int]
  for ($i = $ls.Count - 1; $i -ge 1; $i--) {
    if ($ls[$i] -match 'bun:test') {
      $j = $i - 1
      while ($j -ge 1 -and $ls[$j] -match 'eslint-disable-next-line import-x/no-unresolved') {
        $null = $remove.Add($j)
        $j--
      }
      if ($j -lt 0 -or -not $ls[$j] -eq $null) {
        # no disable directly above -> insert one at position $i
      }
    }
  }
  # rebuild: strip duplicate disables, then insert one exactly above each bun:test import line
  $out = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $ls.Count; $i++) {
    if ($remove.Contains($i)) { continue }
    if ($ls[$i] -match 'bun:test') { $out.Add($cmt) }
    $out.Add($ls[$i])
  }
  Set-Content -LiteralPath $f -Value $out.ToArray() -Encoding utf8
  $dup = (Select-String -LiteralPath $f -Pattern 'eslint-disable-next-line import-x/no-unresolved' | Measure-Object).Count
  $imp = (Select-String -LiteralPath $f -Pattern 'bun:test' | Measure-Object).Count
  Write-Output ('ok bytes=' + (Get-Item -LiteralPath $f).Length + ' disables=' + $dup + ' bun-refs=' + $imp + ' ' + $f.Replace($base + '\', ''))
}
Write-Output '== run suites =='
$o1 = & bun test ($base + '\apps\api\tests\tz-locale') 2>&1 | Out-String
$o2 = & bun test ($base + '\apps\workers\src\queues\billing\__tests__') 2>&1 | Out-String
$e1 = $LASTEXITCODE
$o2r = & bun test ($base + '\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts') 2>&1 | Out-String
$e2 = $LASTEXITCODE
Write-Output ('api-exit=' + $e1)
Write-Output ($o1.Trim().Split([char]10) | Where-Object { $_ -match 'pass|fail|Ran' } | Select-Object -Last 2)
Write-Output ('worker-exit=' + $e2)
Write-Output ($o2r.Trim().Split([char]10) | Where-Object { $_ -match 'pass|fail|Ran' } | Select-Object -Last 2)
if ($e1 -eq 0 -and $e2 -eq 0) {
  Write-Output '== GREEN -> commit + push =='
  $before = git -C $base rev-parse --short HEAD
  git -C $base add apps/api/tests/tz-locale apps/workers/src/queues/billing/__tests__ docs/testing/timezone-test-catalog.md 2>&1 | Out-Null
  $co = (& git -C $base commit -m 'test(api): pin 2026 tz/locale DST+RTL matrix (ST-290)' 2>&1 | Out-String)
  $after = git -C $base rev-parse --short HEAD
  $adv = $before -ne $after
  Write-Output ('head before=' + $before + ' after=' + $after + ' advanced=' + $adv)
  if ($adv) {
    $pu = (git -C $base push 2>&1 | Out-String)
    $branch = git -C $base branch --show-current
    $remote = git -C $base rev-parse --short ('origin/' + $branch)
    Write-Output ('remote-tip=' + $remote + ' local-head=' + $after + ' match=' + ($remote -eq $after))
    if ($remote -ne $after) { Write-Output '== re-push needed ==' ; (git -C $base push 2>&1 | Out-String) | Select-Object -Last 2 }
  } else {
    Write-Output '== hook rejected commit =='
    ($co -split [char]10) | Where-Object { $_ -match 'error|fail|Unable|✖' } | Select-Object -First 5
  }
} else {
  Write-Output '== RED - no commit =='
  ($o1 -split [char]10) | Where-Object { $_ -match 'Expected|Received|error' } | Select-Object -First 4
  ($o2r -split [char]10) | Where-Object { $_ -match 'Expected|Received|error' } | Select-Object -First 4
}
