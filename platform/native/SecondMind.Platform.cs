// Built with the Windows .NET Framework compiler; no runtime installation.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Text;

internal static class PlatformHelper {
    const uint KillOnClose = 0x2000;
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    static SecurityIdentifier CurrentUser { get { return WindowsIdentity.GetCurrent().User; } }
    static bool Allowed(SecurityIdentifier id) {
        return id.Equals(CurrentUser) || id.IsWellKnown(WellKnownSidType.LocalSystemSid) ||
            id.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid);
    }
    static void CheckPath(string input) {
        string full = Path.GetFullPath(input), root = Path.GetPathRoot(full), current = root;
        if (full.StartsWith("\\\\?\\", StringComparison.Ordinal) || full.StartsWith("\\\\.\\", StringComparison.Ordinal))
            throw new IOException("Device paths are not permitted.");
        // Explicit arrays bind the .NET Framework overload. Mono also exposes
        // newer Split(char, ...) overloads absent from Windows Framework.
        foreach (string part in full.Substring(root.Length).Split(new char[] { Path.DirectorySeparatorChar })) {
            if (part.Length == 0) continue;
            if (part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) || part.IndexOf(':') >= 0)
                throw new IOException("Ambiguous path component.");
            current = Path.Combine(current, part);
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Reparse points are not permitted.");
        }
    }
    static void Protect(string filename) {
        CheckPath(filename);
        bool directory = Directory.Exists(filename);
        FileSystemSecurity security = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
        security.SetOwner(CurrentUser);
        security.SetAccessRuleProtection(true, false);
        InheritanceFlags inheritance = directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
        SecurityIdentifier[] principals = { CurrentUser,
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) };
        foreach (SecurityIdentifier principal in principals)
            security.AddAccessRule(new FileSystemAccessRule(principal, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
        if (directory) Directory.SetAccessControl(filename, (DirectorySecurity)security);
        else File.SetAccessControl(filename, (FileSecurity)security);
        Verify(filename);
    }
    static void Verify(string filename) {
        CheckPath(filename);
        FileSystemSecurity security = Directory.Exists(filename)
            ? (FileSystemSecurity)Directory.GetAccessControl(filename, AccessControlSections.Access | AccessControlSections.Owner)
            : File.GetAccessControl(filename, AccessControlSections.Access | AccessControlSections.Owner);
        if (!security.GetOwner(typeof(SecurityIdentifier)).Equals(CurrentUser))
            throw new UnauthorizedAccessException("Private storage must belong to the current user.");
        bool ownerCanRead = false;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            SecurityIdentifier principal = (SecurityIdentifier)rule.IdentityReference;
            if (rule.AccessControlType == AccessControlType.Allow && !Allowed(principal))
                throw new UnauthorizedAccessException("Private storage allows access by another principal.");
            if (rule.AccessControlType == AccessControlType.Allow && principal.Equals(CurrentUser) &&
                (rule.FileSystemRights & FileSystemRights.ReadData) != 0) ownerCanRead = true;
        }
        if (!ownerCanRead) throw new UnauthorizedAccessException("Private storage has no owner access.");
    }
    static string StorageCommand(string command, string filename) {
        if (command == "protect") Protect(filename);
        else if (command == "verify") Verify(filename);
        else if (command == "check-path") CheckPath(filename);
        else if (command == "list-reparse") {
            CheckPath(filename);
            StringBuilder result = new StringBuilder();
            foreach (string entry in Directory.EnumerateFileSystemEntries(filename))
                if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0)
                    result.Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(Path.GetFileName(entry)))).Append('\n');
            return result.ToString();
        } else throw new ArgumentException("Unsupported storage command.");
        return "";
    }
    static void Serve() {
        string line;
        while ((line = Console.ReadLine()) != null) {
            string[] fields = line.Split(new char[] { '\t' });
            if (fields.Length != 3 || fields[0].Length > 64) return;
            try {
                string value = StorageCommand(fields[1], Encoding.UTF8.GetString(Convert.FromBase64String(fields[2])));
                Console.Out.WriteLine(fields[0] + "\tOK\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value)));
            } catch { Console.Out.WriteLine(fields[0] + "\tERR"); }
            Console.Out.Flush();
        }
    }
    static void Watch(int ownerId, int backendId) {
        using (Process owner = Process.GetProcessById(ownerId))
        using (Process backend = Process.GetProcessById(backendId)) {
            // Capture process handles before READY to prevent PID reuse while waiting.
            IntPtr ownerHandle = owner.Handle;
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            try {
                ExtendedLimits limits = new ExtendedLimits();
                limits.BasicLimitInformation.LimitFlags = KillOnClose;
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
                    throw new Win32Exception();
                if (!AssignProcessToJobObject(job, backend.Handle)) throw new Win32Exception();
                if (owner.HasExited || backend.HasExited) throw new IOException("Process exited before supervision started.");
                ManualResetEvent stopped = new ManualResetEvent(false);
                Thread ownerWait = new Thread(delegate() { try { owner.WaitForExit(); } finally { stopped.Set(); } });
                Thread backendWait = new Thread(delegate() { try { backend.WaitForExit(); } finally { stopped.Set(); } });
                Thread inputWait = new Thread(delegate() { try { while (Console.In.Read() != -1) {} } finally { stopped.Set(); } });
                ownerWait.IsBackground = backendWait.IsBackground = inputWait.IsBackground = true;
                ownerWait.Start(); backendWait.Start(); inputWait.Start();
                Console.Out.WriteLine("READY"); Console.Out.Flush();
                stopped.WaitOne();
            } finally { CloseHandle(job); }
        }
    }
    static int Main(string[] args) {
        try {
            if (args.Length == 1 && args[0] == "serve") Serve();
            else if (args.Length == 3 && args[0] == "watch") Watch(Int32.Parse(args[1]), Int32.Parse(args[2]));
            else if (args.Length == 2 && args[0] == "protect") Protect(args[1]);
            else if (args.Length == 2 && args[0] == "verify") Verify(args[1]);
            else if (args.Length == 2 && args[0] == "check-path") CheckPath(args[1]);
            else throw new ArgumentException("Expected protect/verify/check-path <path> or watch <ownerPid> <backendPid>.");
            return 0;
        } catch (Exception error) {
            // Paths and credentials are intentionally absent from the helper protocol.
            Console.Error.WriteLine(error.GetType().Name + ": " + (error is Win32Exception ? ((Win32Exception)error).NativeErrorCode.ToString() : "operation failed"));
            return 1;
        }
    }
}
