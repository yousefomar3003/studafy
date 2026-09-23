$base = 'C:\Users\User\Desktop\Studafy\studafy'
$files = @(
  "$base\apps\api\tests\tz-locale\attendance-correction-deadline.test.ts",
  "$base\apps\api\tests\tz-locale\digest-label-date.test.ts",
  "$base\apps\api\tests\tz-locale\locale-rtl.test.ts",
  "$base\apps\api\tests\tz-locale\scheduled-announcements-dst.test.ts",
  "$base\apps\workers\src\queues\billing\__tests__\dunning-scheduled-dst.test.ts"
)
$cmt = '// eslint-disable-next-line import-x/no-unresolved -- virtual Bun runtime builtin'
$did = 0
foreach ($f in $files) {
  if (-not (Test-Path -LiteralPath $f)) { Write-Output "missing $f"; continue }
  $lines = Get-Content -LiteralPath $f
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'from .+bun:test.') { $idx = $i; break }
  }
  if ($idx -lt 0) { Write-Output "no-import $f"; continue }
  if ($idx -gt 0 -and $lines[$idx-1] -match 'eslint-disable-next-line import-x/no-unresolved') {
    Write-Output "already $f"
  } else {
    $new = @()
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($i -eq $idx) { $new += $cmt }
      $new += $lines[$i]
    }
    Set-Content -LiteralPath $f -Value $new -Encoding utf8
    $did++
    Write-Output "patched $f bytes=$((Get-Item -LiteralPath $f).Length)"
  }
}
Write-Output "patched=$did"
