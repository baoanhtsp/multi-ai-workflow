BeforeAll {
    $script:RepoRoot = Split-Path -Parent $PSScriptRoot
    $script:CommonScript = Join-Path $script:RepoRoot "antigravity\skills\claude-leader\scripts\lib\maw-common.ps1"
    $script:HooksScript  = Join-Path $script:RepoRoot "antigravity\skills\claude-leader\scripts\lib\maw-hooks.ps1"
    . $script:CommonScript
    . $script:HooksScript
}

Describe "ConvertTo-NativeArgument & Invoke-NativeProcess" {
    BeforeAll {
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        $script:HasNode = [bool]$nodeCmd
        if ($script:HasNode) {
            $script:NodeExe = $nodeCmd.Source
        }
    }

    It "Round-trips multi-line, quotes, command injection strings, trailing backslashes, and Vietnamese text via a real child process" {
        $vnText = "Xin ch$([char]0x00E0)o th$([char]0x1EBF) gi$([char]0x1EDB)i $([char]0x2014) Ki$([char]0x1EC3)m th$([char]0x1EED) ti$([char]0x1EBF)ng Vi$([char]0x1EC7)t & k$([char]0x00FD) t$([char]0x1EF1)!"
        $cases = @(
            "",
            "simple-token",
            "Line 1: implement API`nLine 2: validate headers`r`nLine 3: done",
            'Rename the 12" field & echo INJECTED_BY_PROMPT | calc.exe',
            'C:\Program Files\My App\TrailingSlash\',
            'Backslash before quote: a\"b and \\"c\"',
            $vnText
        )

        if ($script:HasNode) {
            $res = Invoke-NativeProcess -FilePath $script:NodeExe -ArgumentList (@("-e", "console.log(JSON.stringify(process.argv.slice(1)))") + $cases)
            $res.ExitCode | Should -Be 0
            $decoded = $res.StdOut.Trim() | ConvertFrom-Json
            $decoded.Count | Should -Be $cases.Count
            for ($i = 0; $i -lt $cases.Count; $i++) {
                $decoded[$i] | Should -BeExactly $cases[$i]
            }
        } else {
            $helperFile = Join-Path $env:TEMP ("maw_arg_echo_" + [guid]::NewGuid().ToString("N") + ".ps1")
            try {
                [System.IO.File]::WriteAllText($helperFile, '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ConvertTo-Json -InputObject @($args) -Compress', (New-Object System.Text.UTF8Encoding($true)))
                $res = Invoke-NativeProcess -FilePath "powershell.exe" -ArgumentList (@("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $helperFile) + $cases)
                $res.ExitCode | Should -Be 0
                $decoded = $res.StdOut.Trim() | ConvertFrom-Json
                for ($i = 0; $i -lt $cases.Count; $i++) {
                    $decoded[$i] | Should -BeExactly $cases[$i]
                }
            } finally {
                Remove-Item -LiteralPath $helperFile -Force -ErrorAction SilentlyContinue
            }
        }
    }

    It "Finishes Invoke-NativeProcess inside Start-Job without hanging and supports -StdinText (A1 regression test)" {
        $commonPath = $script:CommonScript
        $repoDir = $script:RepoRoot
        $job = Start-Job -ScriptBlock {
            param($cPath, $wDir)
            . $cPath
            $res1 = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $wDir, "status", "--porcelain") -WorkingDirectory $wDir -TimeoutMs 15000
            $res2 = Invoke-NativeProcess -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-Command", '[Console]::In.ReadToEnd()') -StdinText "hello-stdin-v4" -TimeoutMs 15000
            return [PSCustomObject]@{
                GitExit   = $res1.ExitCode
                StdinExit = $res2.ExitCode
                StdinOut  = $res2.StdOut.Trim()
            }
        } -ArgumentList $commonPath, $repoDir

        try {
            $finished = Wait-Job -Job $job -Timeout 20
            $finished | Should -Not -BeNullOrEmpty
            $out = Receive-Job -Job $job
            $out.GitExit | Should -Be 0
            $out.StdinExit | Should -Be 0
            $out.StdinOut | Should -Be "hello-stdin-v4"
        } finally {
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe "Get-ReviewVerdict" {
    It "Takes the last VERDICT: and SCORE: line when multiple appear" {
        $text = @"
Round 1 previously had:
SCORE: 6.0/10
VERDICT: CHANGES_REQUESTED

After re-checking all fixes:
SCORE: 9.2/10
VERDICT: APPROVED
"@
        $r = Get-ReviewVerdict -Text $text
        $r.Verdict | Should -Be "APPROVED"
        $r.Score | Should -Be "9.2/10"
        $r.ScoreValue | Should -Be 9.2
    }

    It "Ignores 'not CHANGES_REQUESTED' in prose when followed by VERDICT: APPROVED" {
        $text = @"
This update is clean and not CHANGES_REQUESTED anymore.
All security checks pass.
SCORE: 9/10
VERDICT: APPROVED
"@
        $r = Get-ReviewVerdict -Text $text
        $r.Verdict | Should -Be "APPROVED"
        $r.Score | Should -Be "9/10"
        $r.ScoreValue | Should -Be 9.0
    }

    It "Falls back to the last standalone keyword and X/10 when no explicit VERDICT: header is present" {
        $text = "Overall score is 8.5/10. Although we considered APPROVED earlier, final decision is CHANGES_REQUESTED."
        $r = Get-ReviewVerdict -Text $text
        $r.Verdict | Should -Be "CHANGES_REQUESTED"
        $r.Score | Should -Be "8.5/10"
        $r.ScoreValue | Should -Be 8.5
    }

    It "Returns UNKNOWN when no verdict is present" {
        $r = Get-ReviewVerdict -Text "Error: connection reset by peer"
        $r.Verdict | Should -Be "UNKNOWN"
        $r.Score | Should -Be ""
        $r.ScoreValue | Should -BeNullOrEmpty
    }
}

Describe "Get-ReviewDiff" {
    It "Includes untracked text files without staging them in the index and skips binary/oversized files" {
        $tmpDir = Join-Path $env:TEMP ("maw_diff_test_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
        try {
            & git -C $tmpDir init 2>$null | Out-Null
            & git -C $tmpDir config core.autocrlf false
            & git -C $tmpDir config user.email "test@example.com"
            & git -C $tmpDir config user.name "Test"

            $trackedFile = Join-Path $tmpDir "tracked.txt"
            [System.IO.File]::WriteAllText($trackedFile, "line1`n", (New-Object System.Text.UTF8Encoding($false)))
            & git -C $tmpDir add tracked.txt
            & git -C $tmpDir commit -m "initial" 2>$null | Out-Null

            [System.IO.File]::WriteAllText($trackedFile, "line1`nline2`n", (New-Object System.Text.UTF8Encoding($false)))

            $untrackedFile = Join-Path $tmpDir "newfile.ps1"
            [System.IO.File]::WriteAllText($untrackedFile, "Write-Output 'hello untracked'`n", (New-Object System.Text.UTF8Encoding($false)))

            $binFile = Join-Path $tmpDir "image.bin"
            [System.IO.File]::WriteAllBytes($binFile, [byte[]]@(0x89, 0x50, 0x4E, 0x47, 0x00, 0x01, 0x02))

            $diffText = Get-ReviewDiff -WorkDir $tmpDir
            $diffText | Should -Match "line2"
            $diffText | Should -Match "newfile\.ps1"
            $diffText | Should -Match "hello untracked"
            $diffText | Should -Match "image\.bin \(binary\)"

            # Verify index was NOT modified
            $cached = (& git -C $tmpDir diff --cached --name-only) -join ""
            $cached | Should -Be ""
        } finally {
            Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe "Evaluate-TranscriptTurn & Read-TranscriptTurnIncremental (R3)" {
    It "Rejects an interim PLANNER_RESPONSE when followed by a non-SYSTEM_MESSAGE step" {
        $steps = @(
            [pscustomobject]@{ step_index = 10; type = "USER_INPUT"; status = "DONE"; content = "Implement feature" },
            [pscustomobject]@{ step_index = 11; type = "PLANNER_RESPONSE"; status = "DONE"; content = "Interim note: running Pester..."; tool_calls = @() },
            [pscustomobject]@{ step_index = 12; type = "TOOL_EXECUTION"; status = "RUNNING"; content = "" }
        )
        $res = Evaluate-TranscriptTurn -Steps $steps -BaselineStepCount 1 -QuietSeconds 20 -QuietElapsedSeconds 30
        $res.Completed | Should -BeFalse
    }

    It "Rejects an interim PLANNER_RESPONSE when the step immediately preceding it has status RUNNING (async background task), but accepts a later final PLANNER_RESPONSE even if the earlier step stays RUNNING forever" {
        $stepsWhileAsyncRunning = @(
            [pscustomobject]@{ step_index = 700; type = "USER_INPUT"; status = "DONE"; content = "Run Pester suite" },
            [pscustomobject]@{ step_index = 703; type = "GENERIC"; status = "RUNNING"; content = "Background task task-703 started" },
            [pscustomobject]@{ step_index = 704; type = "PLANNER_RESPONSE"; status = "DONE"; content = "Dang chay bo kiem thu Pester..."; tool_calls = @() }
        )
        $resInterim = Evaluate-TranscriptTurn -Steps $stepsWhileAsyncRunning -MinStepIndex 699 -QuietSeconds 20 -QuietElapsedSeconds 45
        $resInterim.Completed | Should -BeFalse

        # Later: background task finishes via wakeup, a DONE step occurs, and final PLANNER_RESPONSE is written (while step 703 remains RUNNING in the append-only transcript)
        $stepsAfterFinish = $stepsWhileAsyncRunning + @(
            [pscustomobject]@{ step_index = 705; type = "GENERIC"; status = "DONE"; content = "Task completed" },
            [pscustomobject]@{ step_index = 706; type = "PLANNER_RESPONSE"; status = "DONE"; content = "All tests green! Final report."; tool_calls = @() }
        )
        $resFinal = Evaluate-TranscriptTurn -Steps $stepsAfterFinish -MinStepIndex 699 -QuietSeconds 20 -QuietElapsedSeconds 25
        $resFinal.Completed | Should -BeTrue
        $resFinal.StepIndex | Should -Be 706
        $resFinal.Text | Should -Be "All tests green! Final report."
    }

    It "Rejects a candidate final PLANNER_RESPONSE until QuietElapsedSeconds >= QuietSeconds" {
        $steps = @(
            [pscustomobject]@{ step_index = 10; type = "USER_INPUT"; status = "DONE"; content = "Implement feature" },
            [pscustomobject]@{ step_index = 11; type = "PLANNER_RESPONSE"; status = "DONE"; content = "All done!"; tool_calls = @() },
            [pscustomobject]@{ step_index = 12; type = "SYSTEM_MESSAGE"; status = "DONE"; content = "Notification" }
        )
        $resEarly = Evaluate-TranscriptTurn -Steps $steps -BaselineStepCount 1 -QuietSeconds 20 -QuietElapsedSeconds 5
        $resEarly.Completed | Should -BeFalse
        $resEarly.WaitingQuiet | Should -BeTrue

        $resReady = Evaluate-TranscriptTurn -Steps $steps -BaselineStepCount 1 -QuietSeconds 20 -QuietElapsedSeconds 21
        $resReady.Completed | Should -BeTrue
        $resReady.StepIndex | Should -Be 11
        $resReady.Text | Should -Be "All done!"
    }

    It "Reads transcript.jsonl incrementally by byte offset and resolves full content from transcript_full.jsonl" {
        $tmpDir = Join-Path $env:TEMP ("maw_transcript_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
        try {
            $tFile = Join-Path $tmpDir "transcript.jsonl"
            $fFile = Join-Path $tmpDir "transcript_full.jsonl"
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)

            $line1 = '{"step_index":1,"type":"USER_INPUT","status":"DONE","content":"Task"}' + "`n"
            $line2 = '{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","content":"Interim update...","tool_calls":[]}' + "`n"
            [System.IO.File]::WriteAllText($tFile, $line1 + $line2, $utf8NoBom)
            [System.IO.File]::WriteAllText($fFile, $line1 + $line2, $utf8NoBom)

            $state = New-TranscriptReaderState -TranscriptPath $tFile -FullTranscriptPath $fFile -BaselineStepCount 1
            # Append a tool step and then a final truncated response
            $line3 = '{"step_index":3,"type":"TOOL_RESULT","status":"DONE","content":"ok"}' + "`n"
            $line4Compact = '{"step_index":4,"type":"PLANNER_RESPONSE","status":"DONE","content":"Trunc...","truncated_fields":["content"],"tool_calls":[]}' + "`n"
            $line4Full    = '{"step_index":4,"type":"PLANNER_RESPONSE","status":"DONE","content":"Full untruncated final report from step 4.","tool_calls":[]}' + "`n"
            [System.IO.File]::AppendAllText($tFile, $line3 + $line4Compact, $utf8NoBom)
            [System.IO.File]::AppendAllText($fFile, $line3 + $line4Full, $utf8NoBom)

            # Backdate LastWriteTime by 25s to satisfy QuietSeconds = 20
            (Get-Item -LiteralPath $tFile).LastWriteTimeUtc = [DateTime]::UtcNow.AddSeconds(-25)

            $turn = Read-TranscriptTurnIncremental -State $state -QuietSeconds 20
            $turn.Completed | Should -BeTrue
            $turn.StepIndex | Should -Be 4
            $turn.Text | Should -Be "Full untruncated final report from step 4."
            $state.ByteOffset | Should -BeGreaterThan 0
        } finally {
            Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "Preserves multi-byte UTF-8 Vietnamese characters when a write is split mid-character across two incremental reads (m3)" {
        $tmpDir = Join-Path $env:TEMP ("maw_utf8_split_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
        try {
            $tFile = Join-Path $tmpDir "transcript.jsonl"
            $vnContent = "B$([char]0x00E1)o c$([char]0x00E1)o ti$([char]0x1EBF)ng Vi$([char]0x1EC7)t $([char]0x0111)$([char]0x1EA7)y $([char]0x0111)$([char]0x1EE7) kh$([char]0x00F4)ng l$([char]0x1ED7)i UTF-8"
            $jsonLine = (@{
                step_index = 1
                type       = "PLANNER_RESPONSE"
                status     = "DONE"
                content    = $vnContent
                tool_calls = @()
            } | ConvertTo-Json -Compress) + "`n"

            $allBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonLine)
            # Find the first 3-byte UTF-8 lead byte (0xE0..0xEF) and split immediately after it (mid-character)
            $splitIdx = -1
            for ($i = 0; $i -lt $allBytes.Length; $i++) {
                if ($allBytes[$i] -ge 0xE0 -and $allBytes[$i] -le 0xEF) {
                    $splitIdx = $i
                    break
                }
            }
            $splitIdx | Should -BeGreaterThan 0

            $part1 = $allBytes[0..$splitIdx]
            $part2 = $allBytes[($splitIdx + 1)..($allBytes.Length - 1)]

            $state = New-TranscriptReaderState -TranscriptPath $tFile -BaselineStepCount 0

            # First write: stops in the middle of a multi-byte UTF-8 character (before '\n')
            [System.IO.File]::WriteAllBytes($tFile, [byte[]]$part1)
            Update-TranscriptReaderState -State $state -TranscriptPath $tFile
            $state.Steps.Count | Should -Be 0
            $state.RemainderBytes.Length | Should -Be $part1.Length

            # Second write: appends the remaining bytes of the character and the trailing '\n'
            $fs = New-Object System.IO.FileStream($tFile, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
            try {
                $fs.Write([byte[]]$part2, 0, $part2.Length)
            } finally {
                $fs.Dispose()
            }

            Update-TranscriptReaderState -State $state -TranscriptPath $tFile
            $state.Steps.Count | Should -Be 1
            $state.Steps[0].content | Should -BeExactly $vnContent
        } finally {
            Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe "F0 Script Hooks (Invoke-MawHooks) & Antigravity Parallel Conversation ProjectId Resolution" {
    It "executes hooks in name order, catches hook errors without crashing, and returns the first blocking hook" {
        $tmpHooksRoot = Join-Path $env:TEMP ("maw_hooks_unit_" + [guid]::NewGuid().ToString("N"))
        $evtDir = Join-Path $tmpHooksRoot "before-agent"
        New-Item -ItemType Directory -Path $evtDir -Force | Out-Null
        try {
            $utf8 = New-Object System.Text.UTF8Encoding($false)
            # 10-ok.ps1: non-blocking
            [System.IO.File]::WriteAllText((Join-Path $evtDir "10-ok.ps1"), '@{ Block = $false }', $utf8)
            # 20-throw.ps1: throws an exception that must be caught and logged
            [System.IO.File]::WriteAllText((Join-Path $evtDir "20-throw.ps1"), 'throw "Simulated hook error in 20-throw"', $utf8)

            $resPass = @(Invoke-MawHooks -Event "before-agent" -Context @{ agent = "claude"; role = "backend" } -HooksRoot $tmpHooksRoot)
            $finalPass = $resPass[-1]
            $finalPass.Block | Should -BeFalse
            ($resPass -join "`n") | Should -Match "Simulated hook error in 20-throw"

            # Add 30-block.ps1 and 40-never-reached.ps1
            $markerFile = Join-Path $tmpHooksRoot "40-ran.txt"
            [System.IO.File]::WriteAllText((Join-Path $evtDir "30-block.ps1"), '@{ Block = $true; Reason = "Blocked by policy for agent=" + $Context.agent }', $utf8)
            [System.IO.File]::WriteAllText((Join-Path $evtDir "40-after.ps1"), "[System.IO.File]::WriteAllText('$($markerFile.Replace("'", "''"))', 'ran'); @{ Block = `$false }", $utf8)

            $resBlock = @(Invoke-MawHooks -Event "before-agent" -Context @{ agent = "codex"; role = "reviewer" } -HooksRoot $tmpHooksRoot)
            $finalBlock = $resBlock[-1]
            $finalBlock.Block | Should -BeTrue
            $finalBlock.Reason | Should -Be "Blocked by policy for agent=codex"
            (Test-Path -LiteralPath $markerFile) | Should -BeFalse
        } finally {
            Remove-Item -LiteralPath $tmpHooksRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "resolves Antigravity projectId from mocked metadata JSON for exact workspace, percent-encoded URI, parent repo, and git worktree" {
        $meta1 = (@{
            response = @{
                conversationMetadata = @{
                    metadata = @{
                        projectId     = "11111111-2222-3333-4444-555555555555"
                        workspaces    = @(
                            @{
                                workspaceFolderAbsoluteUri = "file:///c:/laragon/www/other-project"
                                gitRootAbsoluteUri         = "file:///c:/laragon/www/other-project"
                            }
                        )
                        workspaceUris = @("file:///c%3A/laragon/www/other-project")
                    }
                }
            }
        } | ConvertTo-Json -Depth 8 -Compress)

        $meta2 = (@{
            response = @{
                conversationMetadata = @{
                    metadata = @{
                        projectId     = "e8902b50-543f-4bb1-9525-8bf93a1f06be"
                        workspaces    = @(
                            @{
                                workspaceFolderAbsoluteUri = "file:///c:/laragon/www/multi-ai-workflow"
                                gitRootAbsoluteUri         = "file:///c:/laragon/www/multi-ai-workflow"
                            }
                        )
                        workspaceUris = @("file:///c%3A/laragon/www/multi-ai-workflow")
                    }
                }
            }
        } | ConvertTo-Json -Depth 8 -Compress)

        $metas = @($meta1, $meta2)

        # 1. Exact workspace match
        $pidExact = Resolve-AntigravityProjectIdFromMetas -WorkDir "C:\laragon\www\multi-ai-workflow" -MetadataList $metas
        $pidExact | Should -Be "e8902b50-543f-4bb1-9525-8bf93a1f06be"

        # 2. Subdirectory / parent repo match
        $pidSub = Resolve-AntigravityProjectIdFromMetas -WorkDir "C:\laragon\www\multi-ai-workflow\server\features" -MetadataList $metas
        $pidSub | Should -Be "e8902b50-543f-4bb1-9525-8bf93a1f06be"

        # 3. Git worktree resolution via git rev-parse --git-common-dir
        $tmpBase = Join-Path $env:TEMP ("maw_wt_test_" + [guid]::NewGuid().ToString("N"))
        $mainRepo = Join-Path $tmpBase "main-repo"
        $linkedWt = Join-Path $tmpBase "wt-stream-1"
        New-Item -ItemType Directory -Path $mainRepo -Force | Out-Null
        try {
            & git -C $mainRepo init 2>$null | Out-Null
            & git -C $mainRepo config user.email "test@example.com"
            & git -C $mainRepo config user.name "Test"
            [System.IO.File]::WriteAllText((Join-Path $mainRepo "README.md"), "# test`n")
            & git -C $mainRepo add README.md
            & git -C $mainRepo commit -m "init" 2>$null | Out-Null
            & git -C $mainRepo worktree add -b feat/s1 $linkedWt 2>$null | Out-Null

            $resolvedMain = Resolve-GitMainWorktreePath -WorkDir $linkedWt
            (Normalize-MawWorkspacePath $resolvedMain) | Should -Be (Normalize-MawWorkspacePath $mainRepo)

            $wtMeta = (@{
                response = @{
                    conversationMetadata = @{
                        metadata = @{
                            projectId  = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
                            workspaces = @(
                                @{
                                    workspaceFolderAbsoluteUri = "file:///" + ($mainRepo.Replace('\', '/'))
                                    gitRootAbsoluteUri         = "file:///" + ($mainRepo.Replace('\', '/'))
                                }
                            )
                        }
                    }
                }
            } | ConvertTo-Json -Depth 8 -Compress)

            $pidWt = Resolve-AntigravityProjectIdFromMetas -WorkDir $linkedWt -MetadataList @($meta1, $wtMeta)
            $pidWt | Should -Be "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        } finally {
            Remove-Item -LiteralPath $tmpBase -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
