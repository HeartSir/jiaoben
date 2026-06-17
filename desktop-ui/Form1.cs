using System.Diagnostics;
using System.Drawing;
using System.IO.Compression;
using System.Net;
using Microsoft.Web.WebView2.Core;

namespace VenueBookingUI;

public partial class Form1 : Form
{
    private Process? _serverProcess;
    private bool _closing;
    private readonly Panel _loadingPanel;
    private readonly Label _stepLabel;       // 主状态（大号，居中）
    private readonly Label _detailLabel;     // 副状态（中号，居中，多行）
    private readonly Label _errorLabel;      // 错误信息（底部，红色）
    private readonly Button _browserBtn;     // "在浏览器中打开"
    private System.Windows.Forms.Timer? _hideTimer;
    private bool _panelShown;
    private bool _webViewOk;

    private const string CHROMIUM_REVISION = "1228";
    private static readonly string PLAYWRIGHT_DIR =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                     "AppData", "Local", "ms-playwright");

    private static readonly string LOG_FILE =
        Path.Combine(Path.GetTempPath(), "venue-booking-debug.log");

    // ===================================================================
    // Constructor
    // ===================================================================

    public Form1()
    {
        InitializeComponent();
        SetAppIcon();
        Log("=== Form1 constructor ===");

        // ----- Loading Panel (Dock Fill, covers WebView2) -----
        _loadingPanel = new Panel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.FromArgb(242, 244, 248),
        };

        // Main step label (large, bold, centered)
        _stepLabel = new Label
        {
            Text = "🏸 正在启动抢场服务...",
            Font = new Font("Microsoft YaHei", 18, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleCenter,
            Dock = DockStyle.Fill,
            ForeColor = Color.FromArgb(51, 51, 51),
            BackColor = Color.Transparent,
            Padding = new Padding(40, 0, 40, 40),
        };

        // Detail label (medium, wraps, centered, sits on top of stepLabel via panel)
        _detailLabel = new Label
        {
            Text = "",
            Font = new Font("Microsoft YaHei", 11),
            TextAlign = ContentAlignment.MiddleCenter,
            Location = new Point(0, 0),
            Size = new Size(1200, 800),
            ForeColor = Color.FromArgb(120, 120, 120),
            BackColor = Color.Transparent,
            Padding = new Padding(40, 0, 40, 80),
        };
        _detailLabel.Click += (_, _) => RetryStartServer();

        // Error label (bottom, red)
        _errorLabel = new Label
        {
            Text = "",
            Font = new Font("Microsoft YaHei", 10),
            TextAlign = ContentAlignment.MiddleCenter,
            Dock = DockStyle.Bottom,
            Height = 50,
            ForeColor = Color.FromArgb(198, 40, 40),
            BackColor = Color.Transparent,
        };
        _errorLabel.Click += (_, _) => RetryStartServer();

        // Browser fallback button
        _browserBtn = new Button
        {
            Text = "🌐 在浏览器中打开面板",
            Font = new Font("Microsoft YaHei", 10),
            FlatStyle = FlatStyle.Flat,
            ForeColor = Color.FromArgb(51, 51, 51),
            BackColor = Color.FromArgb(230, 232, 238),
            FlatAppearance = { BorderColor = Color.FromArgb(180, 180, 190) },
            Size = new Size(200, 34),
            Visible = false,
            Cursor = Cursors.Hand,
        };
        _browserBtn.Click += (_, _) => OpenBrowser();
        // Position at bottom-center
        _browserBtn.Location = new Point((ClientSize.Width - 200) / 2, ClientSize.Height - 120);
        Resize += (_, _) =>
        {
            _browserBtn.Location = new Point((ClientSize.Width - 200) / 2, ClientSize.Height - 120);
        };

        // Assemble loading panel
        _loadingPanel.Controls.Add(_stepLabel);
        _loadingPanel.Controls.Add(_detailLabel);
        _loadingPanel.Controls.Add(_errorLabel);

        // Z-order: webView (bottom) → loadingPanel → browserBtn (top)
        Controls.Add(_loadingPanel);
        Controls.Add(_browserBtn);
        _loadingPanel.BringToFront();
        _browserBtn.BringToFront();

        // 🔑 Keep WebView2 visible and at bottom — never hide it
        webView.Visible = true;
        webView.SendToBack();

        // Events
        webView.NavigationCompleted += OnNavigationCompleted;

        Shown += OnShown;
        FormClosing += OnFormClosing;
    }

    // ===================================================================
    // Debug logging
    // ===================================================================

    private void Log(string msg)
    {
        try { File.AppendAllText(LOG_FILE, $"[{DateTime.Now:HH:mm:ss.fff}] {msg}\n"); }
        catch { }
        Debug.WriteLine(msg);
    }

    // ===================================================================
    // UI helpers — show clear progress on the loading panel
    // ===================================================================

    private enum AppStep
    {
        Starting,
        WebView2Check,
        NodeDownload,
        ChromiumDownload,
        Launching,
        ServerReady,
        PanelLoading,
        Done,
        Error,
    }

    private AppStep _currentStep;
    private string _currentAction = "";

    private void SetStep(AppStep step, string main, string? detail = null, string? error = null, bool showBrowserBtn = false)
    {
        _currentStep = step;
        _currentAction = main;

        if (InvokeRequired)
        {
            BeginInvoke(() => SetStep(step, main, detail, error, showBrowserBtn));
            return;
        }

        _stepLabel.Text = main;
        _detailLabel.Text = detail ?? "";
        _errorLabel.Text = error ?? "";
        if (error != null) _errorLabel.ForeColor = Color.FromArgb(198, 40, 40);
        _browserBtn.Visible = showBrowserBtn;
        _browserBtn.BringToFront();
        Refresh();
        Log($"STEP [{step}]: {main} | {detail} | err:{error}");
    }

    // ===================================================================
    // Form events
    // ===================================================================

    private void OnShown(object? sender, EventArgs e)
    {
        Log("Form Shown");
        BeginInvoke(() => StartServer());
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        _closing = true;
        _hideTimer?.Dispose();
        KillServer();
    }

    // ===================================================================
    // Main startup pipeline
    // ===================================================================

    private void StartServer()
    {
        _panelShown = false;
        _webViewOk = false;
        _loadingPanel.Visible = true;
        _loadingPanel.BringToFront();
        _browserBtn.Visible = false;

        SetStep(AppStep.Starting, "🏸 正在启动抢场服务...");

        // ---- Step 1: Check WebView2 Runtime ----
        CheckWebView2Runtime();
    }

    private void RetryStartServer()
    {
        Log("RetryStartServer");
        KillServer();
        StartServer();
    }

    // ===================================================================
    // Step 1: WebView2 Runtime check
    // ===================================================================

    private void CheckWebView2Runtime()
    {
        SetStep(AppStep.WebView2Check, "🔍 检测系统环境...", "检查 WebView2 运行环境");

        try
        {
            string? ver = CoreWebView2Environment.GetAvailableBrowserVersionString();
            Log($"WebView2 Runtime 已安装: {ver}");
            _webViewOk = true;
            // Continue to Node.js check
            CheckNodeJs();
        }
        catch (Exception ex)
        {
            Log($"WebView2 Runtime 未安装: {ex.Message}");
            _webViewOk = false;
            SetStep(AppStep.WebView2Check,
                "⚠️ 未检测到 WebView2 运行环境",
                "面板将自动在浏览器中打开\n\n你也可以手动安装 WebView2 以获得内置面板体验\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703",
                showBrowserBtn: true);

            // Still try to start the server — at least the browser will work
            CheckNodeJs();
        }
    }

    // ===================================================================
    // Step 2: Node.js
    // ===================================================================

    private void CheckNodeJs()
    {
        SetStep(AppStep.Starting, "🏸 正在启动抢场服务...", "检查 Node.js 运行环境");

        try
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string? nodeExe = FindNodeExe(baseDir);
            if (nodeExe == null)
            {
                SetStep(AppStep.NodeDownload, "📥 正在下载 Node.js...",
                    "首次运行需要下载约 36MB\n请耐心等待，下载完成后会自动解压", "");
                Refresh();
                _ = DownloadNodeAsync(baseDir);
                return;
            }
            Log($"Node.js found: {nodeExe}");
            CheckChromium(baseDir, nodeExe);
        }
        catch (Exception ex)
        {
            Log($"CheckNodeJs error: {ex}");
            SetStep(AppStep.Error, "❌ 启动失败", "", $"错误: {ex.Message}\n点击任意位置重试", showBrowserBtn: true);
        }
    }

    private string? FindNodeExe(string baseDir)
    {
        // 1. Check bundled portable node
        string nodePath = Path.Combine(baseDir, "node-portable", "node.exe");
        if (File.Exists(nodePath))
        {
            Log($"Bundled portable node: {nodePath}");
            return nodePath;
        }

        // 2. Check system node
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "--version",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var proc = Process.Start(psi);
            if (proc != null && proc.WaitForExit(5000) && proc.ExitCode == 0)
            {
                string v = proc.StandardOutput.ReadToEnd().Trim();
                Log($"System node: {v}");
                return "node";
            }
        }
        catch (Exception ex) { Log($"System node check failed: {ex.Message}"); }

        return null;
    }

    private async Task DownloadNodeAsync(string baseDir)
    {
        try
        {
            string url = "https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip";
            string zipPath = Path.Combine(Path.GetTempPath(), "node-portable.zip");
            string targetDir = Path.Combine(baseDir, "node-portable");

            using var client = MakeHttpClient(TimeSpan.FromMinutes(10));
            using var resp = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            resp.EnsureSuccessStatusCode();

            long total = resp.Content.Headers.ContentLength ?? 36 * 1024 * 1024;
            using var s = await resp.Content.ReadAsStreamAsync();
            using var fs = new FileStream(zipPath, FileMode.Create, FileAccess.Write);
            var buf = new byte[32768];
            long read = 0;
            int n, lastPct = -1;
            while ((n = await s.ReadAsync(buf, 0, buf.Length)) > 0)
            {
                await fs.WriteAsync(buf, 0, n);
                read += n;
                if (_closing) return;
                if (total > 0)
                {
                    int pct = (int)(read * 100 / total);
                    if (pct != lastPct)
                    {
                        lastPct = pct;
                        BeginInvoke(() => SetStep(AppStep.NodeDownload,
                            "📥 正在下载 Node.js...",
                            $"已下载 {read / 1024 / 1024}MB / {total / 1024 / 1024}MB ({pct}%)"));
                    }
                }
            }

            // 🔑 Close file handles before extracting the zip
            fs.Close();
            s.Close();

            Log("Node.js download complete, extracting...");
            SetStep(AppStep.NodeDownload, "📦 正在解压 Node.js...", "");

            Directory.CreateDirectory(targetDir);
            ZipFile.ExtractToDirectory(zipPath, targetDir);
            var sub = new DirectoryInfo(targetDir).GetDirectories().FirstOrDefault();
            if (sub != null)
            {
                foreach (var f in sub.GetFiles()) f.MoveTo(Path.Combine(targetDir, f.Name));
                foreach (var d in sub.GetDirectories()) d.MoveTo(Path.Combine(targetDir, d.Name));
                sub.Delete();
            }
            try { File.Delete(zipPath); } catch { }

            Log("Node.js ready");
            BeginInvoke(() => CheckNodeJs()); // re-check (will find portable now)
        }
        catch (Exception ex)
        {
            Log($"Node download error: {ex}");
            BeginInvoke(() => SetStep(AppStep.Error,
                "❌ Node.js 下载失败",
                "请检查网络连接后重试\n也可以手动安装 Node.js (https://nodejs.org)",
                $"{ex.Message}",
                showBrowserBtn: true));
        }
    }

    // ===================================================================
    // Step 3: Chromium
    // ===================================================================

    private void CheckChromium(string baseDir, string nodeExe)
    {
        if (CheckChromiumInstalled())
        {
            LaunchServer(baseDir, nodeExe);
            return;
        }

        SetStep(AppStep.ChromiumDownload, "🌐 正在下载 Chromium...",
            "首次运行需要下载约 300MB\n此过程只需一次\n下载完成后自动启动", "");
        Refresh();
        _ = DownloadChromiumAsync(baseDir, nodeExe);
    }

    private bool CheckChromiumInstalled()
    {
        if (!Directory.Exists(PLAYWRIGHT_DIR)) return false;
        return Directory.GetDirectories(PLAYWRIGHT_DIR, $"chromium-{CHROMIUM_REVISION}*").Length > 0;
    }

    private async Task DownloadChromiumAsync(string baseDir, string nodeExe)
    {
        try
        {
            Directory.CreateDirectory(PLAYWRIGHT_DIR);
            var list = new[] {
                ("chromium", "chromium-" + CHROMIUM_REVISION,
                 "https://cdn.playwright.dev/builds/cft/149.0.7827.55/win64/chrome-win64.zip",
                 "chrome-win64"),
            };

            foreach (var (name, dirName, url, extractFolder) in list)
            {
                string targetDir = Path.Combine(PLAYWRIGHT_DIR, dirName);
                if (Directory.Exists(targetDir)) continue;

                string zipPath = Path.Combine(Path.GetTempPath(), $"{name}.zip");
                long total;

                using (var client = MakeHttpClient(TimeSpan.FromMinutes(30)))
                using (var resp = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead))
                {
                    resp.EnsureSuccessStatusCode();
                    total = resp.Content.Headers.ContentLength ?? 300 * 1024 * 1024;
                    using var s = await resp.Content.ReadAsStreamAsync();
                    using var fs = new FileStream(zipPath, FileMode.Create, FileAccess.Write);
                    var buf = new byte[32768];
                    long read = 0;
                    int n, lastPct = -1;
                    while ((n = await s.ReadAsync(buf, 0, buf.Length)) > 0)
                    {
                        await fs.WriteAsync(buf, 0, n);
                        read += n;
                        if (_closing) return;
                        if (total > 0)
                        {
                            int pct = (int)(read * 100 / total);
                            if (pct != lastPct)
                            {
                                lastPct = pct;
                                BeginInvoke(() => SetStep(AppStep.ChromiumDownload,
                                    "🌐 正在下载 Chromium...",
                                    $"已下载 {read / 1024 / 1024}MB / {total / 1024 / 1024}MB ({pct}%)\n下载完成后自动启动"));
                            }
                        }
                    }
                }

                Log($"Chromium download complete, extracting...");
                BeginInvoke(() => SetStep(AppStep.ChromiumDownload, "📦 正在解压 Chromium...", ""));

                string tmp = Path.Combine(Path.GetTempPath(), "pw-" + name);
                if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
                ZipFile.ExtractToDirectory(zipPath, tmp);
                Directory.Move(Path.Combine(tmp, extractFolder), targetDir);
                try { File.Delete(zipPath); Directory.Delete(tmp, true); } catch { }
            }

            Log("Chromium ready");
            BeginInvoke(() => LaunchServer(baseDir, nodeExe));
        }
        catch (Exception ex)
        {
            Log($"Chromium download error: {ex}");
            BeginInvoke(() => SetStep(AppStep.Error,
                "❌ Chromium 下载失败",
                "请检查网络连接后重试",
                $"{ex.Message}",
                showBrowserBtn: true));
        }
    }

    // ===================================================================
    // Step 4: Launch Node server
    // ===================================================================

    private void LaunchServer(string baseDir, string nodeExe)
    {
        Log("Launching Node server...");
        SetStep(AppStep.Launching, "🚀 正在启动服务...", "");

        try
        {
            string pwDir = Path.Combine(PLAYWRIGHT_DIR, $"chromium-{CHROMIUM_REVISION}", "chrome-win64");
            var env = new Dictionary<string, string> {
                ["PLAYWRIGHT_BROWSERS_PATH"] = PLAYWRIGHT_DIR,
                ["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"] = Path.Combine(pwDir, "chrome.exe"),
                ["NODE_PATH"] = Path.Combine(baseDir, "node_modules"),
            };

            var psi = new ProcessStartInfo
            {
                FileName = nodeExe,
                Arguments = $"\"{Path.Combine(baseDir, "dashboard.js")}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = baseDir,
            };
            foreach (var kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            psi.EnvironmentVariables["PATH"] = baseDir + ";" +
                Path.Combine(baseDir, "node_modules", ".bin") + ";" + pathEnv;

            _serverProcess = new Process { StartInfo = psi };
            _serverProcess.ErrorDataReceived += (_, e) => { if (e.Data != null) Log($"[NODE-ERR] {e.Data}"); };
            _serverProcess.OutputDataReceived += (_, e) => { if (e.Data != null) Log($"[NODE-OUT] {e.Data}"); };
            _serverProcess.Start();
            _serverProcess.BeginOutputReadLine();
            _serverProcess.BeginErrorReadLine();
            Log($"Node PID: {_serverProcess.Id}");

            _ = WaitForServerReady();
        }
        catch (Exception ex)
        {
            Log($"LaunchServer error: {ex}");
            SetStep(AppStep.Error, "❌ 服务启动失败", "", $"{ex.Message}\n点击任意位置重试", showBrowserBtn: true);
        }
    }

    // ===================================================================
    // Step 5: Wait for server → show panel
    // ===================================================================

    private async Task WaitForServerReady()
    {
        Log("Waiting for HTTP 200 on :3456/api/status");
        SetStep(AppStep.ServerReady, "⏳ 等待服务就绪...", "");

        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var sw = Stopwatch.StartNew();

        while (sw.Elapsed < TimeSpan.FromSeconds(60))
        {
            try
            {
                using var r = await httpClient.GetAsync("http://localhost:3456/api/status");
                if (r.IsSuccessStatusCode)
                {
                    Log($"Server ready in {sw.Elapsed.TotalSeconds:F1}s");
                    BeginInvoke(() => ShowPanel());
                    return;
                }
            }
            catch { }

            if (_closing) return;

            string elapsed = sw.Elapsed.TotalSeconds >= 10
                ? $"（已等待 {sw.Elapsed.TotalSeconds:F0} 秒）"
                : "";
            BeginInvoke(() => _detailLabel.Text = $"服务启动中，请稍候 {elapsed}");
            await Task.Delay(500);
        }

        Log("Server timeout (60s)");
        BeginInvoke(() => SetStep(AppStep.Error,
            "⏱️ 服务启动超时（60 秒）",
            "请检查是否有其他程序占用了端口 3456",
            "点击任意位置重试",
            showBrowserBtn: true));
    }

    // ===================================================================
    // Step 6: Show panel (via WebView2 or browser)
    // ===================================================================

    private void ShowPanel()
    {
        if (_panelShown) return;

        SetStep(AppStep.PanelLoading, "✅ 服务已就绪", "正在加载面板...");

        // 🔑 15s 超时兜底——先启动定时器，再初始化 WebView2
        //    这样即使 EnsureCoreWebView2Async 挂起，也能自动隐藏 loading
        _hideTimer?.Dispose();
        _hideTimer = new System.Windows.Forms.Timer();
        _hideTimer.Interval = 15000;
        _hideTimer.Tick += (_, _) =>
        {
            _hideTimer?.Dispose();
            _hideTimer = null;
            // 如果 NavigationCompleted 已经成功了，这里不再操作
            if (_panelShown) return;
            Log("Panel: 15s fallback fired — forcing loading hidden");
            BeginInvoke(() =>
            {
                _panelShown = true;
                HideLoadingPanel();
                _browserBtn.Visible = true;
                _browserBtn.BringToFront();
                _detailLabel.Text = "页面加载可能不完整，可点击「在浏览器中打开」";
            });
        };
        _hideTimer.Start();

        if (_webViewOk)
        {
            Refresh();
            InitializeWebView();
        }
        else
        {
            // WebView2 not available — go straight to browser
            SetStep(AppStep.PanelLoading, "✅ 服务已就绪",
                "由于未检测到 WebView2，请在浏览器中操作",
                showBrowserBtn: true);
            _ = Task.Delay(500).ContinueWith(_ => BeginInvoke(OpenBrowser));
        }
    }

    private async void InitializeWebView()
    {
        try
        {
            // Explicit initialization (not relying on auto-init from Source=)
            await webView.EnsureCoreWebView2Async();

            if (webView.CoreWebView2 == null)
            {
                Log("CoreWebView2 is null after init");
                SetStep(AppStep.PanelLoading, "✅ 服务已就绪",
                    "⚠️ 面板初始化失败，请在浏览器中操作",
                    showBrowserBtn: true);
                OpenBrowser();
                return;
            }

            Log("CoreWebView2 ready, navigating...");

            // Navigate — NavigationCompleted 会处理隐藏 loading
            webView.CoreWebView2.Navigate("http://localhost:3456");
        }
        catch (Exception ex)
        {
            Log($"WebView init error: {ex}");
            SetStep(AppStep.PanelLoading, "✅ 服务已就绪",
                $"⚠️ 面板加载失败: {ex.Message}\n请在浏览器中操作",
                showBrowserBtn: true);
            OpenBrowser();
        }
    }

    // ===================================================================
    // NavigationCompleted handler
    // ===================================================================

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs args)
    {
        Log($"NavigationCompleted: IsSuccess={args.IsSuccess} Code={args.HttpStatusCode} Status={args.WebErrorStatus}");
        if (_closing) return;

        _hideTimer?.Stop();
        _hideTimer?.Dispose();
        _hideTimer = null;

        if (args.IsSuccess && !_panelShown)
        {
            _panelShown = true; // prevent double-fire
            BeginInvoke(HideLoadingPanel);
        }
        else if (!args.IsSuccess)
        {
            Log($"Navigation failed: {args.WebErrorStatus}");
        }
    }

    // ===================================================================
    // Panel visibility
    // ===================================================================

    private void HideLoadingPanel()
    {
        if (InvokeRequired) { BeginInvoke(HideLoadingPanel); return; }

        _loadingPanel.Visible = false;
        _loadingPanel.SendToBack();
        if (_webViewOk)
        {
            webView.BringToFront();
        }
        _browserBtn.Visible = false;
        Log("Loading panel hidden, WebView2 visible");
    }

    // ===================================================================
    // Browser fallback
    // ===================================================================

    private void OpenBrowser()
    {
        try
        {
            Log("Opening default browser to http://localhost:3456");
            Process.Start(new ProcessStartInfo
            {
                FileName = "http://localhost:3456",
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            Log($"Browser open failed: {ex}");
        }
    }

    // ===================================================================
    // Utility
    // ===================================================================

    private static HttpClient MakeHttpClient(TimeSpan timeout)
    {
        // Force TLS 1.2 for older Windows that may default to SSLv3
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        return new HttpClient { Timeout = timeout };
    }

    // ===================================================================
    // App icon
    // ===================================================================

    private void SetAppIcon()
    {
        try
        {
            string p = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app-icon.png");
            if (File.Exists(p))
            {
                using var bmp = new Bitmap(p);
                var h = bmp.GetHicon();
                Icon = Icon.FromHandle(h);
                Disposed += (_, _) => DestroyIcon(h);
            }
        }
        catch { }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr handle);

    // ===================================================================
    // Server lifecycle
    // ===================================================================

    private void KillServer()
    {
        if (_serverProcess != null && !_serverProcess.HasExited)
        {
            try
            {
                int pid = _serverProcess.Id;
                Log($"Killing server PID {pid}");
                Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = $"/F /T /PID {pid}",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                _serverProcess.WaitForExit(3000);
            }
            catch (Exception ex) { Log($"Kill error: {ex}"); }
        }
    }
}
