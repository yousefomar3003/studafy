$base = 'C:\Users\User\Desktop\Studafy\studafy'
$q = [string][char]34
$files = @(
  "$base\apps\api\tests\tz-locale\attendance-correction-deadline.test.ts",
  "$base\apps\api\tests\tz-locale\digest-label-date.test.ts",
  "$base\apps\api\tests\tz-locale\locale-rtl.test.ts",
  "$base\apps\api\tests\tz-locale\scheduled-announcements-dst.test.ts",
  "$base\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts"
)
$comment = '// eslint-disable-next-line import-x/no-unresolved -- ' + $q + 'bun:test' + $q + ' is a virtual Bun runtime builtin'
$patched = 0
foreach ($f in $files) {
  $imp = Select-String -LiteralPath $f -Pattern 'from ' + $q + 'bun:test' + $q + 'bun' -ErrorAction SilentlyContinue
  if (-not $imp) { Write-Output "no-bun-import $f"; continue }
  $c = Get-Content -LiteralPath $f
  $i = $imp[0].LineNumber - 1
  $prev = if ($i -gt 0) { $c[$i - 1] } else { '' }
  if ($prev -match 'eslint-disable-next-line import-x/no-unresolved') { Write-Output "already-patched $f"; continue }
  $c = $c[0..($i-1)] + $comment + $c[$i..($c.Count-1)]
  Set-Content -LiteralPath $f -Value $c -Encoding utf8
  $patched++
  Write-Output "patched $f -> $((Get-Item -LiteralPath $f).Length) bytes"
}
Write-Output "patched=$patched"
