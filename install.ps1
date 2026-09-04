Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$InstallerArguments = @($args)
$PasswordInput = $null
$AutomationPasswordProvided = $false
$PasswordEnvironment = Get-Item Env:SECOND_MIND_ADMIN_PASSWORD -ErrorAction SilentlyContinue
if ($null -ne $PasswordEnvironment) {
    $AutomationPasswordProvided = $true
    $PasswordInput = $PasswordEnvironment.Value
    Remove-Item Env:SECOND_MIND_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    $PasswordEnvironment = $null
}

trap {
    [Console]::Error.WriteLine("Second Mind installer: " + $_.Exception.Message)
    exit 1
}

if ($null -eq ('SecondMindInstallerV2.NativePath' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace SecondMindInstallerV2
{
    [StructLayout(LayoutKind.Sequential)]
    public struct NativeFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    public static class NativePath
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        public static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        public static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle file,
            [Out] StringBuilder path,
            uint pathLength,
            uint flags);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetFileInformationByHandle(
            SafeFileHandle file,
            out NativeFileInformation information);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        public static extern uint GetFileType(SafeFileHandle file);
    }
}
'@
}

function Resolve-CanonicalDirectory([string] $Directory) {
    $resolved = (Resolve-Path -LiteralPath $Directory -ErrorAction Stop).ProviderPath
    if (-not [IO.Directory]::Exists($resolved)) {
        throw "Directory does not exist: $Directory"
    }

    # Opening the directory without FILE_FLAG_OPEN_REPARSE_POINT makes Windows
    # resolve every reparse point in the path, including ancestor junctions.
    $handle = [SecondMindInstallerV2.NativePath]::CreateFileW(
        $resolved,
        [uint32] 0,
        [uint32] 7,
        [IntPtr]::Zero,
        [uint32] 3,
        [uint32] 0x02000000,
        [IntPtr]::Zero
    )
    if ($handle.IsInvalid) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $handle.Dispose()
        throw [System.ComponentModel.Win32Exception]::new($nativeError, "Cannot canonicalize directory: $Directory")
    }

    try {
        $capacity = 512
        while ($true) {
            $buffer = [Text.StringBuilder]::new($capacity)
            $length = [SecondMindInstallerV2.NativePath]::GetFinalPathNameByHandleW(
                $handle,
                $buffer,
                [uint32] $buffer.Capacity,
                [uint32] 0
            )
            if ($length -eq 0) {
                $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                throw [System.ComponentModel.Win32Exception]::new($nativeError, "Cannot canonicalize directory: $Directory")
            }
            if ($length -lt $buffer.Capacity) {
                $canonical = $buffer.ToString()
                break
            }
            $capacity = [int] $length + 1
        }
    } finally {
        $handle.Dispose()
    }

    if ($canonical.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
        $canonical = '\\' + $canonical.Substring(8)
    } elseif ($canonical.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
        $canonical = $canonical.Substring(4)
    }
    $canonical = [IO.Path]::GetFullPath($canonical).Replace('/', '\')
    $root = [IO.Path]::GetPathRoot($canonical)
    if ($canonical.Length -gt $root.Length) {
        $canonical = $canonical.TrimEnd('\')
    }
    return $canonical
}

function Test-PathContains([string] $Parent, [string] $Candidate) {
    if ([string]::Equals($Parent, $Candidate, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    $prefix = if ($Parent.EndsWith('\')) { $Parent } else { $Parent + '\' }
    return $Candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Test-HostPathsAreSeparate {
    $knowledgeReal = Resolve-CanonicalDirectory $KnowledgeBase
    $stateReal = Resolve-CanonicalDirectory $StateRoot
    $knowledgeRoot = [IO.Path]::GetPathRoot($knowledgeReal)
    if ([string]::Equals($knowledgeReal, $knowledgeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A filesystem root cannot be used as the knowledge-base path.'
    }
    if ((Test-PathContains $knowledgeReal $stateReal) -or (Test-PathContains $stateReal $knowledgeReal)) {
        throw 'Knowledge-base and installer state paths must not contain one another after resolving links.'
    }
}

function Test-KnowledgeBaseAccess {
    Test-HostPathsAreSeparate
    Write-Note 'Checking knowledge-base access from Docker...'
    Invoke-Docker @(
        'run', '--rm',
        '--user', "${RuntimeUid}:$RuntimeGid",
        '--mount', "type=bind,source=$RepoRoot,target=/workspace,readonly",
        '--mount', "type=bind,source=$KnowledgeBase,target=/probe",
        $InstallerImage,
        'node', '/workspace/scripts/install.mjs', 'internal-probe-vault', '--source', '/probe'
    )
}

function Write-Note([string] $Message) {
    Write-Host $Message
}

function Read-Value([string] $Filename) {
    if (-not [IO.File]::Exists($Filename)) {
        throw "Missing installer operation file: $Filename"
    }
    return [IO.File]::ReadAllText($Filename).TrimEnd("`r", "`n")
}

function Invoke-Docker([string[]] $DockerArgs, [switch] $Quiet) {
    if ($Quiet) {
        & docker @DockerArgs *> $null
    } else {
        & docker @DockerArgs
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed with exit code $LASTEXITCODE."
    }
}

function Test-DockerCommand([string[]] $DockerArgs) {
    & docker @DockerArgs *> $null
    return $LASTEXITCODE -eq 0
}

function Get-DockerText([string[]] $DockerArgs) {
    $commandOutput = & docker @DockerArgs 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed with exit code $LASTEXITCODE."
    }
    return (($commandOutput | Out-String).Trim())
}

function Protect-StateDirectory([string] $Directory) {
    $directoryAcl = Get-Acl -LiteralPath $Directory
    $directoryAcl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($directoryAcl.Access)) {
        [void] $directoryAcl.RemoveAccessRuleSpecific($existingRule)
    }
    $identities = @(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    )
    foreach ($identity in $identities) {
        $accessRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $identity,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        [void] $directoryAcl.AddAccessRule($accessRule)
    }
    Set-Acl -LiteralPath $Directory -AclObject $directoryAcl
}

function Get-NativeFileInformation([Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle) {
    $information = New-Object SecondMindInstallerV2.NativeFileInformation
    if (-not [SecondMindInstallerV2.NativePath]::GetFileInformationByHandle(
        $Handle,
        [ref] $information
    )) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw [System.ComponentModel.Win32Exception]::new($nativeError, 'Cannot inspect installer state marker')
    }
    return $information
}

function Assert-NativeStateMarkerFile(
    [Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle,
    $Information
) {
    $diskFileType = [uint32] 1
    $directoryAttribute = [uint32] 0x10
    $reparseAttribute = [uint32] 0x400
    if ([SecondMindInstallerV2.NativePath]::GetFileType($Handle) -ne $diskFileType -or
        ($Information.FileAttributes -band $directoryAttribute) -ne 0 -or
        ($Information.FileAttributes -band $reparseAttribute) -ne 0 -or
        $Information.NumberOfLinks -ne 1) {
        throw 'Installer state marker must be a regular, non-reparse file with one hard link.'
    }
    $fileSize = ([uint64] $Information.FileSizeHigh * [uint64] 4294967296) +
        [uint64] $Information.FileSizeLow
    $expectedSize = [uint64] [Text.Encoding]::UTF8.GetByteCount("second-mind-installer-state-v1`n")
    if ($fileSize -ne $expectedSize) {
        throw 'Installer state marker is invalid.'
    }
}

function Test-NativeFileIdentity($Left, $Right) {
    return $Left.VolumeSerialNumber -eq $Right.VolumeSerialNumber -and
        $Left.FileIndexHigh -eq $Right.FileIndexHigh -and
        $Left.FileIndexLow -eq $Right.FileIndexLow
}

function Open-NativeStateMarker([string] $Marker, [switch] $AllowMissing) {
    $handle = [SecondMindInstallerV2.NativePath]::CreateFileW(
        $Marker,
        [uint32] 2147483648,
        [uint32] 1,
        [IntPtr]::Zero,
        [uint32] 3,
        [uint32] 0x00200000,
        [IntPtr]::Zero
    )
    if ($handle.IsInvalid) {
        $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $handle.Dispose()
        if ($AllowMissing -and $nativeError -in @(2, 3)) { return $null }
        throw [System.ComponentModel.Win32Exception]::new($nativeError, 'Cannot open installer state marker safely')
    }
    return $handle
}

function Read-ValidatedStateMarker([string] $Marker) {
    $expectedHandle = Open-NativeStateMarker $Marker -AllowMissing
    if ($null -eq $expectedHandle) { return $null }
    try {
        $expected = Get-NativeFileInformation $expectedHandle
        Assert-NativeStateMarkerFile $expectedHandle $expected
        $handle = Open-NativeStateMarker $Marker
        $stream = $null
        $reader = $null
        try {
            $opened = Get-NativeFileInformation $handle
            Assert-NativeStateMarkerFile $handle $opened
            if (-not (Test-NativeFileIdentity $expected $opened)) {
                throw 'Installer state marker changed while it was being opened.'
            }
            $stream = [IO.FileStream]::new($handle, [IO.FileAccess]::Read)
            $reader = [IO.StreamReader]::new(
                $stream,
                [Text.UTF8Encoding]::new($false, $true),
                $true,
                1024,
                $true
            )
            $value = $reader.ReadToEnd()
            $openedAfterRead = Get-NativeFileInformation $handle
            Assert-NativeStateMarkerFile $handle $openedAfterRead
            if (-not (Test-NativeFileIdentity $expected $openedAfterRead)) {
                throw 'Installer state marker changed while it was being read.'
            }

            $linkedHandle = Open-NativeStateMarker $Marker
            try {
                $linkedAfterRead = Get-NativeFileInformation $linkedHandle
                Assert-NativeStateMarkerFile $linkedHandle $linkedAfterRead
                if (-not (Test-NativeFileIdentity $expected $linkedAfterRead)) {
                    throw 'Installer state marker changed while it was being read.'
                }
            } finally {
                $linkedHandle.Dispose()
            }
            if ($value -ne "second-mind-installer-state-v1`n") {
                throw 'Installer state marker is invalid.'
            }
            return $value
        } finally {
            if ($null -ne $reader) { $reader.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
            $handle.Dispose()
        }
    } finally {
        $expectedHandle.Dispose()
    }
}

function Assert-DedicatedStateDirectory(
    [string] $Directory,
    [string] $Repository,
    [string] $UserHome
) {
    $canonicalDirectory = Resolve-CanonicalDirectory $Directory
    $canonicalRepository = Resolve-CanonicalDirectory $Repository
    $filesystemRoot = [IO.Path]::GetPathRoot($canonicalDirectory)
    if ([string]::Equals($canonicalDirectory, $filesystemRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Test-PathContains $canonicalRepository $canonicalDirectory) -or
        (Test-PathContains $canonicalDirectory $canonicalRepository)) {
        throw 'Installer state must be a dedicated directory outside the repository and filesystem root.'
    }
    if (-not [string]::IsNullOrWhiteSpace($UserHome)) {
        $canonicalHome = Resolve-CanonicalDirectory $UserHome
        if ([string]::Equals($canonicalDirectory, $canonicalHome, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Installer state must not use the user profile root.'
        }
    }
    $marker = Join-Path $canonicalDirectory '.second-mind-installer-state'
    $entries = @(Get-ChildItem -LiteralPath $canonicalDirectory -Force)
    $markerValue = Read-ValidatedStateMarker $marker
    if ($null -ne $markerValue) {
        # Read-ValidatedStateMarker already checked the exact contents through
        # the same no-reparse handle whose identity was compared with the path.
    } elseif ($entries.Count -ne 0) {
        throw 'Installer state must be empty before first use.'
    }
}

$RepoRoot = Resolve-CanonicalDirectory $PSScriptRoot
if (-not [string]::IsNullOrWhiteSpace($env:SECOND_MIND_CONFIG_HOME)) {
    $StateRoot = [IO.Path]::GetFullPath($env:SECOND_MIND_CONFIG_HOME)
} elseif (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $StateRoot = Join-Path $env:LOCALAPPDATA 'Second Mind'
} else {
    $StateRoot = Join-Path $HOME 'AppData\Local\Second Mind'
}
[IO.Directory]::CreateDirectory($StateRoot) | Out-Null
$StateRoot = Resolve-CanonicalDirectory $StateRoot
Assert-DedicatedStateDirectory $StateRoot $RepoRoot $HOME

$InstallerImage = if ([string]::IsNullOrWhiteSpace($env:SECOND_MIND_INSTALLER_IMAGE)) {
    'node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5'
} else {
    $env:SECOND_MIND_INSTALLER_IMAGE
}
$RuntimeUid = '1000'
$RuntimeGid = '1000'

$CommandName = 'init'
if ($InstallerArguments.Count -gt 0 -and -not $InstallerArguments[0].StartsWith('--')) {
    $CommandName = $InstallerArguments[0]
}
if ($CommandName -notin @('init', 'doctor', 'status', 'logs', 'update', 'backup')) {
    throw "Unsupported command: $CommandName"
}
$InstallerOptions = @($InstallerArguments)
if ($InstallerArguments.Count -gt 0 -and -not $InstallerArguments[0].StartsWith('--')) {
    if ($InstallerArguments.Count -gt 1) {
        $InstallerOptions = @($InstallerArguments[1..($InstallerArguments.Count - 1)])
    } else {
        $InstallerOptions = @()
    }
}

if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is not installed or is not on PATH.'
}
if (-not (Test-DockerCommand @('version'))) {
    throw 'Docker Engine is not reachable. Start Docker Desktop.'
}
if (-not (Test-DockerCommand @('compose', 'version'))) {
    throw 'Docker Compose v2 (docker compose) is required.'
}

$TerminalArguments = @('-i')
$CanUseTerminal = $false
try {
    $CanUseTerminal = -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
} catch {
    $CanUseTerminal = $false
}
if ($CommandName -eq 'init' -and $InstallerOptions -notcontains '--non-interactive' -and $CanUseTerminal) {
    $TerminalArguments = @('-it')
}

$InstallerContextArguments = @(
    '--repo-root', '/workspace',
    '--state-root', '/state',
    '--host-os', 'win32',
    '--host-repo-root', $RepoRoot,
    '--host-state-root', $StateRoot,
    '--runtime-uid', $RuntimeUid,
    '--runtime-gid', $RuntimeGid
)
if (-not [string]::IsNullOrWhiteSpace($HOME)) {
    $InstallerContextArguments += @('--host-home', $HOME)
}

function Invoke-InstallerPreflight {
    $preflightDockerArgs = @(
        'run', '--rm',
        '--user', "${RuntimeUid}:$RuntimeGid",
        '--mount', "type=bind,source=$RepoRoot,target=/workspace,readonly",
        '--mount', "type=bind,source=$StateRoot,target=/state,readonly",
        $InstallerImage,
        'node', '/workspace/scripts/install.mjs', 'internal-preflight'
    ) + $InstallerOptions + @('--operation', $CommandName) + $InstallerContextArguments
    return (Get-DockerText $preflightDockerArgs)
}

$PreflightResult = Invoke-InstallerPreflight
if ($PreflightResult -eq 'VAULT_REQUIRED') {
    if ($InstallerOptions -contains '--non-interactive') {
        throw 'A new non-interactive installation requires --vault PATH.'
    }
    if (-not $CanUseTerminal) {
        throw 'A new installation requires a terminal for the Vault prompt, or use --vault PATH.'
    }
    $VaultInput = Read-Host 'Vault or knowledge-base parent path'
    $InstallerOptions += @('--vault', $VaultInput)
    $PreflightResult = Invoke-InstallerPreflight
}
if (-not $PreflightResult.StartsWith('VAULT_PATH=', [StringComparison]::Ordinal)) {
    throw 'Installer preflight returned an invalid response.'
}
$KnowledgeBase = $PreflightResult.Substring(11)
if ([string]::IsNullOrWhiteSpace($KnowledgeBase)) {
    throw 'Installer preflight returned an empty knowledge-base path.'
}
if ($CommandName -eq 'init') {
    Test-KnowledgeBaseAccess
} else {
    Test-HostPathsAreSeparate
}
Protect-StateDirectory $StateRoot

$ForwardedInstallerArguments = @($CommandName) + $InstallerOptions + @('--expected-vault', $KnowledgeBase)
$PasswordThroughStdin = $false
if ($CommandName -eq 'init' -and
    $InstallerOptions -contains '--non-interactive' -and
    $AutomationPasswordProvided) {
    $PasswordThroughStdin = $true
    $ForwardedInstallerArguments += '--admin-password-stdin'
}
$InstallerDockerArgs = @('run', '--rm') + $TerminalArguments + @(
    '--mount', "type=bind,source=$RepoRoot,target=/workspace,readonly",
    '--mount', "type=bind,source=$StateRoot,target=/state"
) + @(
    $InstallerImage,
    'node', '/workspace/scripts/install.mjs'
) + $ForwardedInstallerArguments + $InstallerContextArguments
if ($PasswordThroughStdin) {
    $PasswordInput | & docker @InstallerDockerArgs
    $PasswordInput = $null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed with exit code $LASTEXITCODE."
    }
} else {
    Invoke-Docker $InstallerDockerArgs
}

$InstanceId = Read-Value (Join-Path $StateRoot 'current')
if ($InstanceId -notmatch '^second-mind-[a-z0-9][a-z0-9-]{5,48}[a-z0-9]$') {
    throw 'Installer returned an invalid instance identifier.'
}
$InstanceRoot = Join-Path $StateRoot $InstanceId
$OperationRoot = Join-Path $InstanceRoot 'operation'
$Project = Read-Value (Join-Path $OperationRoot 'project')
$Volume = Read-Value (Join-Path $OperationRoot 'volume')
$Port = Read-Value (Join-Path $OperationRoot 'port')
$ConfiguredKnowledgeBase = Read-Value (Join-Path $OperationRoot 'vault')
if (-not [string]::Equals($ConfiguredKnowledgeBase, $KnowledgeBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer state changed after the read-only preflight.'
}
$KnowledgeBase = $ConfiguredKnowledgeBase
$RuntimeUid = Read-Value (Join-Path $OperationRoot 'runtimeUid')
$RuntimeGid = Read-Value (Join-Path $OperationRoot 'runtimeGid')

$ComposePrefix = @(
    'compose',
    '--project-name', $Project,
    '--env-file', (Join-Path $InstanceRoot '.env'),
    '-f', (Join-Path $RepoRoot 'compose.yaml'),
    '-f', (Join-Path $RepoRoot 'compose.secrets.yaml'),
    '-f', (Join-Path $InstanceRoot 'compose.instance.yaml')
)

function Invoke-Compose([string[]] $ComposeArgs, [switch] $Quiet) {
    Invoke-Docker (@($ComposePrefix) + $ComposeArgs) -Quiet:$Quiet
}

function Test-ComposeCommand([string[]] $ComposeArgs) {
    return (Test-DockerCommand (@($ComposePrefix) + $ComposeArgs))
}

function Get-ComposeText([string[]] $ComposeArgs) {
    return (Get-DockerText (@($ComposePrefix) + $ComposeArgs))
}

function Test-ComposeRunning {
    $containerId = Get-ComposeText @('ps', '--status', 'running', '-q', 'app')
    return -not [string]::IsNullOrWhiteSpace($containerId)
}

function Test-ComposeOwnsPort {
    if (-not (Test-ComposeRunning)) { return $false }
    try {
        $binding = Get-ComposeText @('port', 'app', '8787')
        return $binding -match (':' + [regex]::Escape($Port) + '$')
    } catch {
        return $false
    }
}

function Test-ComposeConfiguration {
    Invoke-Compose @('config', '--quiet')
}

function Test-PortAvailable {
    if (Test-ComposeOwnsPort) {
        Write-Note "Port $Port is already owned by this running Second Mind instance."
        return $true
    }
    Write-Note "Checking whether 127.0.0.1:$Port is available..."
    $available = Test-DockerCommand @(
        'run', '--rm',
        '--publish', "127.0.0.1:${Port}:8787",
        $InstallerImage,
        'node', '-e', 'setTimeout(() => {}, 250)'
    )
    return $available
}

function Initialize-RuntimeVolume {
    Invoke-Docker @('volume', 'create', $Volume) -Quiet
    Invoke-Docker @(
        'run', '--rm',
        '--mount', "type=bind,source=$RepoRoot,target=/workspace,readonly",
        '--mount', "type=volume,source=$Volume,target=/runtime-data",
        $InstallerImage,
        'node', '/workspace/scripts/install.mjs', 'internal-own-tree',
        '--source', '/runtime-data', '--output-uid', $RuntimeUid, '--output-gid', $RuntimeGid
    ) -Quiet
}

function Initialize-ApplicationImage {
    $configuredImage = ((Get-ComposeText @('config', '--images')) -split '\r?\n')[0]
    if ($configuredImage.EndsWith(':local')) {
        Invoke-Compose @('build', '--pull', 'app')
        return
    }
    if (-not (Test-ComposeCommand @('pull', 'app'))) {
        Write-Note 'No pullable application image was available; rebuilding from the checked-out source.'
        Invoke-Compose @('build', '--pull', 'app')
    }
}

function Test-RuntimeVolume {
    if (-not (Test-DockerCommand @('volume', 'inspect', $Volume))) {
        return $false
    }
    $writable = Test-DockerCommand @(
        'run', '--rm',
        '--user', "${RuntimeUid}:$RuntimeGid",
        '--mount', "type=bind,source=$RepoRoot,target=/workspace,readonly",
        '--mount', "type=volume,source=$Volume,target=/probe",
        $InstallerImage,
        'node', '/workspace/scripts/install.mjs', 'internal-probe-path', '--source', '/probe'
    )
    return $writable
}

$HealthScript = "Promise.all(['/health/live','/health/ready'].map(async p=>{const r=await fetch('http://127.0.0.1:8787'+p,{signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error(p+' returned '+r.status)})).catch(e=>{console.error(e.message);process.exit(1)})"
$PdfScript = "const fs=require('node:fs');const required=['/usr/bin/bwrap','/usr/bin/pdftotext'];const missing=required.filter(p=>{try{fs.accessSync(p,fs.constants.X_OK);return false}catch{return true}});const enabled=/^(1|true|yes|on)$/i.test(process.env.PDF_ENABLED||'');console.log('PDF sandbox: '+(missing.length?'unavailable ('+missing.join(', ')+')':'available')+(enabled?' [enabled]':' [disabled]'));if(enabled&&missing.length)process.exit(1)"

function Test-AppHealth {
    return (Test-ComposeCommand @('exec', '-T', 'app', 'node', '-e', $HealthScript))
}

function Show-PdfRuntime {
    Invoke-Compose @('exec', '-T', 'app', 'node', '-e', $PdfScript)
}

function Wait-UntilReady {
    Write-Note 'Waiting for Second Mind readiness...'
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-AppHealth) {
            Write-Note "Second Mind is ready at http://127.0.0.1:$Port"
            return
        }
        Start-Sleep -Seconds 2
    }
    Invoke-Compose @('ps')
    throw 'The app did not become ready within two minutes. Run .\install.ps1 logs --no-follow for details.'
}

function Invoke-Doctor {
    $failures = 0
    Write-Note 'Docker CLI and Engine versions:'
    try {
        Invoke-Docker @('version', '--format', '  client={{.Client.Version}} server={{.Server.Version}}')
    } catch {
        Write-Warning $_.Exception.Message
        $failures += 1
    }
    Write-Note 'Docker Compose version:'
    try { Invoke-Docker @('compose', 'version') } catch { Write-Warning $_.Exception.Message; $failures += 1 }
    Write-Note 'Docker Engine:'
    try {
        Invoke-Docker @('info', '--format', '  version={{.ServerVersion}} os={{.OSType}} arch={{.Architecture}} cpus={{.NCPU}} memory={{.MemTotal}}')
        if ((Get-DockerText @('info', '--format', '{{.OSType}}')) -ne 'linux') {
            Write-Warning 'Docker Desktop must be switched to Linux containers.'
            $failures += 1
        }
    } catch {
        Write-Warning $_.Exception.Message
        $failures += 1
    }
    try { Test-ComposeConfiguration } catch { Write-Warning $_.Exception.Message; $failures += 1 }
    try { Test-KnowledgeBaseAccess } catch { Write-Warning $_.Exception.Message; $failures += 1 }
    if (-not (Test-RuntimeVolume)) {
        Write-Warning "Runtime volume $Volume is missing or is not writable by UID:GID ${RuntimeUid}:$RuntimeGid."
        $failures += 1
    }
    if (-not (Test-PortAvailable)) {
        Write-Warning "Port $Port is unavailable; no existing process was stopped."
        $failures += 1
    }
    Write-Note 'Docker disk usage:'
    try { Invoke-Docker @('system', 'df') } catch { Write-Warning $_.Exception.Message; $failures += 1 }
    if (Test-ComposeRunning) {
        if (-not (Test-AppHealth)) {
            Write-Warning 'The live or ready health endpoint failed.'
            $failures += 1
        }
        try { Show-PdfRuntime } catch { Write-Warning $_.Exception.Message; $failures += 1 }
    } else {
        Write-Note 'App health/PDF checks skipped because this instance is not running.'
    }
    if ($failures -ne 0) {
        throw "Doctor found $failures problem(s)."
    }
    Write-Note 'Doctor checks passed.'
}

function Copy-BackupComponent([string] $SourceMount, [string] $Destination) {
    Invoke-Docker @(
        'run', '--rm',
        '--mount', "type=bind,source=$RepoRoot,target=/workspace,readonly",
        '--mount', $SourceMount,
        '--mount', "type=bind,source=$BackupPath,target=/backup",
        $InstallerImage,
        'node', '/workspace/scripts/install.mjs', 'internal-copy-tree',
        '--source', '/source', '--destination', "/backup/$Destination",
        '--output-uid', $RuntimeUid, '--output-gid', $RuntimeGid
    ) -Quiet
}

switch ($CommandName) {
    'init' {
        Test-ComposeConfiguration
        if (-not (Test-PortAvailable)) {
            throw "Port $Port is unavailable; no existing process was stopped. Choose another with: .\install.ps1 init --port PORT"
        }
        Initialize-RuntimeVolume
        Initialize-ApplicationImage
        Invoke-Compose @('up', '-d', '--no-build', '--remove-orphans')
        Wait-UntilReady
    }
    'doctor' {
        Invoke-Doctor
    }
    'status' {
        Test-ComposeConfiguration
        Invoke-Compose @('ps')
        if (Test-ComposeRunning) {
            if (-not (Test-AppHealth)) { throw 'The live or ready health endpoint failed.' }
            Show-PdfRuntime
        }
    }
    'logs' {
        $TailCount = Read-Value (Join-Path $OperationRoot 'tail')
        $Follow = Read-Value (Join-Path $OperationRoot 'follow')
        $LogArgs = @('logs', '--tail', $TailCount)
        if ($Follow -eq 'true') { $LogArgs += '--follow' }
        Invoke-Compose $LogArgs
    }
    'update' {
        Test-ComposeConfiguration
        Test-KnowledgeBaseAccess
        if (-not (Test-PortAvailable)) {
            throw "Port $Port is unavailable; no existing process was stopped. Choose another with: .\install.ps1 init --port PORT"
        }
        Initialize-RuntimeVolume
        Initialize-ApplicationImage
        Invoke-Compose @('up', '-d', '--no-build', '--remove-orphans')
        Wait-UntilReady
    }
    'backup' {
        $BackupPath = Read-Value (Join-Path $OperationRoot 'backup')
        $BackupName = Read-Value (Join-Path $OperationRoot 'backupName')
        if ($BackupName -notmatch '^[0-9TZ-]+-[a-f0-9]{6}$') {
            throw 'Installer returned an invalid backup identifier.'
        }
        Test-HostPathsAreSeparate
        if (-not (Test-DockerCommand @('volume', 'inspect', $Volume))) {
            throw "Runtime volume $Volume does not exist."
        }
        Write-Note 'Creating a live backup. Pause external Vault sync first if a point-in-time snapshot is required.'
        Copy-BackupComponent "type=volume,source=$Volume,target=/source,readonly" 'data'
        Copy-BackupComponent "type=bind,source=$KnowledgeBase,target=/source,readonly" 'vault'
        Invoke-Docker @(
            'run', '--rm',
            '--mount', "type=bind,source=$RepoRoot,target=/workspace,readonly",
            '--mount', "type=bind,source=$StateRoot,target=/state",
            $InstallerImage,
            'node', '/workspace/scripts/install.mjs', 'internal-finalize-backup',
            '--backup-root', "/state/$InstanceId/backups/$BackupName"
        ) -Quiet
        Write-Note "Backup complete: $BackupPath"
    }
}
