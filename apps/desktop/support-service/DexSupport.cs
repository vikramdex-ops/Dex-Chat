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
        if (mode == "--install" || mode == "--uninstall") Log.ConsoleOnly = true;
        if (mode == "--install") return Setup.Install(Arg(args, "--hub"), Arg(args, "--fingerprint"));
        if (mode == "--uninstall") return Setup.Uninstall();
        if (mode == "--status") { Console.WriteLine(Setup.Status()); return 0; }
        if (mode == "--worker") return Worker.Run(args.Length > 1 ? args[1] : "");
        if (mode == "--selftest") return Worker.SelfTest(args.Length > 1 ? args[1] : "selftest.jpg");
        if (mode == "--console") { Paths.ConfigOverride = Program.Arg(args, "--config"); var a = new Agent(true); a.Start(); Console.WriteLine("Running. Press Enter to stop."); Console.ReadLine(); a.Stop(); return 0; }
        // --check-file FILE: is that file only in the hands of SYSTEM and Administrators (what the service asks of config.json)?
        if (mode == "--check-file") { using (var fs = new FileStream(args[1], FileMode.Open, FileAccess.Read, FileShare.Read)) Console.WriteLine(Trusted.File(fs) ? "trusted" : "not trusted"); return 0; }
        if (mode == "--preview-notice") return Worker.Preview(args.Length > 1 ? args[1] : "Ravi Kumar", args.Length > 2 ? args[2] : "T-0042", args.Length > 3 ? int.Parse(args[3]) : 20, args.Length > 4 && args[4] == "privacy");
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
    // config, log and state beside the program, in Program Files: only administrators can create or
    // change anything there, so no one can make this folder first (ProgramData lets anyone)
    public static string Data { get { return Path.Combine(Dir, "data"); } }
    /** --console --config FILE: run as this user against a config of one's own (tests, troubleshooting). */
    public static string ConfigOverride;
    public static string Config { get { return ConfigOverride ?? Path.Combine(Data, "config.json"); } }
    public static string LogFile { get { return ConfigOverride != null ? ConfigOverride + ".log" : Path.Combine(Data, "service.log"); } }
  }

  static class Log {
    static readonly object Gate = new object();
    /** --install / --uninstall: lines go to the console only, never into the data folder (not secured yet, or being removed). */
    public static bool ConsoleOnly;
    public static void Write(string line) {
      if (ConsoleOnly) { Console.Error.WriteLine(line); return; }
      try {
        lock (Gate) {
          string dir = Path.GetDirectoryName(Paths.LogFile);
          // never through a link someone else put there
          if (Directory.Exists(dir) && (File.GetAttributes(dir) & FileAttributes.ReparsePoint) != 0) return;
          Directory.CreateDirectory(dir);
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
      string text;
      if (Paths.ConfigOverride != null) text = File.ReadAllText(Paths.Config, Encoding.UTF8);
      else {
        // the service trusts this file for its hub: its folder must be ours, and the file, as opened
        // (no other names for it, only SYSTEM and Administrators may change it), too
        if (!Trusted.Folder(Paths.Data)) throw new InvalidDataException("The data folder is not an administrator's; reinstall the service.");
        using (var fs = new FileStream(Paths.Config, FileMode.Open, FileAccess.Read, FileShare.Read)) {
          if (!Trusted.File(fs)) throw new InvalidDataException("config.json could be changed by someone who is not an administrator; reinstall the service.");
          using (var r = new StreamReader(fs, Encoding.UTF8)) text = r.ReadToEnd();
        }
      }
      var d = Json.Parse(text);
      var c = new Config();
      c.Hub = Json.Str(d, "hub");
      c.Fingerprint = Json.Str(d, "fingerprint");
      if (string.IsNullOrEmpty(c.Hub) || string.IsNullOrEmpty(c.Fingerprint)) throw new InvalidDataException("config.json needs hub and fingerprint");
      return c;
    }
  }

  /** Is a folder or an open file only in the hands of SYSTEM and Administrators? */
  static class Trusted {
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);
    [StructLayout(LayoutKind.Sequential)]
    // FILETIMEs as two uints each: a long here would be 8-aligned and shift every field after it
    struct BY_HANDLE_FILE_INFORMATION { public uint attrs; public uint created1, created2, accessed1, accessed2, written1, written2; public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow; }

    static readonly SecurityIdentifier Sys = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
    static readonly SecurityIdentifier Admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
    const FileSystemRights Changes = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteExtendedAttributes
      | FileSystemRights.WriteAttributes | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

    static bool Ours(SecurityIdentifier sid) { return sid != null && (sid.Equals(Sys) || sid.Equals(Admins)); }

    static bool OnlyOurs(FileSystemSecurity sec) {
      if (!Ours(sec.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier)) return false;
      foreach (FileSystemAccessRule r in sec.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
        if (r.AccessControlType == AccessControlType.Allow && (r.FileSystemRights & Changes) != 0 && !Ours(r.IdentityReference as SecurityIdentifier)) return false;
      }
      return true;
    }

    public static bool Folder(string path) {
      if ((System.IO.File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return false;
      return OnlyOurs(Directory.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access));
    }

    public static bool File(FileStream fs) {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(fs.SafeFileHandle, out info) || info.links != 1 || (info.attrs & 0x400) != 0) return false;
      return OnlyOurs(fs.GetAccessControl());
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
      // an uninstall before this may have left these to be deleted at the next restart: not any more
      ForgetPendingDeletes(Paths.Exe, Paths.Dir);
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
     * The service's data folder (Program Files\Dexterity Connect Support\data), which it trusts for its
     * hub: one that exists already is only kept when it is a real folder only SYSTEM and Administrators
     * can change; otherwise it is moved aside and made again. Owner Administrators, only SYSTEM and
     * Administrators in its access list, nothing inherited.
     */
    static void SecureDataFolder() {
      if (Directory.Exists(Paths.Data) && !Trusted.Folder(Paths.Data)) {
        // moving renames the folder (or the link) itself: nothing inside it is followed or touched
        string aside = Paths.Data + ".untrusted-" + Guid.NewGuid().ToString("N").Substring(0, 8);
        Directory.Move(Paths.Data, aside);
        Console.Error.WriteLine("A folder of that name not made by an administrator was moved aside: " + aside);
      }
      var acl = new DirectorySecurity();
      acl.SetOwner(AdminsSid);
      acl.SetAccessRuleProtection(true, false);
      acl.AddAccessRule(new FileSystemAccessRule(SystemSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      acl.AddAccessRule(new FileSystemAccessRule(AdminsSid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      if (!Directory.Exists(Paths.Data)) Directory.CreateDirectory(Paths.Data, acl);
      // someone may have made it again in the moment between: then it is not ours, and the install stops
      if (!Trusted.Folder(Paths.Data)) throw new UnauthorizedAccessException("Someone else created " + Paths.Data + " during the install. Run the install again.");
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

    /** Remove our own paths from the deletes Windows does at the next restart (PendingFileRenameOperations). */
    static void ForgetPendingDeletes(params string[] paths) {
      try {
        using (var k = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager", true)) {
          var ops = k == null ? null : k.GetValue("PendingFileRenameOperations") as string[];
          if (ops == null) return;
          var keep = new List<string>();
          for (int i = 0; i + 1 < ops.Length; i += 2) {
            string from = ops[i].StartsWith(@"\??\") ? ops[i].Substring(4) : ops[i];
            bool ours = ops[i + 1].Length == 0 && Array.Exists(paths, delegate(string x) { return string.Equals(from, x, StringComparison.OrdinalIgnoreCase); });
            if (!ours) { keep.Add(ops[i]); keep.Add(ops[i + 1]); }
          }
          if (keep.Count == ops.Length) return;
          if (keep.Count == 0) k.DeleteValue("PendingFileRenameOperations", false);
          else k.SetValue("PendingFileRenameOperations", keep.ToArray(), RegistryValueKind.MultiString);
        }
      } catch (Exception e) { Console.Error.WriteLine("Could not check pending deletes: " + e.Message); }
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
      // only our own folder is deleted (one someone else made is left alone: a recursive delete as
      // administrator could be steered through a link inside it)
      try { if (Directory.Exists(Paths.Data) && Trusted.Folder(Paths.Data)) Directory.Delete(Paths.Data, true); } catch { }
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
      try { File.Delete(Paths.Exe); } catch { }
      // only what is still there is left for the next restart to remove
      if (File.Exists(Paths.Exe)) MoveFileEx(Paths.Exe, null, 4);
      try { Directory.Delete(Paths.Dir); } catch { if (Directory.Exists(Paths.Dir) && Directory.GetFileSystemEntries(Paths.Dir).Length == 0) MoveFileEx(Paths.Dir, null, 4); }
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

    string StoppedFile { get { return Path.Combine(Path.GetDirectoryName(Paths.LogFile), "stopped.txt"); } }

    /** Sessions the person stopped, kept a day so a restart of the PC never takes one up again. */
    void LoadStopped() {
      try {
        if (!dev && !Trusted.Folder(Paths.Data)) return;
        foreach (var line in File.ReadAllLines(StoppedFile)) {
          var parts = line.Split(' ');
          long at;
          if (parts.Length == 2 && long.TryParse(parts[1], out at) && DateTime.UtcNow.Ticks - at < TimeSpan.TicksPerDay) stoppedHere.Add(parts[0]);
        }
      } catch { }
    }

    readonly Dictionary<string, long> stoppedAt = new Dictionary<string, long>();
    void SaveStopped() {
      try {
        foreach (var s in stoppedHere) if (!stoppedAt.ContainsKey(s)) stoppedAt[s] = DateTime.UtcNow.Ticks;
        var lines = new List<string>();
        foreach (var kv in stoppedAt) if (DateTime.UtcNow.Ticks - kv.Value < TimeSpan.TicksPerDay) lines.Add(kv.Key + " " + kv.Value);
        File.WriteAllLines(StoppedFile, lines);
      } catch (Exception e) { Log.Write("could not save a stopped session: " + e.Message); }
    }

    public void Start() {
      cfg = Config.Load();
      id = Keys.Load(!dev);
      LoadStopped();
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
        session = s; credits = 2;
        tech = (Json.Str(m, "tech") ?? "IT").Replace('\t', ' ') + "\t" + (Json.Str(m, "ticket") ?? "").Replace('\t', ' ') + "\t" + s
          + "\t" + ((long)Json.Num(m, "since")).ToString(System.Globalization.CultureInfo.InvariantCulture) + "\t" + (Json.Bool(m, "privacy") ? "1" : "0");
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
      } else if (t == "m.privacy") {
        Tell('P', Json.Bool(m, "on") ? "1" : "0");
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
      lock (stoppedHere) { stoppedHere.Add(s); SaveStopped(); }
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
        NamedPipeServerStream p = null;
        try {
          uint console = Native.WTSGetActiveConsoleSessionId();
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
            if (!wait.Wait(15000)) { Log.Write("the worker did not connect"); lock (workerGate) { KillWorker(); } }
            else {
              pipe = p;
              if (session != null) Tell('S', tech);
              ReadWorker(p);
            }
          }
        } catch (Exception e) {
          Log.Write("worker: " + e.Message);
        } finally {
          // a pipe no worker took is never left open (one per failed start would pile up)
          if (p != null && !ReferenceEquals(p, pipe)) { try { p.Dispose(); } catch { } }
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
        } else if (type == 'R') {
          string s = session;
          if (s != null) { var d = new Dictionary<string, object>(); d["t"] = "m.privacy"; d["s"] = s; d["ok"] = false; Post(Json.Write(d)); }
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
      Banner.Note = Say;
      banner.Failed = delegate { tech = null; inputs.Enqueue(null); Send('E', Encoding.UTF8.GetBytes("The notice could not be shown on this PC, so the session stopped.")); };
      banner.PrivacyFailed = delegate { Send('R', Encoding.UTF8.GetBytes("0")); };
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
        else if (type == 'P') banner.SetPrivacy(text == "1");
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
      // the service (and the hub) hear it first; the strip goes after
      Send('E', Encoding.UTF8.GetBytes("The person at the PC pressed Stop."));
      tech = null;
      inputs.Enqueue(null);
      ThreadPool.QueueUserWorkItem(delegate { banner.Hide(); });
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
        // IT's input reaches the PC only while the notice is up and the arrival screen has been seen
        while (inputs.TryDequeue(out c)) { if (c == null) Release(); else if (tech != null && banner.Up && !Banner.Arriving) Inject(c); }
        if (tech != null && banner.Up && credits > 0 && DateTime.UtcNow >= next) {
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

    /** What the person sees while IT is connected, on this desktop for a while, without the service or the hub. */
    public static int Preview(string tech, string ticket, int seconds, bool privacy) {
      Dpi();
      var b = new Banner();
      var done = new ManualResetEventSlim(false);
      b.PrivacyFailed = delegate { Console.WriteLine("privacy screen: not kept out of capture on this PC"); };
      b.Show(tech + "\t" + ticket + "\tpreview\t0\t" + (privacy ? "1" : "0"), delegate { Console.WriteLine("Stop pressed"); done.Set(); });
      done.Wait(seconds * 1000);
      b.Hide();
      return 0;
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

  // ------------------------------------------------------------------ what the person at the PC sees
  /**
   * While IT is connected, on whatever desktop is showing (the person's, the lock or sign-in screen,
   * a UAC prompt), in the Dexterity look (deep teal, amber call to action, mono labels, the Di mark):
   *  - an arrival screen when a session starts: full screen, who from IT, with administrator rights,
   *    the ticket, OK and Stop now; a line runs down and hands over to the panel;
   *  - an amber frame around every monitor, breathing slowly, that clicks pass through;
   *  - a floating panel at the top: the Di mark, a live dot, who, for how long, the stop keys and a
   *    big Stop. It can be dragged out of the way.
   * Stop (the button or Ctrl+Alt+Shift+S) ends the session for good. Everything runs on a thread of
   * its own so it can move to another desktop (a thread with windows cannot change desktops: it is
   * made again on the new one, without the arrival screen).
   */
  class Banner {
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desk);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desk);

    readonly object gate = new object();
    Visit visit;
    string desktop = "Default";
    Form form;
    Thread thread;
    /** Sessions whose arrival screen was shown in this worker (it is shown once per session). */
    readonly HashSet<string> welcomed = new HashSet<string>();

    public class Visit { public string Tech; public string Ticket; public string Session; public DateTime Since; public Action Stop; public bool Arrive; public bool Privacy; }

    /** The notice is on screen (the panel was shown): only then may IT's capture and input run. */
    public volatile bool Up;
    /** The arrival screen is open: IT's input waits until the person has seen it. */
    public static volatile bool Arriving;
    /** The notice could not be shown at all: the session must stop. */
    public Action Failed;
    /** The privacy screen could not be kept out of IT's picture on this PC. */
    public Action PrivacyFailed;
    /** Lines for the service's log. */
    public static Action<string> Note = delegate { };

    /** "tech\tticket\tsession\tsince (ms since 1970, UTC)\tprivacy (1/0)" from the service. */
    public void Show(string payload, Action stop) {
      var p = (payload ?? "").Split('\t');
      lock (gate) {
        string session = p.Length > 2 ? p[2] : "";
        long ms;
        DateTime since = p.Length > 3 && long.TryParse(p[3], out ms) && ms > 0 ? new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms).ToLocalTime() : DateTime.Now;
        visit = new Visit {
          Tech = p[0].Length > 0 ? p[0] : "IT", Ticket = p.Length > 1 ? p[1] : "", Session = session,
          Since = since, Stop = stop, Arrive = !welcomed.Contains(session), Privacy = p.Length > 4 && p[4] == "1",
        };
        Restart();
      }
    }
    public void SetPrivacy(bool on) { lock (gate) { if (visit == null || visit.Privacy == on) return; visit.Privacy = on; Restart(); } }
    public void Hide() { lock (gate) { visit = null; Close(); } }
    public void MoveTo(string desktopName) {
      lock (gate) {
        if (desktopName == desktop && form != null) return;
        desktop = desktopName;
        if (visit != null) Restart();
      }
    }

    // called with the gate held; the UI thread never takes it, so waiting here cannot deadlock
    void Close() {
      Up = false;
      var f = form;
      var t = thread;
      form = null;
      thread = null;
      if (f != null) { try { f.BeginInvoke(new Action(delegate { f.Close(); })); } catch { } }
      if (t != null && t != Thread.CurrentThread && !t.Join(3000)) Log.Write("banner: the notice did not close in time");
    }

    void Restart() {
      Close();
      var v = visit;
      string name = desktop;
      // the arrival screen only on the person's own desktop: never over the sign-in screen or a UAC
      // prompt (it would take what is typed there); it waits until their desktop shows
      bool arrive = v.Arrive && string.Equals(name, "Default", StringComparison.OrdinalIgnoreCase);
      if (arrive) { welcomed.Add(v.Session); v.Arrive = false; }
      var ready = new ManualResetEventSlim(false);
      bool shown = false;
      Form made = null;
      Action privacyFailed = PrivacyFailed;
      var t = new Thread(delegate() {
        IntPtr d = OpenDesktop(name, 0, false, 0x10000000);
        try {
          if (d != IntPtr.Zero) SetThreadDesktop(d);
          // the privacy screen first, not owned by the panel: the panel (Stop), frame and arrival stay above it
          var covers = new List<PrivacyForm>();
          if (v.Privacy) foreach (var screen in Screen.AllScreens) { var c = new PrivacyForm(screen.Bounds, v.Tech); c.Show(); covers.Add(c); if (!c.OutOfCapture) { foreach (var x in covers) x.Close(); covers.Clear(); if (privacyFailed != null) privacyFailed(); break; } }
          var panel = new PanelForm(v);
          made = panel;
          panel.Shown += delegate { shown = true; ready.Set(); };
          panel.FormClosed += delegate { foreach (var c in covers) c.Close(); Application.ExitThread(); };
          // the frame around every monitor, owned by the panel: they close together
          foreach (var screen in Screen.AllScreens) new FrameForm(screen.Bounds).Show(panel);
          if (arrive) panel.Shown += delegate { new ArrivalForm(v, panel).Show(panel); };
          Application.Run(panel);
        } catch (Exception e) {
          Log.Write("banner: " + e.Message);
          Note("the notice could not be shown: " + e.Message);
        } finally {
          ready.Set();
          if (d != IntPtr.Zero) CloseDesktop(d);
        }
      });
      t.SetApartmentState(ApartmentState.STA);
      t.IsBackground = true;
      t.Start();
      ready.Wait(5000);
      form = made;
      thread = t;
      Up = shown;
      // the person must be able to see that IT is there: if the notice cannot be shown, IT stops
      if (!shown && Failed != null) Failed();
    }

    // ---------------------------------------------------------------- look
    static class Look {
      public static readonly Color Ink = Color.FromArgb(0x13, 0x2b, 0x2e);       // teal-900
      public static readonly Color Deep = Color.FromArgb(0x14, 0x3f, 0x45);      // teal-800
      public static readonly Color Teal = Color.FromArgb(0x2a, 0x8c, 0x98);      // brand teal
      public static readonly Color Mist = Color.FromArgb(0xcf, 0xe6, 0xe8);      // teal-100
      public static readonly Color Paper = Color.FromArgb(0xf6, 0xfa, 0xfa);
      public static readonly Color Amber = Color.FromArgb(0xf7, 0xaf, 0x44);     // brand amber
      public static readonly Color AmberHi = Color.FromArgb(0xff, 0xc4, 0x6b);
      public static readonly Color Red = Color.FromArgb(0xb2, 0x36, 0x28);
      static Image mark;
      public static Image Mark {
        get {
          if (mark == null) {
            try { using (var s = typeof(Look).Assembly.GetManifestResourceStream("DexSupport.di.png")) if (s != null) mark = Image.FromStream(s); } catch { }
          }
          return mark;
        }
      }
      /** Screen scaling (1 at 100 %, 1.5 at 150 %): every size below is in 96-dpi units, drawn through it. */
      static float k;
      public static float K { get { if (k == 0) { try { using (var g = Graphics.FromHwnd(IntPtr.Zero)) k = Math.Max(1f, g.DpiX / 96f); } catch { k = 1f; } } return k; } }
      public static int Px(float v) { return (int)Math.Round(v * K); }
      // fonts in pixels (of 96-dpi units), so the one scale transform sizes them with everything else
      static Font Make(string name, float pt) { return new Font(name, pt * 96f / 72f, FontStyle.Regular, GraphicsUnit.Pixel); }
      public static Font Light(float size) { return Make("Segoe UI Light", size); }
      public static Font Body(float size, bool bold) { return Make(bold ? "Segoe UI Semibold" : "Segoe UI", size); }
      public static Font Mono(float size) { return Make("Consolas", size); }
      public static GraphicsPath Round(RectangleF r, float radius) {
        var p = new GraphicsPath();
        float d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
      }
      public static void Smooth(Graphics g) { g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit; g.InterpolationMode = InterpolationMode.HighQualityBicubic; }
      public static string Elapsed(DateTime since) {
        var t = DateTime.Now - since;
        return t.TotalHours >= 1 ? string.Format("{0}:{1:00}:{2:00}", (int)t.TotalHours, t.Minutes, t.Seconds) : string.Format("{0:00}:{1:00}", t.Minutes, t.Seconds);
      }
    }

    /** A window that never takes the focus from what the person (or IT) is typing in. */
    class QuietForm : Form {
      protected bool ClickThrough;
      public QuietForm() {
        FormBorderStyle = FormBorderStyle.None; TopMost = true; ShowInTaskbar = false; StartPosition = FormStartPosition.Manual;
        DoubleBuffered = true;
      }
      protected override CreateParams CreateParams {
        get {
          var p = base.CreateParams;
          p.ExStyle |= 0x00000008 /* TOPMOST */ | 0x00000080 /* TOOLWINDOW */ | 0x08000000 /* NOACTIVATE */;
          if (ClickThrough) p.ExStyle |= 0x00080000 /* LAYERED */ | 0x00000020 /* TRANSPARENT */;
          return p;
        }
      }
      protected override bool ShowWithoutActivation { get { return true; } }
    }

    // ---------------------------------------------------------------- the amber frame
    class FrameForm : QuietForm {
      readonly int W = Look.Px(6);
      readonly System.Windows.Forms.Timer breath = new System.Windows.Forms.Timer { Interval = 80 };
      double phase;
      public FrameForm(Rectangle bounds) {
        ClickThrough = true;
        Bounds = bounds;
        BackColor = Color.Magenta; TransparencyKey = Color.Magenta;
        breath.Tick += delegate {
          phase += 0.08;
          // only the edges are painted again
          Invalidate(new Rectangle(0, 0, Width, W + 2)); Invalidate(new Rectangle(0, Height - W - 2, Width, W + 2));
          Invalidate(new Rectangle(0, 0, W + 2, Height)); Invalidate(new Rectangle(Width - W - 2, 0, W + 2, Height));
        };
        breath.Start();
        FormClosed += delegate { breath.Dispose(); };
      }
      protected override void OnPaint(PaintEventArgs e) {
        // a slow breath between brand amber and a lighter amber: alive, never flashing
        double k = (Math.Sin(phase) + 1) / 2;
        var c = Color.FromArgb((int)(Look.Amber.R + (Look.AmberHi.R - Look.Amber.R) * k), (int)(Look.Amber.G + (Look.AmberHi.G - Look.Amber.G) * k), (int)(Look.Amber.B + (Look.AmberHi.B - Look.Amber.B) * k));
        using (var b = new SolidBrush(c)) {
          e.Graphics.FillRectangle(b, 0, 0, Width, W);
          e.Graphics.FillRectangle(b, 0, Height - W, Width, W);
          e.Graphics.FillRectangle(b, 0, 0, W, Height);
          e.Graphics.FillRectangle(b, Width - W, 0, W, Height);
        }
        // a teal hairline inside the amber: the brand's title-block edge
        using (var pen = new Pen(Look.Ink, 1)) e.Graphics.DrawRectangle(pen, W, W, Width - 2 * W - 1, Height - 2 * W - 1);
      }
    }

    // ---------------------------------------------------------------- the floating panel
    class PanelForm : QuietForm {
      [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hwnd, int id, uint mods, uint vk);
      readonly Visit v;
      readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer { Interval = 50 };
      readonly Font who = Look.Body(12f, true), meta = Look.Mono(8.5f), button = Look.Body(11f, true), tag = Look.Mono(7.5f);
      Rectangle stopRect;
      bool hover, down;
      Point drag;
      bool dragging;
      double pulse;

      const int LW = 620, LH = 78;
      public PanelForm(Visit v) {
        this.v = v;
        Width = Look.Px(LW); Height = Look.Px(LH);
        var s = Screen.PrimaryScreen.Bounds;
        Left = s.Left + (s.Width - Width) / 2; Top = s.Top + Look.Px(18);
        BackColor = Look.Ink;
        using (var path = Look.Round(new RectangleF(0, 0, Width, Height), Look.K * 16)) Region = new Region(path);
        stopRect = new Rectangle(LW - 136, 16, 120, 46);
        tick.Tick += delegate { pulse += 0.12; Invalidate(); };
        tick.Start();
        FormClosed += delegate { tick.Dispose(); };
      }

      void Fire() { var a = v.Stop; if (a != null) a(); }

      protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        if (!RegisterHotKey(Handle, 1, 0x0001 | 0x0002 | 0x0004 | 0x4000 /* Alt Ctrl Shift NoRepeat */, 0x53 /* S */))
          Note("Ctrl+Alt+Shift+S is taken by another program on this desktop; Stop on the panel still works");
      }
      protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0312 /* WM_HOTKEY */) Fire();
        base.WndProc(ref m);
      }

      static Point L(MouseEventArgs e) { return new Point((int)(e.X / Look.K), (int)(e.Y / Look.K)); }
      protected override void OnMouseMove(MouseEventArgs e) {
        bool h = stopRect.Contains(L(e));
        if (h != hover) { hover = h; Cursor = h ? Cursors.Hand : Cursors.SizeAll; Invalidate(); }
        if (dragging) {
          // moved out of the way, never off the screen: the panel and its Stop stay in view
          var b = Screen.FromPoint(Cursor.Position).Bounds;
          Left = Math.Max(b.Left, Math.Min(b.Right - Width, Left + e.X - drag.X));
          Top = Math.Max(b.Top, Math.Min(b.Bottom - Height, Top + e.Y - drag.Y));
        }
      }
      protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); }
      protected override void OnMouseDown(MouseEventArgs e) {
        if (stopRect.Contains(L(e))) { down = true; Invalidate(); return; }
        dragging = true; drag = e.Location;
      }
      protected override void OnMouseUp(MouseEventArgs e) {
        dragging = false;
        if (down && stopRect.Contains(L(e))) Fire();
        down = false; Invalidate();
      }

      protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        Look.Smooth(g);
        g.ScaleTransform(Look.K, Look.K);
        // the panel: deep teal, a hairline, an amber edge on the left (the brand's call to action)
        using (var bg = new LinearGradientBrush(new Rectangle(0, 0, LW, LH), Look.Deep, Look.Ink, LinearGradientMode.Vertical)) g.FillRectangle(bg, 0, 0, LW, LH);
        using (var edge = new SolidBrush(Look.Amber)) g.FillRectangle(edge, 0, 0, 6, LH);
        using (var path = Look.Round(new RectangleF(0.5f, 0.5f, LW - 1, LH - 1), 16)) using (var pen = new Pen(Color.FromArgb(110, Look.Amber), 1)) g.DrawPath(pen, path);
        // the Di mark
        var mark = Look.Mark;
        if (mark != null) g.DrawImage(mark, new Rectangle(20, 15, 48, 48));
        // the live dot, breathing
        double k = (Math.Sin(pulse) + 1) / 2;
        int halo = (int)(8 + 6 * k);
        using (var b = new SolidBrush(Color.FromArgb((int)(70 * (1 - k)) + 20, Look.Amber))) g.FillEllipse(b, 88 - halo / 2f, 22 - halo / 2f, halo, halo);
        using (var b = new SolidBrush(Look.Amber)) g.FillEllipse(b, 84, 18, 8, 8);
        using (var b = new SolidBrush(Look.Amber)) g.DrawString("LIVE \u00b7 IT SUPPORT \u00b7 ADMINISTRATOR RIGHTS", tag, b, 98, 14);
        using (var b = new SolidBrush(Look.Paper)) g.DrawString(v.Tech + " from IT is connected to this PC", who, b, 80, 30);
        string line = (v.Ticket.Length > 0 ? v.Ticket + "  \u00b7  " : "") + Look.Elapsed(v.Since) + "  \u00b7  Stop: Ctrl+Alt+Shift+S";
        using (var b = new SolidBrush(Look.Mist)) g.DrawString(line.ToUpperInvariant(), meta, b, 82, 55);
        // Stop: the big amber button
        var r = new RectangleF(stopRect.X, stopRect.Y, stopRect.Width, stopRect.Height);
        using (var path = Look.Round(r, 10))
        using (var b = new SolidBrush(down ? Look.Amber : hover ? Look.AmberHi : Look.Amber)) {
          g.FillPath(b, path);
          if (hover) using (var pen = new Pen(Look.Paper, 2)) g.DrawPath(pen, path);
        }
        using (var b = new SolidBrush(Look.Ink)) {
          var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
          g.DrawString("\u25a0  Stop", button, b, r, sf);
        }
      }
    }

    // ---------------------------------------------------------------- the privacy screen
    /**
     * Over a whole monitor while IT works privately: the person sees "IT is working on this PC", IT's
     * picture shows what is underneath (the window is kept out of screen capture). Clicks pass
     * through, so IT's input reaches the apps. Shown only where Windows can keep it out of capture.
     */
    class PrivacyForm : QuietForm {
      [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
      readonly string tech;
      readonly Font tag = Look.Mono(10f), head = Look.Light(30f), body = Look.Body(13f, false);
      public bool OutOfCapture;
      public PrivacyForm(Rectangle bounds, string tech) {
        this.tech = tech;
        ClickThrough = true;
        Bounds = bounds; BackColor = Look.Ink; Opacity = 0.97;
      }
      protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        // WDA_EXCLUDEFROMCAPTURE (Windows 10 2004 and later): never in IT's picture
        OutOfCapture = SetWindowDisplayAffinity(Handle, 0x11);
      }
      protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        Look.Smooth(g);
        g.ScaleTransform(Look.K, Look.K);
        float lw = Width / Look.K, lh = Height / Look.K;
        using (var pen = new Pen(Color.FromArgb(18, Look.Mist), 1)) {
          for (int x = 0; x < lw; x += 48) g.DrawLine(pen, x, 0, x, lh);
          for (int y = 0; y < lh; y += 48) g.DrawLine(pen, 0, y, lw, y);
        }
        float cw = Math.Min(720, lw - 80), x0 = (lw - cw) / 2, y0 = lh / 2 - 130;
        using (var path = Look.Round(new RectangleF(x0 - 48, y0 - 44, cw + 96, 300), 22)) {
          using (var b = new SolidBrush(Look.Deep)) g.FillPath(b, path);
          using (var pen = new Pen(Color.FromArgb(140, Look.Amber), 1.5f)) g.DrawPath(pen, path);
        }
        using (var b = new SolidBrush(Look.Amber)) g.DrawString("DEXTERITY CONNECT  \u00b7  IT SUPPORT  \u00b7  PRIVACY SCREEN", tag, b, x0, y0);
        using (var b = new SolidBrush(Look.Paper)) g.DrawString(tech + " from IT is working on this PC", head, b, new RectangleF(x0, y0 + 28, cw, 100));
        using (var b = new SolidBrush(Look.Mist))
          g.DrawString("They asked for the screen to be covered while they work, so this is what you see. Please carry on with something else; your screen comes back when they finish. You can stop it at any time: Stop on the panel at the top, or Ctrl+Alt+Shift+S.", body, b, new RectangleF(x0, y0 + 136, cw, 110));
      }
    }

    // ---------------------------------------------------------------- the other monitors, while the arrival screen shows
    class DimForm : QuietForm {
      readonly string tech;
      readonly Font big = Look.Light(20f), label = Look.Mono(9.5f);
      public DimForm(Rectangle bounds, string tech) {
        this.tech = tech;
        Bounds = bounds; BackColor = Look.Ink; Opacity = 0.93;
      }
      protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        Look.Smooth(g);
        g.ScaleTransform(Look.K, Look.K);
        float lw = Width / Look.K, lh = Height / Look.K;
        var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        using (var b = new SolidBrush(Look.Amber)) g.DrawString("DEXTERITY CONNECT  \u00b7  IT SUPPORT", label, b, new RectangleF(0, lh / 2 - 44, lw, 20), sf);
        using (var b = new SolidBrush(Look.Paper)) g.DrawString(tech + " from IT is connecting. See your main screen.", big, b, new RectangleF(40, lh / 2 - 20, lw - 80, 60), sf);
      }
    }

    // ---------------------------------------------------------------- the arrival screen
    class ArrivalForm : QuietForm {
      const int Seconds = 12;
      readonly Visit v;
      readonly PanelForm panel;
      readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer { Interval = 30 };
      readonly DateTime opened = DateTime.Now;
      readonly Font label = Look.Mono(10f), head = Look.Light(30f), body = Look.Body(13f, false), button = Look.Body(12.5f, true), small = Look.Mono(9f);
      Rectangle card, ok, stop;
      readonly int lw, lh;
      int hover; // 1 ok, 2 stop
      double flow;

      public ArrivalForm(Visit v, PanelForm panel) {
        this.v = v; this.panel = panel;
        var s = Screen.PrimaryScreen.Bounds;
        Bounds = s;
        BackColor = Look.Ink;
        Opacity = 0.97;
        // layout in 96-dpi units over the screen's size in those units
        lw = (int)(s.Width / Look.K); lh = (int)(s.Height / Look.K);
        int cw = Math.Min(780, lw - 80), ch = 470;
        card = new Rectangle((lw - cw) / 2, (lh - ch) / 2, cw, ch);
        ok = new Rectangle(card.X + 56, card.Bottom - 108, 220, 56);
        stop = new Rectangle(ok.Right + 16, ok.Y, 180, 56);
        // the other monitors go dark too, pointing here
        Shown += delegate { foreach (var other in Screen.AllScreens) if (!other.Primary) new DimForm(other.Bounds, v.Tech).Show(this); };
        KeyPreview = true;
        tick.Tick += delegate {
          flow += 0.03;
          if ((DateTime.Now - opened).TotalSeconds >= Seconds) { Close(); return; }
          Invalidate();
        };
        tick.Start();
        FormClosed += delegate { tick.Dispose(); };
      }

      // this one may take the keyboard: Enter is OK, Escape is OK too (Stop needs a deliberate click)
      // it never takes the keyboard (what the person or IT types stays where it was): OK and Stop are clicked
      protected override void OnShown(EventArgs e) { base.OnShown(e); Arriving = true; }
      protected override void OnFormClosed(FormClosedEventArgs e) { Arriving = false; base.OnFormClosed(e); }
      static Point L(MouseEventArgs e) { return new Point((int)(e.X / Look.K), (int)(e.Y / Look.K)); }
      protected override void OnMouseMove(MouseEventArgs e) {
        int h = ok.Contains(L(e)) ? 1 : stop.Contains(L(e)) ? 2 : 0;
        if (h != hover) { hover = h; Cursor = h != 0 ? Cursors.Hand : Cursors.Default; Invalidate(); }
      }
      protected override void OnMouseUp(MouseEventArgs e) {
        if (ok.Contains(L(e))) Close();
        else if (stop.Contains(L(e))) { var a = v.Stop; Close(); if (a != null) a(); }
      }

      protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        Look.Smooth(g);
        g.ScaleTransform(Look.K, Look.K);
        // a faint grid of the drawing office behind it all (the brand's hairlines)
        using (var pen = new Pen(Color.FromArgb(18, Look.Mist), 1)) {
          for (int x = 0; x < lw; x += 48) g.DrawLine(pen, x, 0, x, lh);
          for (int gy = 0; gy < lh; gy += 48) g.DrawLine(pen, 0, gy, lw, gy);
        }
        // the card
        var c = new RectangleF(card.X, card.Y, card.Width, card.Height);
        using (var path = Look.Round(c, 22)) {
          using (var b = new LinearGradientBrush(card, Look.Deep, Look.Ink, LinearGradientMode.ForwardDiagonal)) g.FillPath(b, path);
          using (var pen = new Pen(Color.FromArgb(120, Look.Amber), 1.5f)) g.DrawPath(pen, path);
        }
        int x0 = card.X + 56, y = card.Y + 48;
        var mark = Look.Mark;
        if (mark != null) g.DrawImage(mark, new Rectangle(x0, y, 64, 64));
        using (var b = new SolidBrush(Look.Amber)) g.DrawString("DEXTERITY CONNECT  \u00b7  IT SUPPORT  \u00b7  ADMINISTRATOR RIGHTS", label, b, x0 + 84, y + 8);
        using (var b = new SolidBrush(Look.Mist)) g.DrawString((v.Ticket.Length > 0 ? "TICKET " + v.Ticket + "  \u00b7  " : "") + "RECORDED IN THE AUDIT LOG", small, b, x0 + 84, y + 34);
        y += 92;
        // the headline is measured, so a long name never runs into the words below it
        string title = v.Tech + " from IT is connecting to this PC";
        var th = g.MeasureString(title, head, card.Width - 112);
        using (var b = new SolidBrush(Look.Paper)) g.DrawString(title, head, b, new RectangleF(x0, y, card.Width - 112, th.Height + 4));
        y += (int)th.Height + 20;
        using (var pen = new Pen(Color.FromArgb(70, Look.Mist), 1)) g.DrawLine(pen, x0, y - 10, x0 + 120, y - 10);
        using (var b = new SolidBrush(Look.Mist))
          g.DrawString("They will see your screen and can use the mouse and keyboard, including administrator windows and Windows security prompts. You can stop it at any time: Stop on the panel at the top, or Ctrl+Alt+Shift+S.", body, b, new RectangleF(x0, y, card.Width - 112, ok.Y - y - 12));
        // OK and Stop now
        DrawButton(g, ok, "OK, carry on", hover == 1, true);
        DrawButton(g, stop, "Stop now", hover == 2, false);
        // the line of flow: runs from left to right while the notice counts down
        double left = Math.Max(0, 1 - (DateTime.Now - opened).TotalSeconds / Seconds);
        int run = (int)((card.Width - 112) * left);
        using (var b = new SolidBrush(Color.FromArgb(50, Look.Mist))) g.FillRectangle(b, x0, card.Bottom - 30, card.Width - 112, 3);
        using (var b = new LinearGradientBrush(new Rectangle(x0, card.Bottom - 30, Math.Max(1, run), 3), Look.Teal, Look.Amber, LinearGradientMode.Horizontal)) g.FillRectangle(b, x0, card.Bottom - 30, run, 3);
        using (var b = new SolidBrush(Color.FromArgb(160, Look.Mist))) g.DrawString("THIS NOTICE MOVES TO THE PANEL AT THE TOP IN " + Math.Ceiling(left * Seconds) + " S", small, b, x0, card.Bottom - 24);
      }

      void DrawButton(Graphics g, Rectangle r, string text, bool hot, bool primary) {
        using (var path = Look.Round(new RectangleF(r.X, r.Y, r.Width, r.Height), 12)) {
          if (primary) using (var b = new SolidBrush(hot ? Look.AmberHi : Look.Amber)) g.FillPath(b, path);
          else using (var b = new SolidBrush(hot ? Color.FromArgb(60, Look.Red) : Color.FromArgb(0, 0, 0, 0))) g.FillPath(b, path);
          if (!primary) using (var pen = new Pen(hot ? Look.Paper : Look.Mist, 1.5f)) g.DrawPath(pen, path);
        }
        using (var b = new SolidBrush(primary ? Look.Ink : Look.Paper)) {
          var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
          g.DrawString(text, button, b, new RectangleF(r.X, r.Y, r.Width, r.Height), sf);
        }
      }
    }
  }
}
