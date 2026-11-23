// Starts one hidden child process inside its own Windows job object, with stdout and stderr appended
// to a log file. Killing the job kills the whole tree, including grandchildren started later, and the
// job is created with KILL_ON_JOB_CLOSE, so if the CI runner itself dies every step process dies too.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class CiProcess : IDisposable
{
    const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000;
    const uint GENERIC_WRITE = 0x40000000, GENERIC_READ = 0x80000000, FILE_APPEND_DATA = 0x4;
    const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_ALWAYS = 4, OPEN_EXISTING = 3;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int len, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, byte[] env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);

    [DllImport("advapi32.dll")] static extern bool IsTokenRestricted(IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

    /// True when this process runs under a restricted token (an agent sandbox), where Chromium's
    /// renderer sandbox cannot start.
    public static bool CurrentTokenRestricted()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x8 /* TOKEN_QUERY */, out token)) return false;
        try { return IsTokenRestricted(token); } finally { CloseHandle(token); }
    }

    IntPtr job, process;
    public int Pid { get; private set; }

    public static CiProcess Start(string commandLine, string cwd, string logPath, IDictionary overrides)
    {
        var self = new CiProcess();
        self.job = CreateJobObject(IntPtr.Zero, null);
        if (self.job == IntPtr.Zero) throw new Win32Exception();
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(self.job, 9, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception();

        // Handles are inheritable only for the moment of CreateProcess; the runner is single-threaded,
        // so a parallel step never inherits another step's log handle.
        var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
        IntPtr log = CreateFile(logPath, FILE_APPEND_DATA | GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref sa, OPEN_ALWAYS, 0, IntPtr.Zero);
        if (log == new IntPtr(-1)) throw new Win32Exception();
        IntPtr nul = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref sa, OPEN_EXISTING, 0, IntPtr.Zero);
        try {
            var si = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = STARTF_USESTDHANDLES, hStdInput = nul, hStdOutput = log, hStdError = log };
            PROCESS_INFORMATION pi;
            if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, EnvBlock(overrides), cwd, ref si, out pi))
                throw new Win32Exception();
            // Assigned while suspended, so not even the first grandchild can start outside the job.
            if (!AssignProcessToJobObject(self.job, pi.hProcess)) {
                int err = Marshal.GetLastWin32Error();
                TerminateJobObject(self.job, 1); CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
                throw new Win32Exception(err);
            }
            ResumeThread(pi.hThread); CloseHandle(pi.hThread);
            self.process = pi.hProcess; self.Pid = pi.dwProcessId;
            return self;
        } finally { CloseHandle(log); CloseHandle(nul); }
    }

    static byte[] EnvBlock(IDictionary overrides)
    {
        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry e in Environment.GetEnvironmentVariables()) env[(string)e.Key] = (string)e.Value;
        if (overrides != null) foreach (DictionaryEntry e in overrides) {
            if (e.Value == null) env.Remove((string)e.Key); else env[(string)e.Key] = e.Value.ToString();
        }
        var sb = new StringBuilder();
        foreach (var kv in env) sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        sb.Append('\0');
        return Encoding.Unicode.GetBytes(sb.ToString());
    }

    public bool HasExited { get { return WaitForSingleObject(process, 0) == 0; } }
    public int ExitCode { get { uint c; GetExitCodeProcess(process, out c); return unchecked((int)c); } }
    public int ActiveProcesses {
        get { JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a; return QueryInformationJobObject(job, 1, out a, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero) ? (int)a.ActiveProcesses : -1; }
    }
    /// Kills every process in the tree and waits until they are gone (bounded).
    public void KillTree(uint exitCode)
    {
        TerminateJobObject(job, exitCode);
        for (int i = 0; i < 50 && ActiveProcesses > 0; i++) System.Threading.Thread.Sleep(100);
    }
    public void Dispose()
    {
        if (job != IntPtr.Zero) { TerminateJobObject(job, 1); CloseHandle(job); job = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
    }
}
