$base = 'C:\Users\User\Desktop\Studafy\studafy'
$files = @(
  "$base\apps\api\tests\tz-locale\attendance-correction-deadline.test.ts",
  "$base\apps\api\tests\tz-locale\digest-label-date.test.ts",
  "$base\apps\api\tests\tz-locale\locale-rtl.test.ts",
  "$base\apps\api\tests\tz-locale\scheduled-announcements-dst.test.ts",
  "$base\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts"
)
$disable = '// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun runtime builtin with no filesystem path'
$did = 0
foreach ($f in $files) {
  if (-not (Test-Path -LiteralPath $f)) { Write-Output "MISSING $f"; continue }
  $lines = Get-Content -LiteralPath $f
  $importIdx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "from ['`"]bun:test['`"]") { $importIdx = $i; break }
  }
  if ($importIdx -lt 0) { Write-Output "no-bun:test-import $f"; continue }
  $prev = if ($importIdx -gt 0) { $lines[$importIdx - 1] } else { '' }
  if ($prev -match 'eslint-disable-next-line import-x/no-unresolved') { Write-Output "already-patched $f"; continue }
  $lines = $lines[0..($importIdx - 1)] + $disable + $lines[$importIdx..($lines.Count - 1)]
  Set-Content -LiteralPath $f -Value $lines -Encoding utf8
  $did++
  Write-Output "patched $f -> $((Get-Item -LiteralPath $f).Length) bytes"
}
Write-Output "patched=$did"
