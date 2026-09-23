$base = 'C:\Users\User\Desktop\Studafy\studafy'
$cmt = '// eslint-disable-next-line import-x/no-unresolved -- bun:test is a virtual Bun runtime builtin'
$z = 'bun:test'
$files = @(
  "$base\apps\api\tests\tz-locale\attendance-correction-deadline.test.ts",
  "$base\apps\api\tests\tz-locale\digest-label-date.test.ts",
  "$base\apps\api\tests\tz-locale\locale-rtl.test.ts",
  "$base\apps\api\tests\tz-locale\scheduled-announcements-dst.test.ts",
  "$base\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts"
)
$done = 0
foreach ($f in $files) {
  if (-not (Test-Path -LiteralPath $f)) { Write-Output ('missing ' + $f); continue }
  $ls = Get-Content -LiteralPath $f
  $hit = -1
  for ($i = 0; $i -lt $ls.Count; $i++) {
    if ($ls[$i] -match $z) { $hit = $i; break }
  }
  if ($hit -lt 0) { Write-Output ('no-import ' + $f); continue }
  $prev = if ($hit -gt 0) { $ls[$hit - 1] } else { '' }
  if ($prev -like '*eslint-disable-next-line import-x/no-unresolved*') {
    Write-Output ('already ' + $f.Replace($base, ''))
    continue
  }
  $new = @()
  for ($i = 0; $i -lt $ls.Count; $i++) {
    if ($i -eq $hit) { $new += $cmt }
    $new += $ls[$i]
  }
  Set-Content -LiteralPath $f -Value $new -Encoding utf8
  $done++
  Write-Output ('patched ' + $f.Replace($base, '') + ' -> ' + (Get-Item -LiteralPath $f).Length + ' bytes')
}
Write-Output ('patched=' + $done)
