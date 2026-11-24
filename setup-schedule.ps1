<#
.SYNOPSIS
    Registers or manages a scheduled task in Windows Task Scheduler for the RM Test Pipeline.
.DESCRIPTION
    Creates a scheduled job that runs the RM Electron UI/Pipeline test suite automatically,
    sends updates in JSON format to the backend, and displays an admin popup on failures.
    Defaults to running directly every day at a configured time (e.g. 09:00 AM).
.PARAMETER Action
    Action to perform: 'register', 'unregister', 'run-now', or 'status'.
.PARAMETER Frequency
    'Daily' (default) to run once per day at a specific time, or 'Interval' to run repeatedly.
.PARAMETER DailyAt
    Time of day for daily run, in 24-hour format HH:mm (default: '09:00').
.PARAMETER IntervalMinutes
    If Frequency is 'Interval', how often to run in minutes (default: 60).
.EXAMPLE
    # Register to check directly every day at 09:00 AM:
    .\setup-schedule.ps1 -Action register -Frequency Daily -DailyAt "09:00"

    # Register to check every day at 08:30 AM:
    .\setup-schedule.ps1 -Action register -DailyAt "08:30"

    # Check status:
    .\setup-schedule.ps1 -Action status

    # Run immediately:
    .\setup-schedule.ps1 -Action run-now

    # Unregister:
    .\setup-schedule.ps1 -Action unregister
#>

param (
    [ValidateSet('register', 'unregister', 'run-now', 'status')]
    [string]$Action = 'register',

    [ValidateSet('Daily', 'Interval')]
    [string]$Frequency = 'Daily',

    [string]$DailyAt = '09:00',

    [int]$IntervalMinutes = 60
)

$TaskName = "RM-App-Test-Pipeline"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$NodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
    $NodePath = "C:\Program Files\nodejs\node.exe"
}
$RunnerScript = Join-Path $ScriptDir "pipeline-runner.cjs"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  RM Electron Automated Pipeline Task Scheduler Manager   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

switch ($Action) {
    'register' {
        Write-Host "[INFO] Registering Windows Scheduled Task: $TaskName" -ForegroundColor Yellow
        Write-Host "  • Node Executable: $NodePath"
        Write-Host "  • Script Path:     $RunnerScript"

        $ActionObj = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$RunnerScript`"" -WorkingDirectory $ScriptDir

        if ($Frequency -eq 'Daily') {
            Write-Host "  • Schedule Type:   DAILY (direct check every day at $DailyAt)" -ForegroundColor Green
            $Trigger = New-ScheduledTaskTrigger -Daily -At $DailyAt
        } else {
            Write-Host "  • Schedule Type:   INTERVAL (every $IntervalMinutes minute(s))" -ForegroundColor Green
            $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
        }

        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)

        # Unregister previous task if exists
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

        Register-ScheduledTask -TaskName $TaskName -Action $ActionObj -Trigger $Trigger -Settings $Settings -Description "Daily automated test pipeline for RM Electron app across mentioned target apps with backend JSON updates and admin failure popups." | Out-Null

        Write-Host "[SUCCESS] Task '$TaskName' registered successfully!" -ForegroundColor Green
        Write-Host "The pipeline will now check directly every day at $DailyAt." -ForegroundColor Green
        Write-Host "Check status anytime with: .\setup-schedule.ps1 -Action status"
    }

    'unregister' {
        Write-Host "[INFO] Unregistering scheduled task: $TaskName" -ForegroundColor Yellow
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "[SUCCESS] Task '$TaskName' removed." -ForegroundColor Green
    }

    'run-now' {
        Write-Host "[INFO] Triggering task '$TaskName' immediately..." -ForegroundColor Yellow
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "[SUCCESS] Task triggered. Check reports/ directory for latest results." -ForegroundColor Green
    }

    'status' {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            $info = Get-ScheduledTaskInfo -TaskName $TaskName
            Write-Host "[STATUS] Task '$TaskName' is INSTALLED." -ForegroundColor Green
            Write-Host "  • State:            $($task.State)"
            Write-Host "  • Last Run Time:    $($info.LastRunTime)"
            Write-Host "  • Last Result Code: $($info.LastTaskResult)"
            Write-Host "  • Next Run Time:    $($info.NextRunTime)"
        } else {
            Write-Host "[STATUS] Task '$TaskName' is NOT currently registered." -ForegroundColor DarkYellow
        }
    }
}
