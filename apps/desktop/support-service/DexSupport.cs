// Dexterity Connect IT Support service (docs/HELP-DESK.md, "Elevated control").
//
// Runs as a Windows service (LocalSystem) on an office PC, installed by an administrator. It connects
// to the office hub as a machine device (its own P-256 key in the machine's key store) and, when
// someone on the IT desk connects with the office's policy on, shows them the PC's console - the
// person's desktop, administrator windows, UAC prompts, the lock and sign-in screens - and passes
// their pointer and keys to it. Ctrl+Alt+Del is the real secure attention sequence (SendSAS).
//
// The service lives in session 0 and cannot see the console, so it starts a worker (this same exe,
// "--worker") in the active console session with the service's own SYSTEM token. The worker follows
// the input desktop (Default, Winlogon, the UAC secure desktop), takes pictures with GDI, injects
// input with SendInput, and draws a banner on whatever desktop is showing: who from IT is connected,
// and a Stop button (and Ctrl+Alt+Shift+S). A stop at the PC ends the session for good.
//
// Built with the C# 5 compiler of .NET Framework 4.8 (in Windows 10 and 11): no string
// interpolation, no "?.", no expression-bodied members. Build: build.ps1 next to this file.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("Dexterity Connect IT Support")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace DexSupport {
  static class Program {
    public const string ServiceName = "DexConnectSupport";
    public const string Version = "1.0.0";

    [STAThread]
    static int Main(string[] args) {
      try {
        string mode = args.Length > 0 ? args[0] : "";
        if (mode == "--install") return Setup.Install(Arg(args, "--hub"), Arg(args, "--fingerprint"));
        if (mode == "--uninstall") return Setup.Uninstall();
        if (mode == "--status") { Console.WriteLine(Setup.Status()); return 0; }
        if (mode == "--worker") return Worker.Run(args.Length > 1 ? args[1] : "");
        if (mode == "--selftest") return Worker.SelfTest(args.Length > 1 ? args[1] : "selftest.jpg");
        if (mode == "--console") { Paths.ConfigOverride = Program.Arg(args, "--config"); var a = new Agent(true); a.Start(); Console.WriteLine("Running. Press Enter to stop."); Console.ReadLine(); a.Stop(); return 0; }
        if (mode == "--drop-dev-key") { if (CngKey.Exists("DexterityConnectSupport-dev")) CngKey.Open("DexterityConnectSupport-dev").Delete(); return 0; }
        if (Environment.UserInteractive && mode != "--service") {
          Console.WriteLine("Dexterity Connect IT Support " + Version);
          Console.WriteLine("  --install --hub HOST:PORT --fingerprint AA:BB:..   install and start the service (administrator)");
          Console.WriteLine("  --uninstall                                         stop and remove it (administrator)");
          Console.WriteLine("  --status                                            installed, running, which hub");
          Console.WriteLine("  --selftest out.jpg                                  take one picture of this screen");
          return 2;
        }
        ServiceBase.Run(new SupportService());
        return 0;
      } catch (Exception e) {
        Console.Error.WriteLine(e.GetType().Name + ": " + e.Message);
        Log.Write("fatal: " + e);
        return 1;
      }
    }

    public static string Arg(string[] args, string name) {
      for (int i = 0; i < args.Length - 1; i++) if (args[i] == name) return args[i + 1];
      return null;
    }
  }

  // ------------------------------------------------------------------ paths, config and log
  static class Paths {
    public static string Dir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Dexterity Connect Support"); } }
    public static string Exe { get { return Path.Combine(Dir, "DexSupport.exe"); } }
    public static string Data { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Dexterity Connect Support"); } }
    /** --console --config FILE: run as this user against a config of one's own (tests, troubleshooting). */
    public static string ConfigOverride;
    public static string Config { get { return ConfigOverride ?? Path.Combine(Data, "config.json"); } }
    public static string LogFile { get { return ConfigOverride != null ? ConfigOverride + ".log" : Path.Combine(Data, "service.log"); } }
  }

  static class Log {
    static readonly object Gate = new object();
    public static void Write(string line) {
      try {
        lock (Gate) {
          Directory.CreateDirectory(Path.GetDirectoryName(Paths.LogFile));
          var f = new FileInfo(Paths.LogFile);
          if (f.Exists && f.Length > 2 * 1024 * 1024) { File.Delete(Paths.LogFile + ".1"); File.Move(Paths.LogFile, Paths.LogFile + ".1"); }
          File.AppendAllText(Paths.LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + line + Environment.NewLine, Encoding.UTF8);
        }
      } catch { }
    }
  }

  class Config {
    public string Hub;
    public string Fingerprint;
    public static Config Load() {
      if (Paths.ConfigOverride == null) {
        // the service trusts this file for its hub: only when an administrator (or SYSTEM) owns it
        var owner = File.GetAccessControl(Paths.Config, AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (owner == null || !(owner.Equals(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null)) || owner.Equals(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null))))
          throw new InvalidDataException("config.json is not owned by an administrator; reinstall the service");
      }
      var d = Json.Parse(File.ReadAllText(Paths.Config, Encoding.UTF8));
      var c = new Config();
      c.Hub = Json.Str(d, "hub");
      c.Fingerprint = Json.Str(d, "fingerprint");
      if (string.IsNullOrEmpty(c.Hub) || string.IsNullOrEmpty(c.Fingerprint)) throw new InvalidDataException("config.json needs hub and fingerprint");
      return c;
    }
  }

  static class Json {
    static readonly JavaScriptSerializer S = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    public static Dictionary<string, object> Parse(string s) {
      var o = S.DeserializeObject(s) as Dictionary<string, object>;
      return o ?? new Dictionary<string, object>();
    }
    public static string Write(object o) { return S.Serialize(o); }
    public static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v is string ? (string)v : null; }
    public static double Num(Dictionary<string, object> d, string k) {
      object v;
      if (!d.TryGetValue(k, out v) || v == null) return 0;
      try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch { return 0; }
    }
    public static bool Bool(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v is bool && (bool)v; }
  }

  // ------------------------------------------------------------------ the machine's key
  /** The P-256 key that is this PC's identity to the hub, kept in the machine key store (never exported). */
  static class Keys {
    const string Name = "DexterityConnectSupport";
    static CngKey Open(bool machine) {
      var opts = machine ? CngKeyOpenOptions.MachineKey : CngKeyOpenOptions.None;
      string name = machine ? Name : Name + "-dev";
      if (CngKey.Exists(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, opts)) return CngKey.Open(name, CngProvider.MicrosoftSoftwareKeyStorageProvider, opts);
      var p = new CngKeyCreationParameters {
        Provider = CngProvider.MicrosoftSoftwareKeyStorageProvider,
        KeyCreationOptions = machine ? CngKeyCreationOptions.MachineKey : CngKeyCreationOptions.None,
        ExportPolicy = CngExportPolicies.None,
      };
      return CngKey.Create(CngAlgorithm.ECDsaP256, name, p);
    }

    /** SubjectPublicKeyInfo (DER) of a P-256 key, from the CNG public blob (magic, length, X, Y). */
    public static byte[] Spki(CngKey key) {
      byte[] blob = key.Export(CngKeyBlobFormat.EccPublicBlob);
      byte[] prefix = { 0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04 };
      var spki = new byte[prefix.Length + 64];
      Buffer.BlockCopy(prefix, 0, spki, 0, prefix.Length);
      Buffer.BlockCopy(blob, 8, spki, prefix.Length, 64);
      return spki;
    }

    public static string MachineId(byte[] spki) {
      using (var sha = SHA256.Create()) {
        var h = sha.ComputeHash(spki);
        var sb = new StringBuilder("m");
        foreach (var b in h) sb.Append(b.ToString("x2"));
        return sb.ToString(0, 32);
      }
    }

    public class Identity { public string Id; public string PublicKey; public CngKey Key; }

    public static Identity Load(bool machine) {
      var k = Open(machine);
      var spki = Spki(k);
      return new Identity { Id = MachineId(spki), PublicKey = Convert.ToBase64String(spki), Key = k };
    }

    /** ECDSA P-256 over SHA-256, as r||s (what the hub checks, IEEE P1363). */
    public static string Sign(Identity id, string payload) {
      using (var ec = new ECDsaCng(id.Key)) {
        ec.HashAlgorithm = CngAlgorithm.Sha256;
        return Convert.ToBase64String(ec.SignData(Encoding.UTF8.GetBytes(payload)));
      }
    }

    public static string Describe(bool machine) { var i = Load(machine); return i.Id + " " + i.PublicKey; }
  }

  // ------------------------------------------------------------------ install and remove (administrator)
  static class Setup {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr OpenSCManager(string machine, string db, uint access);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateService(IntPtr scm, string name, string display, uint access, uint type, uint start, uint error, string path, string group, IntPtr tag, string deps, string user, string password);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr OpenService(IntPtr scm, string name, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DeleteService(IntPtr svc);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool CloseServiceHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ChangeServiceConfig2(IntPtr svc, uint level, ref SERVICE_DESCRIPTION info);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool ChangeServiceConfig2(IntPtr svc, uint level, ref SERVICE_FAILURE_ACTIONS info);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SERVICE_DESCRIPTION { public string lpDescription; }
    [StructLayout(LayoutKind.Sequential)] struct SC_ACTION { public int Type; public uint Delay; }
    [StructLayout(LayoutKind.Sequential)] struct SERVICE_FAILURE_ACTIONS { public uint dwResetPeriod; public IntPtr lpRebootMsg; public IntPtr lpCommand; public uint cActions; public IntPtr lpsaActions; }

    static bool IsAdmin() { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }

    public static int Install(string hub, string fingerprint) {
      if (!IsAdmin()) { Console.Error.WriteLine("Installing the IT Support service needs administrator rights."); return 5; }
      if (string.IsNullOrEmpty(hub) || string.IsNullOrEmpty(fingerprint) || !System.Text.RegularExpressions.Regex.IsMatch(fingerprint, "^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$")) {
        Console.Error.WriteLine("Give the hub (--hub HOST:PORT) and its certificate fingerprint (--fingerprint AA:BB:...).");
        return 2;
      }
      // stop an older copy before replacing it
      StopService();
      // the service runs from Program Files (only administrators can change it), never from a user's folder
      Directory.CreateDirectory(Paths.Dir);
      string self = Process.GetCurrentProcess().MainModule.FileName;
      if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(Paths.Exe), StringComparison.OrdinalIgnoreCase)) File.Copy(self, Paths.Exe, true);
      SecureDataFolder();
      var cfg = new Dictionary<string, object>();
      cfg["hub"] = hub.Trim();
      cfg["fingerprint"] = fingerprint.Trim().ToUpperInvariant();
      if (File.Exists(Paths.Config)) File.Delete(Paths.Config);
      File.WriteAllText(Paths.Config, Json.Write(cfg), new UTF8Encoding(false));
      File.SetAccessControl(Paths.Config, AdminOnlyFile());
      // the machine's key, created by an administrator in the machine key store
      var id = Keys.Load(true);
      // software may send Ctrl+Alt+Del: services (1), keeping what ease-of-access already had (2 -> 3)
      using (var k = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System")) {
        object v = k.GetValue("SoftwareSASGeneration");
        int cur = v is int ? (int)v : 0;
        if ((cur & 1) == 0) {
          k.SetValue("SoftwareSASGeneration", cur | 1, RegistryValueKind.DWord);
          // what it was, for --uninstall to put back (-1: it was not set)
          using (var mine = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Dexterity Connect Support")) mine.SetValue("PreviousSAS", v is int ? cur : -1, RegistryValueKind.DWord);
        }
      }
      IntPtr scm = OpenSCManager(null, null, 0xF003F);
      if (scm == IntPtr.Zero) throw new Exception("OpenSCManager failed: " + Marshal.GetLastWin32Error());
      try {
        IntPtr svc = OpenService(scm, Program.ServiceName, 0xF01FF);
        if (svc == IntPtr.Zero) {
          // own process, automatic start, LocalSystem
          svc = CreateService(scm, Program.ServiceName, "Dexterity Connect IT Support", 0xF01FF, 0x10, 2, 1, "\"" + Paths.Exe + "\" --service", null, IntPtr.Zero, null, null, null);
          if (svc == IntPtr.Zero) throw new Exception("CreateService failed: " + Marshal.GetLastWin32Error());
        }
        var desc = new SERVICE_DESCRIPTION { lpDescription = "Lets the office IT desk help on this PC with administrator rights, when the office allows it. Shows a banner while IT is connected." };
        ChangeServiceConfig2(svc, 1, ref desc);
        // restart after 5 s on a crash, three times a day
        var actions = new SC_ACTION[] { new SC_ACTION { Type = 1, Delay = 5000 }, new SC_ACTION { Type = 1, Delay = 5000 }, new SC_ACTION { Type = 1, Delay = 30000 } };
        IntPtr buf = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SC_ACTION)) * actions.Length);
        try {
          for (int i = 0; i < actions.Length; i++) Marshal.StructureToPtr(actions[i], buf + i * Marshal.SizeOf(typeof(SC_ACTION)), false);
          var fa = new SERVICE_FAILURE_ACTIONS { dwResetPeriod = 86400, cActions = (uint)actions.Length, lpsaActions = buf };
          ChangeServiceConfig2(svc, 2, ref fa);
        } finally { Marshal.FreeHGlobal(buf); }
        CloseServiceHandle(svc);
      } finally { CloseServiceHandle(scm); }
      using (var sc = new ServiceController(Program.ServiceName)) { sc.Start(); sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20)); }
      Console.WriteLine(Json.Write(new Dictionary<string, object> { { "installed", true }, { "machineId", id.Id }, { "hub", hub } }));
      return 0;
    }

    static readonly SecurityIdentifier SystemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
    static readonly SecurityIdentifier AdminsSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);

    /**
     * %ProgramData%\Dexterity Connect Support, which the SYSTEM service trusts for its hub: anyone may
     * create folders in ProgramData, so one that exists already is only kept when it is a real folder
     * owned by SYSTEM or Administrators; otherwise it is removed and made again. Owner Administrators,
     * only SYSTEM and Administrators in its access list, nothing inherited from ProgramData.
     */
    static void SecureDataFolder() {
      if (Directory.Exists(Paths.Data)) {
        bool reparse = (File.GetAttributes(Paths.Data) & FileAttributes.ReparsePoint) != 0;
        var owner = reparse ? null : Directory.GetAccessControl(Paths.Data, AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
        if (reparse || owner == null || !(owner.Equals(SystemSid) || owner.Equals(AdminsSid))) {
          Log.Write("the data folder was not made by an administrator: made again");
          if (reparse) Directory.Delete(Paths.Data); else Directory.Delete(Paths.Data, true);
        }
      }
      var acl = new DirectorySecurity();
      acl.SetOwner(AdminsSid);
      acl.SetAccessRuleProtection(true, false);
      acl.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      acl.AddAccessRule(new FileSystemAccessRule(AdminsSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      if (!Directory.Exists(Paths.Data)) Directory.CreateDirectory(Paths.Data, acl);
      Directory.SetAccessControl(Paths.Data, acl);
    }

    static FileSecurity AdminOnlyFile() {
      var f = new FileSecurity();
      f.SetOwner(AdminsSid);
      f.SetAccessRuleProtection(true, false);
      f.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl, AccessControlType.Allow));
      f.AddAccessRule(new FileSystemAccessRule(AdminsSid, FileSystemRights.FullControl, AccessControlType.Allow));
      return f;
    }

    static void StopService() {
      try {
        using (var sc = new ServiceController(Program.ServiceName)) {
          if (sc.Status != ServiceControllerStatus.Stopped) { sc.Stop(); sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20)); }
        }
      } catch (InvalidOperationException) { /* not installed */ }
    }

    public static int Uninstall() {
      if (!IsAdmin()) { Console.Error.WriteLine("Removing the IT Support service needs administrator rights."); return 5; }
      StopService();
      IntPtr scm = OpenSCManager(null, null, 0xF003F);
      if (scm != IntPtr.Zero) {
        IntPtr svc = OpenService(scm, Program.ServiceName, 0x10000);
        if (svc != IntPtr.Zero) { DeleteService(svc); CloseServiceHandle(svc); }
        CloseServiceHandle(scm);
      }
      try { if (CngKey.Exists("DexterityConnectSupport", CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.MachineKey)) CngKey.Open("DexterityConnectSupport", CngProvider.MicrosoftSoftwareKeyStorageProvider, CngKeyOpenOptions.MachineKey).Delete(); } catch { }
      try { Directory.Delete(Paths.Data, true); } catch { }
      // Ctrl+Alt+Del from software back to what it was before the install
      try {
        using (var mine = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Dexterity Connect Support")) {
          object prev = mine == null ? null : mine.GetValue("PreviousSAS");
          if (prev is int) using (var k = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System")) {
            if ((int)prev < 0) k.DeleteValue("SoftwareSASGeneration", false); else k.SetValue("SoftwareSASGeneration", (int)prev, RegistryValueKind.DWord);
          }
        }
        Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\Dexterity Connect Support", false);
      } catch { }
      // the exe may be the one running this: removed at the next restart if so
      try { File.Delete(Paths.Exe); Directory.Delete(Paths.Dir); } catch { MoveFileEx(Paths.Exe, null, 4); }
      Console.WriteLine("{\"installed\":false}");
      return 0;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool MoveFileEx(string from, string to, int flags);

    public static string Status() {
      var d = new Dictionary<string, object>();
      try { using (var sc = new ServiceController(Program.ServiceName)) { d["installed"] = true; d["running"] = sc.Status == ServiceControllerStatus.Running; } }
      catch (InvalidOperationException) { d["installed"] = false; d["running"] = false; }
      try { var c = Config.Load(); d["hub"] = c.Hub; } catch { d["hub"] = null; }
      d["version"] = Program.Version;
      return Json.Write(d);
    }
  }

  // ------------------------------------------------------------------ the service
  class SupportService : ServiceBase {
    Agent agent;
    public SupportService() { ServiceName = Program.ServiceName; CanHandleSessionChangeEvent = true; CanShutdown = true; }
    protected override void OnStart(string[] args) { agent = new Agent(false); agent.Start(); }
    protected override void OnStop() { if (agent != null) agent.Stop(); }
    protected override void OnShutdown() { if (agent != null) agent.Stop(); }
    protected override void OnSessionChange(SessionChangeDescription d) { if (agent != null) agent.SessionChanged(d.Reason.ToString()); }
  }

  /** Native calls the service makes in session 0. */
  static class Native {
    [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool WTSQuerySessionInformation(IntPtr server, uint session, int infoClass, out IntPtr buffer, out uint bytes);
    [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);
    [DllImport("sas.dll")] public static extern void SendSAS(bool asUser);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attrs, int level, int type, out IntPtr dup);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, int length);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    public static string SessionUser(uint session) {
      string user = Query(session, 5), domain = Query(session, 7);
      if (string.IsNullOrEmpty(user)) return null;
      return string.IsNullOrEmpty(domain) ? user : domain + "\\" + user;
    }

    static string Query(uint session, int cls) {
      IntPtr buf; uint n;
      if (!WTSQuerySessionInformation(IntPtr.Zero, session, cls, out buf, out n)) return null;
      try { return Marshal.PtrToStringUni(buf); } finally { WTSFreeMemory(buf); }
    }

    /** This exe as a worker in the console session, with the service's SYSTEM token moved to that session. */
    public static Process StartInSession(uint session, string args) {
      IntPtr tok, dup;
      if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x02000000, out tok)) throw new Exception("OpenProcessToken " + Marshal.GetLastWin32Error());
      try {
        if (!DuplicateTokenEx(tok, 0x02000000, IntPtr.Zero, 2, 1, out dup)) throw new Exception("DuplicateTokenEx " + Marshal.GetLastWin32Error());
      } finally { CloseHandle(tok); }
      try {
        uint s = session;
        if (!SetTokenInformation(dup, 12, ref s, 4)) throw new Exception("SetTokenInformation " + Marshal.GetLastWin32Error());
        var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.lpDesktop = "winsta0\\default";
        PROCESS_INFORMATION pi;
        string exe = Process.GetCurrentProcess().MainModule.FileName;
        // CREATE_NO_WINDOW
        if (!CreateProcessAsUser(dup, exe, "\"" + exe + "\" " + args, IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, null, ref si, out pi)) throw new Exception("CreateProcessAsUser " + Marshal.GetLastWin32Error());
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return Process.GetProcessById(pi.dwProcessId);
      } finally { CloseHandle(dup); }
    }
  }

  /** Messages on the pipe between the service and its worker: a type byte, a length, the bytes. */
  static class Wire {
    public static void Send(Stream s, char type, byte[] data) {
      lock (s) {
        var head = new byte[5];
        head[0] = (byte)type;
        BitConverter.GetBytes(data.Length).CopyTo(head, 1);
        s.Write(head, 0, 5);
        s.Write(data, 0, data.Length);
        s.Flush();
      }
    }
    public static void Send(Stream s, char type, string text) { Send(s, type, Encoding.UTF8.GetBytes(text ?? "")); }
    public static bool Read(Stream s, out char type, out byte[] data) {
      type = '\0'; data = null;
      var head = new byte[5];
      if (!Fill(s, head)) return false;
      int n = BitConverter.ToInt32(head, 1);
      if (n < 0 || n > 32 * 1024 * 1024) return false;
      data = new byte[n];
      if (!Fill(s, data)) return false;
      type = (char)head[0];
      return true;
    }
    static bool Fill(Stream s, byte[] b) {
      int off = 0;
      while (off < b.Length) { int r = s.Read(b, off, b.Length - off); if (r <= 0) return false; off += r; }
      return true;
    }
  }

  /** The service's work: the hub connection, the worker in the console session, and the session with IT. */
  class Agent {
    readonly bool dev;
    readonly CancellationTokenSource stop = new CancellationTokenSource();
    readonly BlockingCollection<string> outbox = new BlockingCollection<string>(256);
    Config cfg;
    Keys.Identity id;
    volatile ClientWebSocket ws;
    // the worker and its pipe
    readonly object workerGate = new object();
    Process worker;
    NamedPipeServerStream pipe;
    uint workerSession = uint.MaxValue;
    // the session with IT, and the ones the person at the PC stopped (never taken up again)
    volatile string session;
    readonly HashSet<string> stoppedHere = new HashSet<string>();
    string tech;
    int credits;
    long seq;
    string desktop = "Default";

    public Agent(bool dev) { this.dev = dev; }

    public void Start() {
      cfg = Config.Load();
      id = Keys.Load(!dev);
      ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
      // the hub's certificate is self-signed: pinned by its SHA-256 fingerprint, nothing else is trusted
      ServicePointManager.ServerCertificateValidationCallback = delegate(object sender, X509Certificate cert, X509Chain chain, System.Net.Security.SslPolicyErrors errors) {
        return cert != null && Fingerprint(cert.GetRawCertData()) == cfg.Fingerprint;
      };
      Log.Write("starting " + Program.Version + " as " + id.Id + " for " + cfg.Hub);
      new Thread(HubLoop) { IsBackground = true, Name = "hub" }.Start();
      new Thread(SendLoop) { IsBackground = true, Name = "send" }.Start();
      new Thread(WorkerLoop) { IsBackground = true, Name = "worker" }.Start();
    }

    public void Stop() {
      // a restart or the service stopping is the PC going away for a while, not the person's Stop:
      // the hub pauses the session (with reconnect on) and it goes on when the service is back
      Tell('X', "");
      var c = ws;
      if (c != null) { try { c.CloseOutputAsync(WebSocketCloseStatus.EndpointUnavailable, "restarting", CancellationToken.None).Wait(2000); } catch { } }
      stop.Cancel();
      lock (workerGate) { KillWorker(); }
    }

    static string Fingerprint(byte[] der) {
      using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(der)).Replace("-", ":");
    }

    public void SessionChanged(string reason) {
      Log.Write("session change: " + reason);
      // a sign-in, sign-out or switch moves the console to another session: the worker follows it
      if (reason == "ConsoleConnect" || reason == "ConsoleDisconnect" || reason == "SessionLogon" || reason == "SessionLogoff") lock (workerGate) { KillWorker(); }
      SendState();
    }

    // ---------------------------------------------------------------- the hub
    void HubLoop() {
      int wait = 2000;
      while (!stop.IsCancellationRequested) {
        try {
          RunHub();
          wait = 2000;
        } catch (Exception e) {
          Log.Write("hub: " + e.Message);
        }
        ws = null;
        if (session != null) Tell('X', "");
        session = null;
        stop.Token.WaitHandle.WaitOne(wait);
        wait = Math.Min(wait * 2, 30000);
      }
    }

    void RunHub() {
      var c = new ClientWebSocket();
      c.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
      c.ConnectAsync(new Uri("wss://" + cfg.Hub + "/ws"), stop.Token).Wait();
      var buf = new byte[64 * 1024];
      var hello = Json.Parse(Receive(c, buf));
      if (Json.Str(hello, "t") != "hello") throw new Exception("no hello from the hub");
      string payload = "dexconnect-auth-v1|" + Json.Str(hello, "nonce") + "|" + cfg.Fingerprint + "|" + id.Id;
      var h = new Dictionary<string, object>();
      h["t"] = "machine"; h["id"] = id.Id; h["publicKey"] = id.PublicKey; h["hostname"] = Environment.MachineName;
      h["version"] = Program.Version; h["sig"] = Keys.Sign(id, payload);
      h["consoleUser"] = Native.SessionUser(Native.WTSGetActiveConsoleSessionId()); h["locked"] = desktop != "Default";
      SendNow(c, Json.Write(h));
      var ok = Json.Parse(Receive(c, buf));
      if (Json.Str(ok, "t") != "m.ok") throw new Exception("the hub refused: " + (Json.Str(ok, "reason") ?? Json.Str(ok, "t")));
      ws = c;
      Log.Write("connected to the hub");
      DateTime lastState = DateTime.UtcNow;
      while (!stop.IsCancellationRequested && c.State == WebSocketState.Open) {
        var task = Task.Run(() => Receive(c, buf));
        while (!task.Wait(1000)) {
          if (stop.IsCancellationRequested) return;
          if ((DateTime.UtcNow - lastState).TotalSeconds > 20) { SendState(); lastState = DateTime.UtcNow; }
        }
        if (task.Result == null) return;
        OnHub(Json.Parse(task.Result));
      }
    }

    static string Receive(ClientWebSocket c, byte[] buf) {
      var ms = new MemoryStream();
      while (true) {
        var r = c.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None).Result;
        if (r.MessageType == WebSocketMessageType.Close) return null;
        ms.Write(buf, 0, r.Count);
        if (r.EndOfMessage) break;
        if (ms.Length > 4 * 1024 * 1024) throw new Exception("message too large");
      }
      return Encoding.UTF8.GetString(ms.ToArray());
    }

    static void SendNow(ClientWebSocket c, string text) {
      c.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(text)), WebSocketMessageType.Text, true, CancellationToken.None).Wait();
    }

    void Post(string text) { if (ws != null) outbox.TryAdd(text); }

    void SendLoop() {
      foreach (var m in outbox.GetConsumingEnumerable(stop.Token)) {
        var c = ws;
        if (c == null || c.State != WebSocketState.Open) continue;
        try { SendNow(c, m); } catch (Exception e) { Log.Write("send: " + e.Message); }
      }
    }

    void SendState() {
      var d = new Dictionary<string, object>();
      d["t"] = "m.state"; d["consoleUser"] = Native.SessionUser(Native.WTSGetActiveConsoleSessionId()); d["locked"] = desktop != "Default";
      Post(Json.Write(d));
    }

    void OnHub(Dictionary<string, object> m) {
      string t = Json.Str(m, "t");
      string s = Json.Str(m, "s");
      if (t == "m.start" && s != null) {
        bool refused;
        lock (stoppedHere) refused = stoppedHere.Contains(s);
        if (refused) {
          // the person stopped it here; the hub may not have heard (a dropped link): tell it again
          var d = new Dictionary<string, object>(); d["t"] = "m.ended"; d["s"] = s; d["why"] = "The person at the PC pressed Stop.";
          Post(Json.Write(d));
          return;
        }
        session = s; tech = Json.Str(m, "tech") ?? "IT"; credits = 2;
        Log.Write("IT connected: " + tech + " (" + s + ")");
        Tell('S', tech);
      } else if (s == null || s != session) {
        return;
      } else if (t == "m.input") {
        object e;
        if (m.TryGetValue("e", out e)) Tell('I', Json.Write(e));
      } else if (t == "m.ack") {
        Interlocked.Increment(ref credits);
        Tell('A', "");
      } else if (t == "m.sas") {
        Log.Write("Ctrl+Alt+Del from " + tech);
        try { Native.SendSAS(false); } catch (Exception ex) { Log.Write("SendSAS: " + ex.Message); }
      } else if (t == "m.stop") {
        Log.Write("IT session ended: " + Json.Str(m, "why"));
        session = null;
        Tell('X', "");
      }
    }

    /** End the session from this PC (the person pressed Stop, or the service stops). */
    void EndSession(string why, bool now) {
      string s = session;
      if (s == null) return;
      lock (stoppedHere) stoppedHere.Add(s);
      session = null;
      Tell('X', "");
      var d = new Dictionary<string, object>();
      d["t"] = "m.ended"; d["s"] = s; d["why"] = why;
      var c = ws;
      if (now && c != null) { try { SendNow(c, Json.Write(d)); } catch { } } else Post(Json.Write(d));
    }

    // ---------------------------------------------------------------- the worker
    void Tell(char type, string text) {
      var p = pipe;
      if (p == null || !p.IsConnected) return;
      try { Wire.Send(p, type, text); } catch (Exception e) { Log.Write("pipe: " + e.Message); }
    }

    void KillWorker() {
      try { if (pipe != null) pipe.Dispose(); } catch { }
      pipe = null;
      try { if (worker != null && !worker.HasExited) worker.Kill(); } catch { }
      worker = null;
      workerSession = uint.MaxValue;
    }

    void WorkerLoop() {
      while (!stop.IsCancellationRequested) {
        try {
          uint console = Native.WTSGetActiveConsoleSessionId();
          NamedPipeServerStream p = null;
          lock (workerGate) {
            if (console != 0xFFFFFFFF && (worker == null || worker.HasExited || workerSession != console)) {
              KillWorker();
              string name = "DexSupport-" + Guid.NewGuid().ToString("N");
              var ps = new PipeSecurity();
              // only SYSTEM (the worker runs as SYSTEM) - or, in --console, this user
              var who = dev ? WindowsIdentity.GetCurrent().User : new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
              ps.AddAccessRule(new PipeAccessRule(who, PipeAccessRights.FullControl, AccessControlType.Allow));
              p = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 1 << 20, 1 << 20, ps);
              worker = dev ? Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--worker " + name) { UseShellExecute = false, CreateNoWindow = true })
                : Native.StartInSession(console, "--worker " + name);
              workerSession = console;
              Log.Write("worker started in session " + console);
            }
          }
          if (p != null) {
            var wait = p.WaitForConnectionAsync();
            if (!wait.Wait(15000)) { Log.Write("the worker did not connect"); lock (workerGate) { KillWorker(); } continue; }
            pipe = p;
            if (session != null) Tell('S', tech);
            ReadWorker(p);
          }
        } catch (Exception e) {
          Log.Write("worker: " + e.Message);
        }
        stop.Token.WaitHandle.WaitOne(1500);
      }
    }

    void ReadWorker(NamedPipeServerStream p) {
      char type; byte[] data;
      while (!stop.IsCancellationRequested && Wire.Read(p, out type, out data)) {
        if (type == 'F') {
          string s = session;
          if (s == null || Interlocked.Decrement(ref credits) < 0) { Interlocked.Increment(ref credits); continue; }
          int w = BitConverter.ToInt32(data, 0), h = BitConverter.ToInt32(data, 4);
          var sb = new StringBuilder(data.Length * 4 / 3 + 128);
          sb.Append("{\"t\":\"m.frame\",\"s\":\"").Append(s).Append("\",\"seq\":").Append(Interlocked.Increment(ref seq))
            .Append(",\"w\":").Append(w).Append(",\"h\":").Append(h).Append(",\"d\":\"").Append(Convert.ToBase64String(data, 8, data.Length - 8)).Append("\"}");
          Post(sb.ToString());
        } else if (type == 'E') {
          EndSession(Encoding.UTF8.GetString(data), false);
        } else if (type == 'D') {
          desktop = Encoding.UTF8.GetString(data);
          SendState();
        } else if (type == 'L') {
          Log.Write("worker: " + Encoding.UTF8.GetString(data));
        }
      }
    }
  }

  // ------------------------------------------------------------------ the worker in the console session
  static class Worker {
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desk);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desk);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
    [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
    [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot, yHotspot; public IntPtr hbmMask, hbmColor; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

    static Stream pipe;
    static readonly ConcurrentQueue<Dictionary<string, object>> inputs = new ConcurrentQueue<Dictionary<string, object>>();
    static volatile string tech;
    static int credits;
    static string deskName = "";
    static IntPtr desk = IntPtr.Zero;
    /** Keys IT holds down, with their extended flag (right Ctrl and Alt differ from the left ones only by it). */
    static readonly Dictionary<int, bool> heldKeys = new Dictionary<int, bool>();
    static readonly HashSet<string> heldButtons = new HashSet<string>();
    static readonly Queue<DateTime> recent = new Queue<DateTime>();
    static Banner banner;

    static void Dpi() {
      try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
    }

    public static int Run(string pipeName) {
      Dpi();
      // overlapped, so a read waiting on one thread does not hold up a write from another
      var p = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
      p.Connect(10000);
      pipe = p;
      banner = new Banner();
      new Thread(ReadLoop) { IsBackground = true, Name = "pipe" }.Start();
      // a fresh thread with no windows (the STA main thread has COM's hidden one), so it can change desktops
      var desk = new Thread(DeskLoop) { Name = "desk" };
      desk.SetApartmentState(ApartmentState.MTA);
      desk.Start();
      desk.Join();
      return 0;
    }

    static void Send(char type, byte[] data) { try { Wire.Send(pipe, type, data); } catch { Environment.Exit(0); } }
    static void Say(string line) { Send('L', Encoding.UTF8.GetBytes(line)); }

    static void ReadLoop() {
      char type; byte[] data;
      var js = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
      while (Wire.Read(pipe, out type, out data)) {
        string text = Encoding.UTF8.GetString(data);
        if (type == 'S') { tech = text; Interlocked.Exchange(ref credits, 2); banner.Show(text, StopPressed); }
        else if (type == 'X') { tech = null; banner.Hide(); inputs.Enqueue(null); }
        else if (type == 'A') Interlocked.Increment(ref credits);
        else if (type == 'I') {
          var list = js.DeserializeObject(text) as object[];
          if (list != null) foreach (var o in list) { var d = o as Dictionary<string, object>; if (d != null) inputs.Enqueue(d); }
        }
      }
      Environment.Exit(0);
    }

    static void StopPressed() {
      string who = null;
      try { who = Environment.UserName; } catch { }
      tech = null;
      banner.Hide();
      inputs.Enqueue(null);
      Send('E', Encoding.UTF8.GetBytes("The person at the PC pressed Stop."));
    }

    /** Follow the input desktop (Default, Winlogon, the UAC prompt's): this thread captures and injects on it. */
    static void FollowDesktop() {
      IntPtr d = OpenInputDesktop(0, false, 0x10000000 /* GENERIC_ALL */);
      if (d == IntPtr.Zero) return;
      var sb = new StringBuilder(256); int n;
      GetUserObjectInformation(d, 2 /* UOI_NAME */, sb, sb.Capacity * 2, out n);
      string name = sb.ToString();
      if (name == deskName) { CloseDesktop(d); return; }
      if (!SetThreadDesktop(d)) { Say("SetThreadDesktop " + name + " failed: " + Marshal.GetLastWin32Error()); CloseDesktop(d); return; }
      if (desk != IntPtr.Zero) CloseDesktop(desk);
      desk = d;
      deskName = name;
      Send('D', Encoding.UTF8.GetBytes(name));
      banner.MoveTo(name);
    }

    static void DeskLoop() {
      DateTime next = DateTime.UtcNow;
      while (true) {
        FollowDesktop();
        Dictionary<string, object> c;
        while (inputs.TryDequeue(out c)) { if (c == null) Release(); else if (tech != null) Inject(c); }
        if (tech != null && credits > 0 && DateTime.UtcNow >= next) {
          next = DateTime.UtcNow.AddMilliseconds(110);
          try {
            byte[] jpeg; int w, h;
            if (Capture(out jpeg, out w, out h)) {
              Interlocked.Decrement(ref credits);
              var data = new byte[8 + jpeg.Length];
              BitConverter.GetBytes(w).CopyTo(data, 0); BitConverter.GetBytes(h).CopyTo(data, 4);
              Buffer.BlockCopy(jpeg, 0, data, 8, jpeg.Length);
              Send('F', data);
            }
          } catch (Exception e) { Say("capture: " + e.Message); }
        }
        Thread.Sleep(10);
      }
    }

    static ImageCodecInfo jpegCodec;

    /** The whole virtual screen (every monitor) with the pointer, at most 1920 wide, as JPEG. */
    static bool Capture(out byte[] jpeg, out int outW, out int outH) {
      jpeg = null; outW = outH = 0;
      int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
      if (w <= 0 || h <= 0) return false;
      IntPtr screen = GetDC(IntPtr.Zero);
      IntPtr mem = CreateCompatibleDC(screen);
      IntPtr bmp = CreateCompatibleBitmap(screen, w, h);
      IntPtr old = SelectObject(mem, bmp);
      try {
        if (!BitBlt(mem, 0, 0, w, h, screen, x, y, 0x00CC0020 | 0x40000000 /* SRCCOPY | CAPTUREBLT */)) return false;
        var ci = new CURSORINFO(); ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
        if (GetCursorInfo(ref ci) && (ci.flags & 1) != 0) {
          ICONINFO ii;
          int hx = 0, hy = 0;
          if (GetIconInfo(ci.hCursor, out ii)) { hx = ii.xHotspot; hy = ii.yHotspot; if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask); if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor); }
          DrawIconEx(mem, ci.pt.X - x - hx, ci.pt.Y - y - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3);
        }
        SelectObject(mem, old);
        using (var full = Image.FromHbitmap(bmp)) {
          double scale = Math.Min(1.0, Math.Min(1920.0 / w, 1920.0 / h));
          outW = Math.Max(1, (int)(w * scale)); outH = Math.Max(1, (int)(h * scale));
          using (var small = new Bitmap(outW, outH, PixelFormat.Format24bppRgb)) {
            using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(full, 0, 0, outW, outH); }
            if (jpegCodec == null) foreach (var codec in ImageCodecInfo.GetImageEncoders()) if (codec.MimeType == "image/jpeg") jpegCodec = codec;
            // a busy screen at 60 can be too big for the hub (900,000 base64 characters): try lower
            foreach (long q in new long[] { 60L, 40L, 25L }) {
              var ep = new EncoderParameters(1);
              ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, q);
              using (var ms = new MemoryStream()) { small.Save(ms, jpegCodec, ep); jpeg = ms.ToArray(); }
              if (jpeg.Length < 650000) break;
            }
          }
        }
        // the hub relays up to 900,000 base64 characters a picture
        return jpeg.Length < 650000;
      } finally {
        DeleteObject(bmp); DeleteDC(mem); ReleaseDC(IntPtr.Zero, screen);
      }
    }

    // ---------------------------------------------------------------- input
    static void Mouse(int dx, int dy, uint data, uint flags) {
      var i = new INPUT[1]; i[0].type = 0; i[0].u.mi.dx = dx; i[0].u.mi.dy = dy; i[0].u.mi.mouseData = data; i[0].u.mi.dwFlags = flags;
      SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }
    static void Key(int vk, bool ext, bool down) {
      var i = new INPUT[1]; i[0].type = 1; i[0].u.ki.wVk = (ushort)vk; i[0].u.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
      i[0].u.ki.dwFlags = (ext ? 1u : 0u) | (down ? 0u : 2u);
      SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }

    static void MoveTo(double fx, double fy) {
      if (fx < 0 || fy < 0) return;
      int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = Math.Max(2, GetSystemMetrics(78)), vh = Math.Max(2, GetSystemMetrics(79));
      int px = vx + Math.Min(vw - 1, Math.Max(0, (int)Math.Floor(Math.Min(1, fx) * vw)));
      int py = vy + Math.Min(vh - 1, Math.Max(0, (int)Math.Floor(Math.Min(1, fy) * vh)));
      Mouse((int)Math.Round((px - vx) * 65535.0 / (vw - 1)), (int)Math.Round((py - vy) * 65535.0 / (vh - 1)), 0, 0x0001 | 0x8000 | 0x4000);
      SetCursorPos(px, py);
    }

    /** One command from IT. The hub's gate already checked it; this PC limits the rate again (200 a second). */
    static void Inject(Dictionary<string, object> c) {
      string t = Json.Str(c, "t");
      bool release = (t == "key" || t == "button") && !Json.Bool(c, "down");
      if (!release) {
        var now = DateTime.UtcNow;
        while (recent.Count > 0 && (now - recent.Peek()).TotalMilliseconds > 1000) recent.Dequeue();
        if (recent.Count >= 200) return;
        recent.Enqueue(now);
      }
      if (t == "move") MoveTo(Json.Num(c, "x"), Json.Num(c, "y"));
      else if (t == "button") {
        MoveTo(Json.Num(c, "x"), Json.Num(c, "y"));
        string b = Json.Str(c, "b") ?? "left";
        bool down = Json.Bool(c, "down");
        uint f = b == "right" ? (down ? 0x0008u : 0x0010u) : b == "middle" ? (down ? 0x0020u : 0x0040u) : (down ? 0x0002u : 0x0004u);
        if (down) heldButtons.Add(b); else if (!heldButtons.Remove(b)) return;
        Mouse(0, 0, 0, f);
      } else if (t == "wheel") {
        MoveTo(Json.Num(c, "x"), Json.Num(c, "y"));
        int dy = (int)Math.Max(-10, Math.Min(10, Json.Num(c, "dy"))), dx = (int)Math.Max(-10, Math.Min(10, Json.Num(c, "dx")));
        if (dy != 0) Mouse(0, 0, unchecked((uint)(-dy * 120)), 0x0800);
        if (dx != 0) Mouse(0, 0, unchecked((uint)(dx * 120)), 0x1000);
      } else if (t == "key") {
        int vk = (int)Json.Num(c, "vk");
        if (vk <= 0 || vk > 254) return;
        bool down = Json.Bool(c, "down"), ext = Json.Bool(c, "ext");
        if (down) heldKeys[vk] = ext; else if (!heldKeys.Remove(vk)) return;
        Key(vk, ext, down);
      }
    }

    /** Let go of everything IT was holding (the session ended or was stopped). */
    static void Release() {
      foreach (var k in heldKeys) Key(k.Key, k.Value, false);
      foreach (var b in heldButtons) Mouse(0, 0, 0, b == "right" ? 0x0010u : b == "middle" ? 0x0040u : 0x0004u);
      heldKeys.Clear(); heldButtons.Clear();
    }

    /** One picture of this screen to a file, and the pointer moved and back (a check without the service or the hub). */
    public static int SelfTest(string path) {
      Dpi();
      byte[] jpeg; int w, h;
      if (!Capture(out jpeg, out w, out h)) { Console.Error.WriteLine("capture failed"); return 1; }
      File.WriteAllBytes(path, jpeg);
      POINT before; GetCursorPos(out before);
      MoveTo(0.5, 0.5);
      POINT mid; GetCursorPos(out mid);
      SetCursorPos(before.X, before.Y);
      int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
      bool centred = Math.Abs(mid.X - (vx + vw / 2)) <= 1 && Math.Abs(mid.Y - (vy + vh / 2)) <= 1;
      Console.WriteLine(Json.Write(new Dictionary<string, object> { { "width", w }, { "height", h }, { "bytes", jpeg.Length }, { "virtual", vw + "x" + vh }, { "pointerCentred", centred } }));
      return centred ? 0 : 3;
    }
  }

  // ------------------------------------------------------------------ the banner on the PC
  /**
   * While IT is connected: a topmost strip at the top of whatever desktop is showing (the person's,
   * the lock or sign-in screen, a UAC prompt) saying who from IT is connected with administrator
   * rights, with Stop and the keys Ctrl+Alt+Shift+S. It runs on a thread of its own so it can move
   * to another desktop (a thread with windows cannot change desktops: a new one is made each time).
   */
  class Banner {
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desk);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desk);
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hwnd, int id, uint mods, uint vk);

    readonly object gate = new object();
    string who;
    Action onStop;
    string desktop = "Default";
    Form form;
    Thread thread;

    public void Show(string tech, Action stop) { lock (gate) { who = tech; onStop = stop; Restart(); } }
    public void Hide() { lock (gate) { who = null; Close(); } }
    public void MoveTo(string desktopName) { lock (gate) { if (desktopName == desktop && form != null) return; desktop = desktopName; if (who != null) Restart(); } }

    // called with the gate held; the banner thread never takes it, so waiting here cannot deadlock
    void Close() {
      var f = form;
      var t = thread;
      form = null;
      thread = null;
      if (f != null) { try { f.BeginInvoke(new Action(delegate { f.Close(); })); } catch { } }
      if (t != null && !t.Join(3000)) Log.Write("banner: a strip did not close in time");
    }

    void Restart() {
      Close();
      string text = who, name = desktop;
      Action stop = onStop;
      var ready = new ManualResetEventSlim(false);
      Form made = null;
      var t = new Thread(delegate() {
        IntPtr d = OpenDesktop(name, 0, false, 0x10000000);
        try {
          if (d != IntPtr.Zero) SetThreadDesktop(d);
          var f = new StripForm(text, stop);
          made = f;
          // the window exists before anyone may close it
          f.HandleCreated += delegate { ready.Set(); };
          f.FormClosed += delegate { Application.ExitThread(); };
          Application.Run(f);
        } catch (Exception e) {
          Log.Write("banner: " + e.Message);
        } finally {
          ready.Set();
          if (d != IntPtr.Zero) CloseDesktop(d);
        }
      });
      t.SetApartmentState(ApartmentState.STA);
      t.IsBackground = true;
      t.Start();
      ready.Wait(3000);
      form = made;
      thread = t;
    }

    class StripForm : Form {
      readonly Action stop;
      public StripForm(string tech, Action stop) {
        this.stop = stop;
        FormBorderStyle = FormBorderStyle.None; TopMost = true; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(217, 138, 0); ForeColor = Color.Black; Font = new Font("Segoe UI", 10f, FontStyle.Bold);
        var screen = Screen.PrimaryScreen.Bounds;
        Width = Math.Min(760, screen.Width); Height = 40; Left = screen.Left + (screen.Width - Width) / 2; Top = screen.Top;
        var label = new Label { Text = tech + " from IT is connected to this PC with administrator rights", AutoSize = false, Left = 14, Top = 0, Width = Width - 210, Height = Height, TextAlign = ContentAlignment.MiddleLeft };
        var keys = new Label { Text = "Ctrl+Alt+Shift+S", AutoSize = false, Left = Width - 196, Top = 0, Width = 110, Height = Height, TextAlign = ContentAlignment.MiddleRight, Font = new Font("Consolas", 8f) };
        var button = new Button { Text = "Stop", Left = Width - 80, Top = 6, Width = 68, Height = 28, BackColor = Color.White, FlatStyle = FlatStyle.Flat };
        button.Click += delegate { Fire(); };
        Controls.Add(label); Controls.Add(keys); Controls.Add(button);
      }
      void Fire() { if (stop != null) stop(); }
      protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        RegisterHotKey(Handle, 1, 0x0001 | 0x0002 | 0x0004 | 0x4000 /* Alt Ctrl Shift NoRepeat */, 0x53 /* S */);
      }
      protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0312 /* WM_HOTKEY */) Fire();
        base.WndProc(ref m);
      }
      protected override CreateParams CreateParams {
        get { var p = base.CreateParams; p.ExStyle |= 0x00000008 /* TOPMOST */ | 0x00000080 /* TOOLWINDOW */ | 0x08000000 /* NOACTIVATE */; return p; }
      }
      protected override bool ShowWithoutActivation { get { return true; } }
    }
  }
}
