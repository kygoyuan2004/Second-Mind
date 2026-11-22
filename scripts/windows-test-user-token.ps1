# Run this script with a dedicated powershell.exe/pwsh -File process. It changes
# only that process token, then launches Node with the inherited token. Account
# privileges, local policy, the SSH service, and other processes are unchanged.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$NodeArgumentsJson = '["scripts/run-tests.mjs"]'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This test launcher requires Windows.'
}
$resolvedNode = (Resolve-Path -LiteralPath $NodePath).ProviderPath
$resolvedProject = (Resolve-Path -LiteralPath $ProjectRoot).ProviderPath
if (!(Test-Path -LiteralPath $resolvedNode -PathType Leaf)) { throw 'NodePath must be a file.' }
if (!(Test-Path -LiteralPath $resolvedProject -PathType Container)) { throw 'ProjectRoot must be a directory.' }
if (!$NodeArgumentsJson.TrimStart().StartsWith('[')) { throw 'NodeArgumentsJson must be a JSON array.' }
$parsedArguments = ConvertFrom-Json -InputObject $NodeArgumentsJson
if (!($parsedArguments -is [Array]) -and !($parsedArguments -is [string])) {
    throw 'NodeArgumentsJson must be a nonempty JSON array of strings.'
}
# Windows PowerShell unwraps a JSON array containing one item.
$nodeArguments = @($parsedArguments)
if (!$nodeArguments.Count) { throw 'At least one Node argument is required.' }
foreach ($argument in $nodeArguments) {
    if (!($argument -is [string]) -or $argument.Contains([char]0)) {
        throw 'Node arguments must be strings without NUL characters.'
    }
}

$tokenTemporaryRoot = Join-Path $resolvedProject ('build/test-token-' + [Guid]::NewGuid().ToString('N'))
$tokenPreviousTemp = $env:TEMP
$tokenPreviousTmp = $env:TMP
New-Item -ItemType Directory -Path $tokenTemporaryRoot -Force | Out-Null
$env:TEMP = $tokenTemporaryRoot
$env:TMP = $tokenTemporaryRoot
$testExitCode = 1
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SecondMindTestProcessToken {
    const uint TOKEN_QUERY = 0x0008;
    const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
    const uint SE_PRIVILEGE_ENABLED = 0x00000002;
    const uint PRIVILEGE_SET_ALL_NECESSARY = 1;
    const int ERROR_NOT_ALL_ASSIGNED = 1300;

    [StructLayout(LayoutKind.Sequential)]
    struct Luid { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)]
    struct LuidAndAttributes { public Luid Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct TokenPrivileges { public uint Count; public LuidAndAttributes Privilege; }
    [StructLayout(LayoutKind.Sequential)]
    struct PrivilegeSet { public uint Count; public uint Control; public LuidAndAttributes Privilege; }

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool LookupPrivilegeValue(string systemName, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool AdjustTokenPrivileges(IntPtr token, [MarshalAs(UnmanagedType.Bool)] bool disableAll,
        ref TokenPrivileges privileges, uint bufferLength, IntPtr previousState, IntPtr returnLength);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool PrivilegeCheck(IntPtr token, ref PrivilegeSet privileges,
        [MarshalAs(UnmanagedType.Bool)] out bool enabled);

    static bool IsEnabled(IntPtr token, Luid luid) {
        PrivilegeSet request = new PrivilegeSet();
        request.Count = 1;
        request.Control = PRIVILEGE_SET_ALL_NECESSARY;
        request.Privilege.Luid = luid;
        request.Privilege.Attributes = SE_PRIVILEGE_ENABLED;
        bool enabled;
        if (!PrivilegeCheck(token, ref request, out enabled)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return enabled;
    }

    public static string Disable(string name) {
        if (name != "SeBackupPrivilege" && name != "SeRestorePrivilege")
            throw new ArgumentException("Only the two filesystem bypass privileges may be changed.");
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, out token))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            Luid luid;
            if (!LookupPrivilegeValue(null, name, out luid)) throw new Win32Exception(Marshal.GetLastWin32Error());
            bool before = IsEnabled(token, luid);
            TokenPrivileges request = new TokenPrivileges();
            request.Count = 1;
            request.Privilege.Luid = luid;
            request.Privilege.Attributes = 0;
            bool adjusted = AdjustTokenPrivileges(token, false, ref request, 0, IntPtr.Zero, IntPtr.Zero);
            int error = Marshal.GetLastWin32Error();
            if (!adjusted || (error != 0 && error != ERROR_NOT_ALL_ASSIGNED)) throw new Win32Exception(error);
            if (IsEnabled(token, luid)) throw new InvalidOperationException(name + " is still enabled.");
            return name + ":" + (before ? "enabled" : "disabled-or-unavailable") + "->disabled-or-unavailable";
        } finally { CloseHandle(token); }
    }
}
'@

$privileges = @(
    [SecondMindTestProcessToken]::Disable('SeBackupPrivilege')
    [SecondMindTestProcessToken]::Disable('SeRestorePrivilege')
)
@{
    check = 'test-process-filesystem-privileges'
    processId = $PID
    scope = 'this launcher and its Node child processes only'
    privileges = $privileges
} | ConvertTo-Json -Compress | Write-Output

Set-Location -LiteralPath $resolvedProject
# The call operator passes the array as arguments without constructing shell code.
# A newly created child inherits the current primary token's disabled privileges.
& $resolvedNode @nodeArguments
$testExitCode = $LASTEXITCODE
} finally {
    $env:TEMP = $tokenPreviousTemp
    $env:TMP = $tokenPreviousTmp
    Remove-Item -LiteralPath $tokenTemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
exit $testExitCode
