$base = 'C:\Users\User\Desktop\Studafy\studafy'
Write-Output '== known-green worker suite: bun import + any disable comment =='
$g = Get-ChildItem -LiteralPath ($base + '\apps\workers\src\queues\billing'>) -ErrorAction SilentlyContinue
$f = $null
foreach ($x in $g) { if ($x.FullName -match 'notification-digest-producer') { $f = $x.FullName } }
if (-not $f) {
  $cand = Get-ChildItem -LiteralPath $base -Recurse -File -Filter notification-digest-producer.test.ts -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch 'node_modules|\\build\\' } | Select-Object -First 1
  if ($cand) { $f = $cand.FullName }
}
if ($f) {
  Write-Output ('suite=' + $f.Replace($base+'\',''))
  (Get-Content -LiteralPath $f -TotalCount 20) | ForEach-Object { if ($_ -match 'bun:test|eslint-disable|from .') { '  ' + $_.Trim() } }
} else {
  Write-Output 'known-green worker suite not found'
}
$out1 = & bun test ($base + '\apps\api\tests\tz-locale') 2>&1 | Out-String
$p1 = 0; $f1 = -1
$m1 = [regex]::Match($out1, '^\s*([0-9]+)\s+pass', 'Multiline')
$m1b = [regex]::Match($out1, '^\s*([0-9]+)\s+fail', 'Multiline')
if ($m1.Success) { $p1 = [int]$m1.Groups[1].Value }
if ($m1b.Success) { $f1 = [int]$m1b.Groups[1].Value }
Write-Output ('api tz-locale pass=' + $p1 + ' fail=' + $f1)
if ($f) {
  $out2 = & bun test $f 2>&1 | Out-String
  $m2 = [regex]::Match($out2, '^\s*([0-9]+)\s+fail', 'Multiline')
  $p2 = [regex]::Match($out2, '^\s*([0-9]+)\s+pass', 'Multiline')
  $f2 = -1; $p2v = 0
  if ($m2.Success) { $f2 = [int]$m2.Groups[1].Value }
  if ($p2.Success) { $p2v = [int]$p2.Groups[1].Value }
  Write-Output ('worker suite pass=' + $p2v + ' fail=' + $f2)
} else { $f2 = -1 }
if ($f1 -eq 0) {
  Write-Output '== api suite GREEN -> add+commit+push =='
  $before = (git -C $base rev-parse --short HEAD).Trim()
  git -C $base add -A 2>$null | Out-Null
  $co = (& git -C $base commit -m 'test(api): pin 2026 timezone/locale DST+RTL test matrix (ST-290') 2>&1 | Out-String
  $after = (git -C $base rev-parse --short HEAD).Trim()
  Write-Output ('before=' + $before + ' after=' + $after + ' advanced=' + ($before -ne $after))
  if ($before -ne $after) {
    $pu = (& git -C $base push 2>&1 | Out-String)
    Write-Output 'push-output:'
    ($pu -split "`r?`n") | Where-Object { $_ -match 'up-to-date|->|rejected|error' } | Select-Object -First 3 | ForEach-Object { '  ' + $_.Trim() }
    $br = (git -C $base branch --show-current).Trim()
    $rh = (git -C $base rev-parse --short ('origin/' + $br)).Trim()
    $lh = (git -C $base rev-parse --short HEAD).Trim()
    Write-Output ('branch=' + $br + ' local=' + $lh + ' remote=' + $rh + ' match=' + ($lh -eq $rh))
  }
} else {
  Write-Output '== api suite still failing - no commit =='
  ($out1 -split "`r?`n") | Where-Object { $_ -match 'expect|Received|Expected|error' } | Select-Object -First 4 | ForEach-Object { '  ' + $_.Trim() }
}

