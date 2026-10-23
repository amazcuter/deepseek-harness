param([string]$Script, [string]$Plan, [string]$Case)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$spec = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
$global:mwfNetworkRules = @()
$global:mwfNetworkCreated = 0
$global:mwfNetworkRemoved = 0
function Get-NetFirewallRule { param($PolicyStore) return $global:mwfNetworkRules }
function Get-NetFirewallApplicationFilter {
    param([Parameter(ValueFromPipeline = $true)]$InputObject)
    process { return [pscustomobject]@{ Program = $InputObject.Program } }
}
function New-NetFirewallRule {
    param($Name, $DisplayName, $Description, $Direction, $Program, $Action, $Profile, $Enabled, $PolicyStore)
    $global:mwfNetworkCreated++
    if ($Case -eq 'creation-failure') { throw 'inert creation failure' }
    $global:mwfNetworkRules = @([pscustomobject]@{ Name = $Name; Description = $Description; Direction = $Direction;
        Program = $Program; Action = $Action; Enabled = $Enabled; Profile = $Profile; PolicyStore = $PolicyStore })
    return $global:mwfNetworkRules
}
function Remove-NetFirewallRule {
    param([Parameter(ValueFromPipeline = $true)]$InputObject)
    process {
        $global:mwfNetworkRemoved++
        if ($Case -ne 'restore-failure') { $global:mwfNetworkRules = @() }
    }
}
function Read-Host {
    param($Prompt)
    if ($Case -in @('declined', 'restore-declined')) { return 'NO' }
    if ($Case -eq 'changed-during-confirmation') { [IO.File]::WriteAllText($spec.executable, 'changed during confirmation') }
    if ($Prompt -like 'Type RESTORE*') { return "RESTORE $($spec.runId)" }
    return "BLOCK $($spec.runId)"
}
if ($Case -in @('existing', 'foreign', 'restore', 'restore-failure', 'restore-declined', 'status')) {
    $global:mwfNetworkRules = @([pscustomobject]@{ Name = $spec.ruleName; Direction = 'Outbound'; Action = 'Block';
        Program = $spec.executable; Enabled = 'True'; Description = "mwf-update-qualification:$($spec.runId):$($spec.sha512Hex)" })
    if ($Case -eq 'foreign') { $global:mwfNetworkRules[0].Program = 'C:\not-the-test-application.exe' }
}
$action = if ($Case -like 'restore*') { 'Restore' } elseif ($Case -eq 'status') { 'Status' } else { 'Block' }
$failure = $null
try { & $Script -Plan $Plan -Action $action } catch { $failure = $_.Exception.Message }
@{ failure = $failure; created = $global:mwfNetworkCreated; removed = $global:mwfNetworkRemoved;
    remaining = $global:mwfNetworkRules.Count } | ConvertTo-Json -Compress
