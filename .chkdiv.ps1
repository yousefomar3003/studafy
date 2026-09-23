$base = 'C:\Users\User\Desktop\Studafy\studafy'

git -C $base fetch origin 2>$null | Out-Null

$local  = git -C $base rev-parse --short HEAD
$branch = git -C $base branch --show-current
$remote = git -C $base rev-parse --short ('origin/' + $branch)

Write-Output ('branch=' + $branch)
Write-Output ('local =' + $local)
Write-Output ('remote=' + $remote)
Write-Output ('equal  =' + ($local -eq $remote))

$mergeBase = git -C $base merge-base HEAD ('origin/' + $branch)
$mb = (git -C $base rev-parse --short $mergeBase)
$isAncestor = git -C $base merge-base --is-ancestor $mergeBase HEAD
$aOk = $LASTEXITCODE -eq 0
Write-Output ('merge-base=' + $mb + ' mergbase-is-ancestor-of-head=' + $aOk)

$behind = git -C $base rev-list --count ('origin/' + $branch + '..HEAD')
$ahead  = git -C $base rev-list --count ('HEAD..origin/' + $branch)
Write-Output ('local-only-commits=' + $behind + ' remote-only-commits=' + $ahead)

Write-Output '== is remote a strict ancestor of local? (fast-forward possible -> normal push suffices) =='
$ff = git -C $base rev-list --count ('origin/' + $branch + '..HEAD')
Write-Output ('ff-check: remote..local=' + $ff + ' diverged=' + (($ahead -gt 0) -and ($behind -gt 0)))

Write-Output '== last 3 local commits =='
git -C $base log --oneline -3
Write-Output '== last 3 remote commits =='
git -C $base log --oneline -3 ('origin/' + $branch)
