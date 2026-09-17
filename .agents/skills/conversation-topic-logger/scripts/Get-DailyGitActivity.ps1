[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{4}-\d{2}-\d{2}$')]
    [string]$Date,

    [string]$RepositoryRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

$resolvedRoot = (& git -C $RepositoryRoot rev-parse --show-toplevel 2>$null | Select-Object -First 1)
if (-not $resolvedRoot) {
    throw "Not a Git repository: $RepositoryRoot"
}
$resolvedRoot = $resolvedRoot.Trim()

$day = [DateTime]::ParseExact($Date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$nextDay = $day.AddDays(1)
$timeZone = [TimeZoneInfo]::Local
$start = [DateTimeOffset]::new($day, $timeZone.GetUtcOffset($day))
$end = [DateTimeOffset]::new($nextDay, $timeZone.GetUtcOffset($nextDay))
$startIso = $start.ToString('yyyy-MM-ddTHH:mm:sszzz')
$endIso = $end.ToString('yyyy-MM-ddTHH:mm:sszzz')

$format = '__COMMIT__%x09%H%x09%cI%x09%an%x09%s'
$rawLines = @(& git -C $resolvedRoot log --all "--since=$startIso" "--before=$endIso" "--pretty=format:$format" --numstat --find-renames)
if ($LASTEXITCODE -ne 0) {
    throw "git log failed for $Date"
}

$commits = [System.Collections.Generic.List[object]]::new()
$current = $null

foreach ($line in $rawLines) {
    if ($line.StartsWith('__COMMIT__')) {
        if ($null -ne $current) {
            $commits.Add([pscustomobject]$current)
        }

        $parts = $line -split "`t", 5
        if ($parts.Count -lt 5) {
            throw "Unexpected git log header: $line"
        }

        $commitTime = [DateTimeOffset]::Parse($parts[2], [Globalization.CultureInfo]::InvariantCulture)
        $current = [ordered]@{
            hash = $parts[1]
            shortHash = $parts[1].Substring(0, [Math]::Min(8, $parts[1].Length))
            committedAt = $parts[2]
            localDate = [TimeZoneInfo]::ConvertTime($commitTime, $timeZone).ToString('yyyy-MM-dd')
            author = $parts[3]
            subject = $parts[4]
            changes = [System.Collections.Generic.List[object]]::new()
        }
        continue
    }

    if ($null -eq $current -or [string]::IsNullOrWhiteSpace($line)) {
        continue
    }

    $changeParts = $line -split "`t", 3
    if ($changeParts.Count -eq 3) {
        $current.changes.Add([pscustomobject]@{
            additions = $changeParts[0]
            deletions = $changeParts[1]
            path = $changeParts[2]
        })
    }
}

if ($null -ne $current) {
    $commits.Add([pscustomobject]$current)
}

# Git's date parser is permissive around boundaries. Keep only commits whose
# committer timestamp resolves to the requested local calendar date.
$filteredCommits = @($commits | Where-Object { $_.localDate -eq $Date })
$uniquePaths = @(
    $filteredCommits |
        ForEach-Object { $_.changes } |
        ForEach-Object { $_.path } |
        Where-Object { $_ } |
        Sort-Object -Unique
)

[pscustomobject]@{
    date = $Date
    timeZone = $timeZone.Id
    repositoryRoot = $resolvedRoot
    commitCount = $filteredCommits.Count
    changedFileCount = $uniquePaths.Count
    commits = $filteredCommits
} | ConvertTo-Json -Depth 7
