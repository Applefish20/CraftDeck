using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace CraftDeckLite
{
    /// <summary>
    /// CraftDeck 轻量启动器：启动内置的本地服务，然后用 Edge 的应用窗口模式显示界面。
    /// 不依赖 Electron，体积小、启动快；仍然需要本机安装 Node.js。
    /// </summary>
    static class Program
    {
        static Process serverProcess;
        static NotifyIcon tray;
        static string baseDir;
        static string logFile;
        static int port = 25555;
        static bool exiting = false;

        [STAThread]
        static void Main()
        {
            baseDir = AppDomain.CurrentDomain.BaseDirectory;
            try { File.WriteAllText(Path.Combine(baseDir, "lite-boot.txt"), DateTime.Now.ToString("s")); } catch { }
            try { Directory.CreateDirectory(Path.Combine(baseDir, "logs")); } catch { }
            logFile = Path.Combine(baseDir, "logs", "lite.log");
            Log("---- CraftDeck Lite start " + DateTime.Now.ToString("s") + " ----");
            Application.ThreadException += (s, e) => Fail(e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => Fail(e.ExceptionObject as Exception);
            try
            {
                Run();
            }
            catch (Exception e)
            {
                Fail(e);
            }
        }

        static void Run()
        {
            bool created;
            using (var mutex = new Mutex(true, "CraftDeckLite.SingleInstance", out created))
            {
                if (!created)
                {
                    MessageBox.Show("CraftDeck 已经在运行了。\n请查看任务栏右下角的托盘图标。", "CraftDeck",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                port = FindFreePort(25555);
                StartServer();
                if (!WaitHealthy(25000))
                {
                    throw new Exception("本地服务启动超时。\n\n请确认已安装 Node.js 18 或更高版本，并查看：\n"
                        + logFile);
                }
                OpenUi();
                SetupTray();
                Application.Run();
            }
        }

        static void Fail(Exception e)
        {
            Log("ERROR " + (e == null ? "unknown" : e.ToString()));
            try
            {
                MessageBox.Show((e == null ? "未知错误" : e.Message) + "\n\n日志文件：\n" + logFile,
                    "CraftDeck 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch { }
            ExitApp();
        }

        static void Log(string line)
        {
            try { File.AppendAllText(logFile, "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line + "\r\n", Encoding.UTF8); }
            catch { }
        }

        static string FindNode()
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string dir in path.Split(';'))
            {
                if (dir.Trim().Length == 0) continue;
                try
                {
                    string exe = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(exe)) return exe;
                }
                catch { }
            }
            string[] known = {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe")
            };
            foreach (string p in known) if (File.Exists(p)) return p;
            return null;
        }

        static int FindFreePort(int start)
        {
            for (int p = start; p < start + 20; p++)
            {
                try
                {
                    var listener = new TcpListener(IPAddress.Loopback, p);
                    listener.Start();
                    listener.Stop();
                    return p;
                }
                catch { }
            }
            return start;
        }

        static void StartServer()
        {
            string node = FindNode();
            if (node == null)
            {
                throw new Exception("没有找到 Node.js。\n\n请先安装 Node.js 18 或更高版本：\nhttps://nodejs.org/\n\n安装后重新双击本程序。");
            }
            Log("node=" + node + " port=" + port);
            var psi = new ProcessStartInfo(node, "server\\server.mjs --port=" + port)
            {
                WorkingDirectory = baseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            serverProcess = new Process();
            serverProcess.StartInfo = psi;
            serverProcess.EnableRaisingEvents = true;
            serverProcess.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) Log("OUT " + e.Data);
            };
            serverProcess.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
            {
                if (e.Data != null) Log("ERR " + e.Data);
            };
            serverProcess.Exited += delegate
            {
                if (!exiting)
                {
                    Log("server exited code=" + serverProcess.ExitCode);
                    try
                    {
                        if (tray != null)
                            tray.ShowBalloonTip(5000, "CraftDeck", "本地服务已退出，请重新启动。", ToolTipIcon.Warning);
                    }
                    catch { }
                }
            };
            serverProcess.Start();
            serverProcess.BeginOutputReadLine();
            serverProcess.BeginErrorReadLine();
        }

        static bool WaitHealthy(int timeoutMs)
        {
            int waited = 0;
            while (waited < timeoutMs)
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
                    req.Timeout = 1500;
                    req.Proxy = null;
                    using (var res = (HttpWebResponse)req.GetResponse())
                    using (var reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    {
                        string body = reader.ReadToEnd();
                        if (body.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0) return true;
                    }
                }
                catch { }
                Thread.Sleep(400);
                waited += 400;
            }
            return false;
        }

        static string FindEdge()
        {
            string[] candidates = {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
            };
            foreach (string p in candidates) if (File.Exists(p)) return p;
            return null;
        }

        static void OpenUi()
        {
            string url = "http://127.0.0.1:" + port + "/";
            string browser = FindEdge();
            try
            {
                if (browser != null)
                {
                    var psi = new ProcessStartInfo(browser,
                        "--app=" + url + " --window-size=1320,900 --window-position=120,60");
                    psi.UseShellExecute = false;
                    Process.Start(psi);
                }
                else
                {
                    Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                }
                Log("opened UI " + url);
            }
            catch (Exception e)
            {
                Log("open UI failed: " + e.Message);
                try
                {
                    Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                }
                catch (Exception e2)
                {
                    Log("open default browser failed: " + e2.Message);
                    try
                    {
                        if (tray != null) tray.ShowBalloonTip(8000, "CraftDeck", "请手动在浏览器打开：" + url, ToolTipIcon.Info);
                    }
                    catch { }
                    MessageBox.Show("界面无法自动打开，请手动在浏览器访问：\n\n" + url, "CraftDeck",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
        }

        static void SetupTray()
        {
            tray = new NotifyIcon();
            tray.Icon = SystemIcons.Application;
            tray.Text = "CraftDeck 启动器";
            tray.Visible = true;
            var menu = new ContextMenu();
            menu.MenuItems.Add("打开界面", delegate { OpenUi(); });
            menu.MenuItems.Add("打开数据目录", delegate
            {
                try { Process.Start("explorer.exe", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "CraftDeck")); }
                catch { }
            });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("退出", delegate { ExitApp(); });
            tray.ContextMenu = menu;
            tray.DoubleClick += delegate { OpenUi(); };
        }

        static void ExitApp()
        {
            if (exiting) return;
            exiting = true;
            try { if (tray != null) { tray.Visible = false; tray.Dispose(); } } catch { }
            try
            {
                if (serverProcess != null && !serverProcess.HasExited)
                {
                    serverProcess.Kill();
                }
            }
            catch { }
            Log("exit");
            Application.Exit();
        }
    }
}
